import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECORD_SCHEMAS, type CloudSyncStatus, type ForceUnit, type IncidentSettings, type LoginCandidate, type RecordKind, type Role, type SyncRecord, type TaskTemplate, type User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { CloudFetch } from '../services/cloud.js';
import type { RelayFetch } from '../services/relay.js';
import { adminCookie } from '../test-helpers.js';

const OWN = 'ars:032510047047';
const KREIS = 'ars:03251';
const NAMES: Record<string, string> = { [OWN]: 'Weyhe', [KREIS]: 'Landkreis Diepholz', 'ars:': 'Deutschland' };

/** Relay im Speicher: Stammdaten mit Revision und Änderungszähler (wie elvis-relay); ELVIS darf nur lesen */
class FakeRelay {
  records = new Map<string, SyncRecord>();
  seq = 0;
  files = new Map<string, Buffer>();
  /** Schreibende Aufrufe von ELVIS (darf es nicht mehr geben) */
  writes: string[] = [];
  linked = true;

  put(kind: RecordKind, nodeId: string, data: unknown, uid: string = randomUUID()): SyncRecord {
    const prev = this.records.get(uid);
    const rec: SyncRecord = { uid, kind, nodeId, nodeName: NAMES[nodeId]!, rev: (prev?.rev ?? 0) + 1, deleted: false, data: RECORD_SCHEMAS[kind].parse(data) as never, updatedAt: new Date().toISOString(), updatedBy: 'Portal', seq: ++this.seq };
    this.records.set(uid, rec);
    return rec;
  }

  remove(uid: string): void {
    const prev = this.records.get(uid)!;
    this.records.set(uid, { ...prev, rev: prev.rev + 1, deleted: true, data: null, seq: ++this.seq });
  }

  fetch: CloudFetch = async (url, { method }) => {
    const u = new URL(url);
    if (u.pathname === '/v1/elws/me/cloud' && method === 'GET')
      return { status: 200, body: JSON.stringify(this.linked ? { state: 'linked', node: { id: OWN, name: 'Weyhe', path: ['Weyhe'] }, linkedAt: '2026-11-05T10:00:00Z', linkedBy: 'a@b.de' } : { state: 'none' }) };
    if (u.pathname === '/v1/elws/me/cloud' && method === 'DELETE') return { status: 204, body: '' };
    if (u.pathname === '/v1/elws/me/cloud/link') return { status: 201, body: JSON.stringify({ state: 'pending', code: 'ABCDEFGH', expiresAt: '2030-01-01T00:00:00Z' }) };
    if (method !== 'GET') {
      this.writes.push(`${method} ${u.pathname}`);
      return { status: 405, body: '{"error":"Nicht erlaubt"}' };
    }
    const file = /^\/v1\/elws\/me\/cloud\/files\/(.+)$/.exec(u.pathname);
    if (file) return this.files.has(file[1]!) ? { status: 200, body: this.files.get(file[1]!)! } : { status: 404, body: '{"error":"Datei nicht gefunden"}' };
    if (u.pathname !== '/v1/elws/me/cloud/sync') return { status: 404, body: '{}' };
    const after = Number(u.searchParams.get('after'));
    const items = [...this.records.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq);
    return { status: 200, body: JSON.stringify({ items, next: items.at(-1)?.seq ?? Math.max(after, this.seq), more: false, nodeId: OWN }) };
  };
}

let app: App;
let dataDir: string;
let admin = '';
let relay: FakeRelay;
const relayFetch: RelayFetch = async (url) => (url.endsWith('/v1/elws') ? { status: 201, body: { elwId: 'e1', token: 'tok' } } : { status: 404, body: null });

beforeEach(async () => {
  relay = new FakeRelay();
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-cloudsync-'));
  app = await buildApp(parseConfig({ dataDir, app: { relayUrl: 'https://relay.test' } }), { logger: false, relayFetch, cloudFetch: relay.fetch });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function req<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
}

/** Verknüpfen (Code anfordern, Relay meldet „verknüpft“) – danach holt ELVIS von selbst ab */
async function link() {
  await req('POST', '/api/system/cloud/link', { name: 'ELW 1 Weyhe' });
  await req('GET', '/api/system/cloud?refresh=1');
  return run();
}

const run = () => req<CloudSyncStatus>('POST', '/api/system/cloud/sync/run');
const forces = async () => (await req<ForceUnit[]>('GET', '/api/forces')).body;
const byName = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => a.name.localeCompare(b.name) || Number(!!(a as { cloud?: unknown }).cloud) - Number(!!(b as { cloud?: unknown }).cloud));

describe('Stammdaten aus der Cloud', () => {
  it('holt ab und zeigt „Quelle: Cloud“ (nur lesbar); lokale bleiben lokal und gehen nicht in die Cloud', async () => {
    // Lokal vorhanden
    await req('POST', '/api/system/roles', { name: 'Einsatzleiter', description: '' });
    const elw = (await req<ForceUnit>('POST', '/api/system/forces', { name: 'ELW 1', callsign: 'Florian Weyhe 11-1' })).body;
    await req('PUT', '/api/system/incident', { keywords: ['TH 1'] });
    // In der Cloud: vom Kreis und vom eigenen Bereich (auch der ist hier nur lesbar)
    relay.put('role', KREIS, { name: 'Einsatzleiter', description: 'Gesamtverantwortung', sort: 0 });
    relay.put('role', KREIS, { name: 'Fernmelder', sort: 1 });
    const rtw = relay.put('force', KREIS, { name: 'RTW Diepholz', callsign: 'Rotkreuz Diepholz 83-1', strength: { leaders: 0, subLeaders: 1, crew: 1 } });
    relay.put('force', KREIS, { name: 'Zug Kreis', members: [{ uid: rtw.uid, role: 'Sanität' }] });
    relay.put('force', OWN, { name: 'ELW 1', callsign: 'Florian Weyhe 11-1' });
    relay.put('keyword', KREIS, { name: 'B 2', sort: 0 });

    const status = await link();
    expect(status.body).toMatchObject({ active: true, lastError: null });
    expect(relay.writes).toEqual([]);

    // Rollen haben eindeutige Namen: die lokale bleibt, die aus der Cloud steht als Hinweis da
    const roles = (await req<Role[]>('GET', '/api/roles')).body;
    expect(roles.map((r) => [r.name, r.cloud?.name ?? null])).toEqual([
      ['Einsatzleiter', null],
      ['Fernmelder', 'Landkreis Diepholz'],
    ]);
    expect(status.body.notices).toMatchObject([{ kind: 'role', name: 'Einsatzleiter', reason: expect.stringContaining('gibt es hier schon') }]);
    expect((await req('PUT', `/api/system/roles/${roles[1]!.id}`, { name: 'FM', description: '' })).status).toBe(409);
    expect(status.body.counts.role).toEqual({ cloud: 1, local: 1 });

    // Kräfte: gleichnamige stehen nebeneinander, Untereinheiten aufgelöst; aus der Cloud nur lesbar, auch vom eigenen Bereich
    const list = byName(await forces());
    expect(list.map((f) => [f.name, f.cloud?.name ?? null])).toEqual([
      ['ELW 1', null],
      ['ELW 1', 'Weyhe'],
      ['RTW Diepholz', 'Landkreis Diepholz'],
      ['Zug Kreis', 'Landkreis Diepholz'],
    ]);
    const zug = list.find((f) => f.name === 'Zug Kreis')!;
    expect(zug.members).toEqual([{ unitId: list.find((f) => f.name === 'RTW Diepholz')!.id, role: 'Sanität' }]);
    expect((await req('PUT', `/api/system/forces/${zug.id}`, { name: 'x' })).status).toBe(409);
    expect((await req('PUT', `/api/system/forces/${list[1]!.id}`, { name: 'x' })).status).toBe(409);
    expect((await req('DELETE', `/api/system/forces/${list[1]!.id}`)).status).toBe(409);
    // Lokale bleiben änderbar und gehen nicht raus
    expect((await req('PUT', `/api/system/forces/${elw.id}`, { name: 'ELW 1 lokal', callsign: 'Florian Weyhe 11-1' })).status).toBe(200);

    // Stichworte: aus der Cloud nur lesbar, die lokalen bleiben änderbar
    const kw = (await req<IncidentSettings>('GET', '/api/incidents/settings')).body;
    expect(kw.keywords).toEqual(['B 2', 'TH 1']);
    expect(kw.managed).toEqual([{ name: 'B 2', origin: 'Landkreis Diepholz' }]);
    await req('PUT', '/api/system/incident', { keywords: [] });
    expect((await req<IncidentSettings>('GET', '/api/incidents/settings')).body.keywords).toEqual(['B 2']);

    // Kreis löscht den RTW: verschwindet hier, auch aus dem Zug
    relay.remove(rtw.uid);
    await run();
    expect(byName(await forces()).map((f) => f.name)).toEqual(['ELW 1', 'ELW 1 lokal', 'Zug Kreis']);
    expect((await forces()).find((f) => f.name === 'Zug Kreis')!.members).toEqual([]);

    // Lokale Rolle entfernt, neu abgeholt: jetzt kommt die aus der Cloud
    await req('DELETE', `/api/system/roles/${roles[0]!.id}`);
    const again = await req<CloudSyncStatus>('POST', '/api/system/cloud/sync/resync');
    expect(again.body.notices).toEqual([]);
    expect((await req<Role[]>('GET', '/api/roles')).body.map((r) => [r.name, r.cloud?.name ?? null])).toEqual([
      ['Einsatzleiter', 'Landkreis Diepholz'],
      ['Fernmelder', 'Landkreis Diepholz'],
    ]);
    expect(relay.writes).toEqual([]);
  });

  it('Benutzer aus der Cloud brauchen erst eine PIN; der letzte Admin bleibt', async () => {
    await link();
    const anna = relay.put('user', KREIS, { firstName: 'Anna', lastName: 'Kreis', isAdmin: true });
    await run();
    const users = (await req<User[]>('GET', '/api/users')).body;
    const a = users.find((u) => u.firstName === 'Anna')!;
    expect(a).toMatchObject({ pinMissing: true, isAdmin: true, cloud: { name: 'Landkreis Diepholz' } });
    expect(users.find((u) => u.firstName === 'Max')!.cloud).toBeNull();
    expect((await req<LoginCandidate[]>('GET', '/api/auth/candidates', undefined, '')).body.map((c) => c.firstName)).toEqual(['Max']);
    // Name ist Sache der Cloud, die PIN setzt der Admin hier
    expect((await req('PATCH', `/api/users/${a.id}`, { firstName: 'Anne' })).status).toBe(409);
    expect((await req('PATCH', `/api/users/${a.id}`, { pin: '2468' })).status).toBe(200);
    expect((await req<LoginCandidate[]>('GET', '/api/auth/candidates', undefined, '')).body.map((c) => c.firstName)).toEqual(['Anna', 'Max']);

    // Anna in der Cloud gelöscht → verschwindet, Max bleibt Admin
    relay.remove(anna.uid);
    await run();
    expect((await req<User[]>('GET', '/api/users')).body.map((u) => u.firstName)).toEqual(['Max']);
    expect(relay.writes).toEqual([]);
  });

  it('getrennt (hier oder im Portal): Cloud-Daten bleiben als lokale und sind änderbar', async () => {
    relay.put('force', KREIS, { name: 'RTW Diepholz' });
    await link();
    expect((await forces())[0]!.cloud).toMatchObject({ name: 'Landkreis Diepholz' });
    await req('DELETE', '/api/system/cloud');
    const [rtw] = await forces();
    expect(rtw!.cloud).toBeNull();
    expect((await req('PUT', `/api/system/forces/${rtw!.id}`, { name: 'RTW (lokal)' })).status).toBe(200);
    expect((await req<CloudSyncStatus>('GET', '/api/system/cloud/sync')).body).toMatchObject({ active: false, counts: { force: { cloud: 0, local: 1 } } });

    // Erneut verknüpft: der lokale bleibt, der aus der Cloud kommt dazu
    await link();
    expect(byName(await forces()).map((f) => [f.name, f.cloud?.name ?? null])).toEqual([
      ['RTW (lokal)', null],
      ['RTW Diepholz', 'Landkreis Diepholz'],
    ]);

    // Im Portal getrennt
    relay.linked = false;
    await req('GET', '/api/system/cloud?refresh=1');
    expect((await forces()).every((f) => f.cloud === null)).toBe(true);
  });

  it('Aufgabenvorlagen verweisen über die uid auf Rollen', async () => {
    await link();
    const role = relay.put('role', KREIS, { name: 'Fernmelder', sort: 0 });
    relay.put('taskTemplate', KREIS, { summary: 'Lagemeldung', roleUid: role.uid, offsetMinutes: 30, intervalMinutes: 60 });
    await run();
    const [t] = (await req<TaskTemplate[]>('GET', '/api/system/task-templates')).body;
    expect(t).toMatchObject({ summary: 'Lagemeldung', roleName: 'Fernmelder', schedule: { kind: 'interval', intervalMinutes: 60, offsetMinutes: 30 }, cloud: { name: 'Landkreis Diepholz' } });
    expect((await req('DELETE', `/api/system/task-templates/${t!.id}`)).status).toBe(409);
  });
});

describe('Objektbibliothek aus der Cloud', () => {
  const WATER = '00000000-0000-4000-8000-000000000001';
  const SITE = '00000000-0000-4000-8000-000000000002';
  type LibObj = { id: number; name: string; source: string | null; cloud?: { name: string } | null; files: { id: number; filename: string }[] };

  async function uploadFile(objectId: number, name: string, data: string) {
    const boundary = '----elvis' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(data),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.server.inject({ method: 'POST', url: `/api/library/objects/${objectId}/files`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: admin } });
  }

  it('holt Typen, Objekte und Dateien ab; lokale Objekte bleiben lokal', async () => {
    const types = (await req<{ id: number; builtin: string | null }[]>('GET', '/api/library/types')).body;
    const water = types.find((t) => t.builtin === 'water')!.id;
    const site = types.find((t) => t.builtin === 'site')!.id;
    // Lokal: Einsatzobjekt mit Plan
    const klinik = (await req<LibObj>('POST', '/api/library/objects', { typeId: site, name: 'Klinikum', lat: 52.95, lon: 8.85 })).body;
    expect((await uploadFile(klinik.id, 'Plan.pdf', '%PDF lokal')).statusCode).toBe(201);

    // Cloud: vordefinierte Typen an der Wurzel, Kreis-Hydrant mit Datei
    relay.put('objectType', 'ars:', { name: 'Wasserentnahmestelle', icon: 'Droplet', color: '#2563eb', builtin: 'water', fields: [{ key: 'dn', label: 'DN', type: 'number', badge: true }] }, WATER);
    relay.put('objectType', 'ars:', { name: 'Einsatzobjekt', icon: 'Building2', color: '#dc2626', builtin: 'site' }, SITE);
    const h = relay.put('object', KREIS, { typeUid: WATER, name: 'H Kreisstraße', lat: 52.91, lon: 8.81, props: { dn: 100 } });
    const content = Buffer.from('%PDF Kreis');
    const fileUid = randomUUID();
    relay.files.set(fileUid, content);
    relay.put('objectFile', KREIS, { objectUid: h.uid, filename: 'Hydrantenplan.pdf', mimeType: 'application/pdf', sizeBytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }, fileUid);

    expect((await link()).body.lastError).toBeNull();

    // Vordefinierte Typen: nicht doppelt, jetzt aus der Cloud
    const after = (await req<{ id: number; builtin: string | null; cloud?: { name: string } | null }[]>('GET', '/api/library/types')).body;
    expect(after.filter((t) => t.builtin).map((t) => [t.id, t.cloud?.name]).sort()).toEqual(
      [
        [water, 'Deutschland'],
        [site, 'Deutschland'],
      ].sort(),
    );

    const objects = (await req<LibObj[]>('GET', '/api/library/objects')).body;
    expect(objects.map((o) => [o.name, o.cloud?.name ?? null])).toEqual([
      ['H Kreisstraße', 'Landkreis Diepholz'],
      ['Klinikum', null],
    ]);
    // Datei aus der Cloud ist da
    const hk = (await req<LibObj>('GET', `/api/library/objects/${objects[0]!.id}`)).body;
    expect(hk.files.map((f) => f.filename)).toEqual(['Hydrantenplan.pdf']);
    expect((await app.server.inject({ method: 'GET', url: `/api/library/files/${hk.files[0]!.id}/content` })).body).toBe('%PDF Kreis');
    // Aus der Cloud: hier nur lesbar, auch keine Dateien
    expect((await req('PUT', `/api/library/objects/${hk.id}`, { typeId: water, name: 'x', lat: 1, lon: 1 })).status).toBe(409);
    expect((await uploadFile(hk.id, 'x.pdf', 'x')).statusCode).toBe(409);
    // Lokal: neues Objekt mit einem Typ aus der Cloud geht, nichts davon geht hoch
    expect((await req('POST', '/api/library/objects', { typeId: water, name: 'H lokal', lat: 52.9, lon: 8.8 })).status).toBe(201);
    await run();
    expect(relay.writes).toEqual([]);

    // Kreis löscht seinen Hydranten: Objekt und Datei verschwinden
    relay.remove(h.uid);
    relay.remove(fileUid);
    await run();
    expect((await req<LibObj[]>('GET', '/api/library/objects')).body.map((o) => o.name)).toEqual(['H lokal', 'Klinikum']);
  });

  it('gleiche Herkunft (OSM-Import) lokal und aus der Cloud: beide stehen nebeneinander, auch nach dem Trennen', async () => {
    // Lokal aus OSM importiert
    const local = new Database(join(dataDir, 'elvis.sqlite'));
    const waterId = (local.prepare("SELECT id FROM object_types WHERE builtin = 'water'").get() as { id: number }).id;
    local
      .prepare("INSERT INTO library_objects (uid, type_id, name, lat, lon, source, updated_at, updated_by) VALUES (?, ?, 'H OSM lokal', 52.9, 8.8, 'osm:1', '2026-11-05T10:00:00Z', 'Test')")
      .run(randomUUID(), waterId);
    local.close();
    // Dasselbe aus der Cloud, zweimal (Kreis und Gemeinde haben beide importiert)
    relay.put('objectType', 'ars:', { name: 'Wasserentnahmestelle', icon: 'Droplet', color: '#2563eb', builtin: 'water' }, WATER);
    relay.put('object', KREIS, { typeUid: WATER, name: 'H OSM Kreis', lat: 52.9, lon: 8.8, source: 'osm:1' });
    relay.put('object', OWN, { typeUid: WATER, name: 'H OSM Weyhe', lat: 52.9, lon: 8.8, source: 'osm:1' });

    expect((await link()).body).toMatchObject({ lastError: null, notices: [] });
    const objects = async () => (await req<LibObj[]>('GET', '/api/library/objects')).body.map((o) => [o.name, o.source, o.cloud?.name ?? null]);
    expect(await objects()).toEqual([
      ['H OSM Kreis', 'osm:1', 'Landkreis Diepholz'],
      ['H OSM lokal', 'osm:1', null],
      ['H OSM Weyhe', 'osm:1', 'Weyhe'],
    ]);

    // Getrennt: alle lokal, die Herkunft bleibt beim bisherigen lokalen
    expect((await req('DELETE', '/api/system/cloud')).status).toBe(200);
    expect(await objects()).toEqual([
      ['H OSM Kreis', null, null],
      ['H OSM lokal', 'osm:1', null],
      ['H OSM Weyhe', null, null],
    ]);
  });
});
