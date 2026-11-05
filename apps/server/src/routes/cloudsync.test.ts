import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECORD_SCHEMAS, type CloudSyncStatus, type ForceUnit, type IncidentSettings, type LoginCandidate, type RecordKind, type Role, type SyncChange, type SyncRecord, type SyncResult, type TaskTemplate, type User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { CloudFetch } from '../services/cloud.js';
import type { RelayFetch } from '../services/relay.js';
import { adminCookie } from '../test-helpers.js';

const OWN = 'ars:032510047047';
const KREIS = 'ars:03251';
const NAMES: Record<string, string> = { [OWN]: 'Weyhe', [KREIS]: 'Landkreis Diepholz', 'ars:': 'Deutschland' };

/** Relay im Speicher: Stammdaten mit Revision und Änderungszähler, Schreiben nur am eigenen Knoten (wie elvis-relay) */
class FakeRelay {
  records = new Map<string, SyncRecord>();
  seq = 0;
  pushes: SyncChange[][] = [];
  files = new Map<string, Buffer>();

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

  fetch: CloudFetch = async (url, { method, body: rawBody }) => {
    const body = rawBody === undefined ? undefined : rawBody.toString();
    const u = new URL(url);
    if (u.pathname === '/v1/elws/me/cloud') return { status: 200, body: JSON.stringify({ state: 'linked', node: { id: OWN, name: 'Weyhe', path: ['Weyhe'] }, linkedAt: '2026-11-05T10:00:00Z', linkedBy: 'a@b.de' }) };
    if (u.pathname === '/v1/elws/me/cloud/link') return { status: 201, body: JSON.stringify({ state: 'pending', code: 'ABCDEFGH', expiresAt: '2030-01-01T00:00:00Z' }) };
    const file = /^\/v1\/elws\/me\/cloud\/files\/(.+)$/.exec(u.pathname);
    if (file && method === 'PUT') {
      if (this.files.has(file[1]!)) return { status: 409, body: '{"error":"Datei gibt es schon"}' };
      this.files.set(file[1]!, Buffer.from(rawBody as Buffer));
      return { status: 201, body: '{}' };
    }
    if (file) return this.files.has(file[1]!) ? { status: 200, body: this.files.get(file[1]!)! } : { status: 404, body: '{"error":"Datei nicht gefunden"}' };
    if (u.pathname !== '/v1/elws/me/cloud/sync') return { status: 404, body: '{}' };
    if (method === 'GET') {
      const after = Number(u.searchParams.get('after'));
      const items = [...this.records.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq);
      return { status: 200, body: JSON.stringify({ items, next: items.at(-1)?.seq ?? Math.max(after, this.seq), more: false, nodeId: OWN }) };
    }
    const { changes } = JSON.parse(body!) as { changes: SyncChange[] };
    this.pushes.push(changes);
    const results: SyncResult[] = changes.map((c) => {
      const cur = this.records.get(c.uid);
      if (cur && cur.nodeId !== OWN) return { uid: c.uid, status: 'conflict', record: cur, reason: 'Gepflegt von einem anderen Knoten' };
      if ((cur?.rev ?? 0) !== c.baseRev) return { uid: c.uid, status: 'conflict', record: cur ?? null, reason: 'In der Cloud zwischenzeitlich geändert' };
      if (c.deleted) {
        this.remove(c.uid);
        return { uid: c.uid, status: 'ok', record: this.records.get(c.uid)! };
      }
      return { uid: c.uid, status: 'ok', record: this.put(c.kind, OWN, c.data, c.uid) };
    });
    return { status: 200, body: JSON.stringify({ results }) };
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

/** Verknüpfen (Code anfordern, Relay meldet „verknüpft“) und Abgleich starten */
async function link() {
  await req('POST', '/api/system/cloud/link', { name: 'ELW 1 Weyhe' });
  await req('GET', '/api/system/cloud?refresh=1');
  return req<CloudSyncStatus>('POST', '/api/system/cloud/sync/enable');
}

const run = () => req<CloudSyncStatus>('POST', '/api/system/cloud/sync/run');
const forces = async () => (await req<ForceUnit[]>('GET', '/api/forces')).body;

describe('Stammdaten-Abgleich', () => {
  it('übernimmt Cloud-Daten, vermeidet Doppelte und sendet die eigenen', async () => {
    // Lokal vorhanden
    await req('POST', '/api/system/roles', { name: 'Einsatzleiter', description: '' });
    const elw = (await req<ForceUnit>('POST', '/api/system/forces', { name: 'ELW 1', callsign: 'Florian Weyhe 11-1' })).body;
    await req('PUT', '/api/system/incident', { keywords: ['TH 1'] });
    // In der Cloud vom Kreis
    relay.put('role', KREIS, { name: 'Einsatzleiter', description: 'Gesamtverantwortung', sort: 0 });
    const rtw = relay.put('force', KREIS, { name: 'RTW Diepholz', callsign: 'Rotkreuz Diepholz 83-1', strength: { leaders: 0, subLeaders: 1, crew: 1 } });
    relay.put('force', KREIS, { name: 'Zug Kreis', members: [{ uid: rtw.uid, role: 'Sanität' }] });
    relay.put('keyword', KREIS, { name: 'B 2', sort: 0 });

    const status = await link();
    expect(status.body).toMatchObject({ enabled: true, lastError: null });

    // Rolle übernommen statt doppelt, jetzt vom Kreis und hier nur lesbar
    const roles = (await req<Role[]>('GET', '/api/roles')).body;
    expect(roles).toMatchObject([{ name: 'Einsatzleiter', description: 'Gesamtverantwortung', cloud: { node: KREIS, name: 'Landkreis Diepholz', editable: false } }]);
    expect((await req('PUT', `/api/system/roles/${roles[0]!.id}`, { name: 'EL', description: '' })).status).toBe(409);

    // Kräfte: eigene + vom Kreis, Untereinheiten aufgelöst
    const list = await forces();
    expect(list.map((f) => [f.name, f.cloud?.name ?? null, f.cloud?.editable ?? null])).toEqual([
      ['ELW 1', 'Weyhe', true],
      ['RTW Diepholz', 'Landkreis Diepholz', false],
      ['Zug Kreis', 'Landkreis Diepholz', false],
    ]);
    const zug = list.find((f) => f.name === 'Zug Kreis')!;
    expect(zug.members).toEqual([{ unitId: list.find((f) => f.name === 'RTW Diepholz')!.id, role: 'Sanität' }]);
    expect((await req('PUT', `/api/system/forces/${zug.id}`, { name: 'x' })).status).toBe(409);

    // Stichworte: Kreis zuerst, nur lesbar; die eigenen bleiben änderbar
    const kw = (await req<IncidentSettings>('GET', '/api/incidents/settings')).body;
    expect(kw.keywords).toEqual(['B 2', 'TH 1']);
    expect(kw.managed).toEqual([{ name: 'B 2', origin: 'Landkreis Diepholz' }]);

    // Gesendet: eigene Einheit, Stichwort, Admin (ohne PIN), nicht die übernommene Rolle
    const sent = relay.pushes.flat();
    expect(sent.map((c) => [c.kind, (c.data as { name?: string; firstName?: string }).name ?? (c.data as { firstName?: string }).firstName])).toEqual([
      ['keyword', 'TH 1'],
      ['user', 'Max'],
      ['force', 'ELW 1'],
    ]);
    expect(JSON.stringify(sent)).not.toContain('scrypt');

    // Eigene Änderung geht mit der bekannten Revision raus
    relay.pushes = [];
    const upd = await req('PUT', `/api/system/forces/${elw.id}`, { name: 'ELW 1 Weyhe', callsign: 'Florian Weyhe 11-1' });
    expect(upd).toMatchObject({ status: 200 });
    await run();
    expect(relay.pushes.flat()).toMatchObject([{ kind: 'force', baseRev: 1, data: { name: 'ELW 1 Weyhe' } }]);
    await run();
    expect(relay.pushes).toHaveLength(1); // nichts mehr offen

    // Kreis löscht den RTW: verschwindet hier, auch aus dem Zug
    relay.remove(rtw.uid);
    await run();
    expect((await forces()).map((f) => f.name)).toEqual(['ELW 1 Weyhe', 'Zug Kreis']);

    // Lokal gelöscht → Tombstone
    relay.pushes = [];
    await req('PUT', '/api/system/incident', { keywords: [] });
    await run();
    expect(relay.pushes.flat()).toMatchObject([{ kind: 'keyword', deleted: true }]);
    expect((await req<IncidentSettings>('GET', '/api/incidents/settings')).body.keywords).toEqual(['B 2']);
  });

  it('Benutzer aus der Cloud brauchen erst eine PIN; der letzte Admin bleibt', async () => {
    await link();
    const anna = relay.put('user', KREIS, { firstName: 'Anna', lastName: 'Kreis', isAdmin: true });
    await run();
    const users = (await req<User[]>('GET', '/api/users')).body;
    const a = users.find((u) => u.firstName === 'Anna')!;
    expect(a).toMatchObject({ pinMissing: true, isAdmin: true, cloud: { name: 'Landkreis Diepholz', editable: false } });
    expect((await req<LoginCandidate[]>('GET', '/api/auth/candidates', undefined, '')).body.map((c) => c.firstName)).toEqual(['Max']);
    // Name ist Sache der Cloud, die PIN setzt der Admin hier
    expect((await req('PATCH', `/api/users/${a.id}`, { firstName: 'Anne' })).status).toBe(409);
    expect((await req('PATCH', `/api/users/${a.id}`, { pin: '2468' })).status).toBe(200);
    expect((await req<LoginCandidate[]>('GET', '/api/auth/candidates', undefined, '')).body.map((c) => c.firstName)).toEqual(['Anna', 'Max']);

    // Max ist (mit Anna) nicht mehr letzter Admin; Anna gelöscht → Max bleibt Admin
    relay.remove(anna.uid);
    await run();
    expect((await req<User[]>('GET', '/api/users')).body.map((u) => u.firstName)).toEqual(['Max']);
  });

  it('bei Konflikten gewinnt die Cloud und es steht im Protokoll', async () => {
    const elw = (await req<ForceUnit>('POST', '/api/system/forces', { name: 'ELW 1' })).body;
    await link();
    const uid = relay.pushes.flat().find((c) => c.kind === 'force')!.uid;
    // Im Portal geändert, gleichzeitig lokal
    relay.put('force', OWN, { name: 'ELW 1 (Portal)' }, uid);
    await req('PUT', `/api/system/forces/${elw.id}`, { name: 'ELW 1 (lokal)' });
    const s = await run();
    expect((await forces()).map((f) => f.name)).toEqual(['ELW 1 (Portal)']);
    expect(s.body.conflicts).toMatchObject([{ kind: 'force', name: 'ELW 1 (lokal)', reason: expect.stringContaining('Stand der Cloud übernommen') }]);
    const audit = await app.server.inject({ method: 'GET', url: '/api/audit?limit=20', headers: { cookie: admin } });
    expect(audit.body).toContain('ELW 1 (lokal)');

    // Trennen: alles bleibt lokal, ohne Herkunft
    await req('DELETE', '/api/system/cloud');
    expect((await forces())[0]!.cloud).toBeNull();
    expect((await req<CloudSyncStatus>('GET', '/api/system/cloud/sync')).body.enabled).toBe(false);
  });

  it('Aufgabenvorlagen verweisen über die uid auf Rollen', async () => {
    await link();
    const role = relay.put('role', KREIS, { name: 'Fernmelder', sort: 0 });
    relay.put('taskTemplate', KREIS, { summary: 'Lagemeldung', roleUid: role.uid, offsetMinutes: 30, intervalMinutes: 60 });
    await run();
    const [t] = (await req<TaskTemplate[]>('GET', '/api/system/task-templates')).body;
    expect(t).toMatchObject({ summary: 'Lagemeldung', roleName: 'Fernmelder', schedule: { kind: 'interval', intervalMinutes: 60, offsetMinutes: 30 }, cloud: { editable: false } });
    expect((await req('DELETE', `/api/system/task-templates/${t!.id}`)).status).toBe(409);
  });
});

describe('Objektbibliothek im Abgleich', () => {
  const WATER = '00000000-0000-4000-8000-000000000001';
  const SITE = '00000000-0000-4000-8000-000000000002';
  type LibObj = { id: number; name: string; source: string | null; cloud?: { name: string; editable: boolean } | null; files: { id: number; filename: string }[] };

  async function uploadFile(objectId: number, name: string, data: string) {
    const boundary = '----elvis' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(data),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.server.inject({ method: 'POST', url: `/api/library/objects/${objectId}/files`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: admin } });
  }

  it('gleicht Typen, Objekte und Dateien in beide Richtungen ab', async () => {
    const types = (await req<{ id: number; builtin: string | null }[]>('GET', '/api/library/types')).body;
    const water = types.find((t) => t.builtin === 'water')!.id;
    const site = types.find((t) => t.builtin === 'site')!.id;
    // Lokal: Einsatzobjekt mit Plan, Hydrant aus OSM
    const klinik = (await req<LibObj>('POST', '/api/library/objects', { typeId: site, name: 'Klinikum', lat: 52.95, lon: 8.85 })).body;
    expect((await uploadFile(klinik.id, 'Plan.pdf', '%PDF lokal')).statusCode).toBe(201);
    await app.server.inject({ method: 'POST', url: '/api/library/objects', payload: { typeId: water, name: 'H OSM', lat: 52.9, lon: 8.8 }, headers: { cookie: admin } });
    const db = (app as unknown as { db?: unknown }).db;
    void db;

    // Cloud: vordefinierte Typen an der Wurzel, Kreis-Hydrant mit Datei, und derselbe OSM-Hydrant
    relay.put('objectType', 'ars:', { name: 'Wasserentnahmestelle', icon: 'Droplet', color: '#2563eb', builtin: 'water', fields: [{ key: 'dn', label: 'DN', type: 'number', badge: true }] }, WATER);
    relay.put('objectType', 'ars:', { name: 'Einsatzobjekt', icon: 'Building2', color: '#dc2626', builtin: 'site' }, SITE);
    const h = relay.put('object', KREIS, { typeUid: WATER, name: 'H Kreisstraße', lat: 52.91, lon: 8.81, props: { dn: 100 } });
    const content = Buffer.from('%PDF Kreis');
    const fileUid = randomUUID();
    relay.files.set(fileUid, content);
    relay.put('objectFile', KREIS, { objectUid: h.uid, filename: 'Hydrantenplan.pdf', mimeType: 'application/pdf', sizeBytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }, fileUid);

    expect((await link()).body.lastError).toBeNull();

    const objects = (await req<LibObj[]>('GET', '/api/library/objects')).body;
    expect(objects.map((o) => [o.name, o.cloud?.name ?? null, o.cloud?.editable ?? null])).toEqual([
      ['H Kreisstraße', 'Landkreis Diepholz', false],
      ['H OSM', 'Weyhe', true],
      ['Klinikum', 'Weyhe', true],
    ]);
    // Datei aus der Cloud ist da
    const hk = (await req<LibObj>('GET', `/api/library/objects/${objects[0]!.id}`)).body;
    expect(hk.files.map((f) => f.filename)).toEqual(['Hydrantenplan.pdf']);
    expect((await app.server.inject({ method: 'GET', url: `/api/library/files/${hk.files[0]!.id}/content` })).body).toBe('%PDF Kreis');
    // Fremdes Objekt: hier nur lesbar, auch keine Dateien
    expect((await req('PUT', `/api/library/objects/${hk.id}`, { typeId: water, name: 'x', lat: 1, lon: 1 })).status).toBe(409);
    expect((await uploadFile(hk.id, 'x.pdf', 'x')).statusCode).toBe(409);
    // Eigene Datei: erst hochgeladen, dann der Datensatz
    const sent = relay.pushes.flat();
    const fileChange = sent.find((c) => c.kind === 'objectFile')!;
    expect(relay.files.get(fileChange.uid)?.toString()).toBe('%PDF lokal');
    expect(sent.filter((c) => c.kind === 'objectType')).toEqual([]); // vordefinierte gehören der Wurzel

    // Kreis löscht seinen Hydranten: Objekt und Datei verschwinden
    relay.remove(h.uid);
    relay.remove(fileUid);
    await run();
    expect((await req<LibObj[]>('GET', '/api/library/objects')).body.map((o) => o.name)).toEqual(['H OSM', 'Klinikum']);

    // Lokal gelöscht → Tombstone in der Cloud
    relay.pushes = [];
    await req('DELETE', `/api/library/objects/${klinik.id}`);
    await run();
    expect(relay.pushes.flat().map((c) => [c.kind, c.deleted])).toEqual(
      expect.arrayContaining([
        ['object', true],
        ['objectFile', true],
      ]),
    );
  });
});
