import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ForceUnit, ForceUnitInput, Incident, JournalEntry, Unit, User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

async function userCookie(): Promise<string> {
  const user = (await req<User>('POST', '/api/users', { firstName: 'Anna', lastName: 'Test', pin: '1111' })).body;
  const res = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
  return sessionCookie(res.headers['set-cookie']);
}

const force = async (input: ForceUnitInput) => (await req<ForceUnit>('POST', '/api/system/forces', input)).body;
const strength = (crew: number) => ({ leaders: 0, subLeaders: 1, crew });

/** Löschzug aus ELW 1 (Führungsfahrzeug), HLF und LF; das HLF steckt zusätzlich im Gefahrgutzug */
async function catalog() {
  const elw = await force({ name: 'ELW 1', strength: { leaders: 1, subLeaders: 0, crew: 2 } });
  const hlf = await force({ name: 'HLF 20', strength: strength(8) });
  const lf = await force({ name: 'LF 10', strength: strength(5) });
  const zug = await force({
    name: 'Löschzug Mitte',
    sign: { base: 'unit', size: 'zug' },
    members: [
      { unitId: elw.id, role: 'Führungsfahrzeug' },
      { unitId: hlf.id, role: '' },
      { unitId: lf.id, role: '' },
    ],
  });
  const gg = await force({ name: 'Gefahrgutzug', members: [{ unitId: hlf.id, role: 'Erstangriff' }] });
  return { elw, hlf, lf, zug, gg };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-forces-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Kräfteverwaltung', () => {
  it('pflegen nur Admins, lesen alle Angemeldeten', async () => {
    const { zug, hlf, gg } = await catalog();
    const user = await userCookie();
    expect((await req('POST', '/api/system/forces', { name: 'X' }, user)).status).toBe(403);
    const list = (await req<ForceUnit[]>('GET', '/api/forces', undefined, user)).body;
    expect(list.find((u) => u.id === zug.id)!.members.map((m) => m.role)).toEqual(['Führungsfahrzeug', '', '']);
    // Dasselbe Fahrzeug in zwei Einheiten
    expect(list.filter((u) => u.members.some((m) => m.unitId === hlf.id)).map((u) => u.id).sort()).toEqual([zug.id, gg.id].sort());
    expect(list.find((u) => u.id === zug.id)!.sign.size).toBe('zug');
  });

  it('lehnt Zyklen ab', async () => {
    const { zug, hlf } = await catalog();
    const res = await req<{ error: string }>('PUT', `/api/system/forces/${hlf.id}`, { name: 'HLF 20', members: [{ unitId: zug.id }] });
    expect(res.status).toBe(400);
    expect((await req('PUT', `/api/system/forces/${zug.id}`, { name: 'Z', members: [{ unitId: zug.id }] })).status).toBe(400);
  });

  it('entfernt beim Löschen die Mitgliedschaften', async () => {
    const { zug, lf } = await catalog();
    expect((await req('DELETE', `/api/system/forces/${lf.id}`)).status).toBe(204);
    const list = (await req<ForceUnit[]>('GET', '/api/forces')).body;
    expect(list.find((u) => u.id === zug.id)!.members).toHaveLength(2);
  });
});

describe('Kräfte im Einsatz', () => {
  it('übernimmt eine Systemeinheit als Kopie mit abgewählten Untereinheiten', async () => {
    const { elw, hlf, lf, zug, gg } = await catalog();
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const tree = { forceUnitId: zug.id, children: [{ forceUnitId: elw.id, children: [] }, { forceUnitId: hlf.id, children: [] }] };
    const res = await req<Unit>('POST', `/api/incidents/${incident.id}/units/deploy`, { tree, section: 'EA Nord' });
    expect(res.status).toBe(201);
    const units = (await req<Unit[]>('GET', `/api/incidents/${incident.id}/units`)).body;
    expect(units.map((u) => u.name)).toEqual(['Löschzug Mitte', 'ELW 1', 'HLF 20']);
    expect(units.find((u) => u.name === 'ELW 1')).toMatchObject({ parentId: res.body.id, role: 'Führungsfahrzeug', sourceId: elw.id, section: 'EA Nord', status: 'alarmiert' });

    // Nicht im Zug enthalten bzw. schon im Einsatz
    const bad = { forceUnitId: gg.id, children: [{ forceUnitId: lf.id, children: [] }] };
    expect((await req('POST', `/api/incidents/${incident.id}/units/deploy`, { tree: bad })).status).toBe(400);
    expect((await req('POST', `/api/incidents/${incident.id}/units/deploy`, { tree: { forceUnitId: hlf.id, children: [] } })).status).toBe(409);
    // Das abgewählte LF lässt sich nachalarmieren und dem Zug unterstellen
    const late = await req<Unit>('POST', `/api/incidents/${incident.id}/units/deploy`, { tree: { forceUnitId: lf.id, children: [] }, parentId: res.body.id });
    expect(late.body.parentId).toBe(res.body.id);

    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body.map((e) => e.text);
    expect(journal).toContain('Einheit hinzugefügt: Löschzug Mitte (Stärke 1/1/10/12, mit ELW 1, HLF 20), Status Alarmiert → EA Nord');
  });

  it('überträgt Status und Abschnitt auf Untereinheiten und entlässt sie mit', async () => {
    const { zug } = await catalog();
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const full = (await req<ForceUnit[]>('GET', '/api/forces')).body.find((u) => u.id === zug.id)!;
    const tree = { forceUnitId: zug.id, children: full.members.map((m) => ({ forceUnitId: m.unitId, children: [] })) };
    const root = (await req<Unit>('POST', `/api/incidents/${incident.id}/units/deploy`, { tree })).body;
    const units = async () => (await req<Unit[]>('GET', `/api/incidents/${incident.id}/units`)).body;
    const lf = (await units()).find((u) => u.name === 'LF 10')!;

    await req('PATCH', `/api/units/${lf.id}`, { status: 'entlassen' });
    await req('PATCH', `/api/units/${root.id}`, { status: 'einsatz', section: 'EA Süd' });
    expect((await units()).map((u) => [u.name, u.status])).toEqual([
      ['Löschzug Mitte', 'einsatz'],
      ['ELW 1', 'einsatz'],
      ['HLF 20', 'einsatz'],
      ['LF 10', 'entlassen'],
    ]);
    await req('PATCH', `/api/units/${root.id}`, { status: 'entlassen' });
    expect((await units()).every((u) => u.status === 'entlassen' && u.releasedAt)).toBe(true);
    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body.map((e) => e.text);
    expect(journal).toContain('Löschzug Mitte: Status Im Einsatz (mit 2 Untereinheiten), Abschnitt → EA Süd');
  });

  it('setzt die Kartenposition und verhindert Zyklen beim Umhängen', async () => {
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const a = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'Zug A' })).body;
    const b = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'TLF', parentId: a.id, role: 'Wasser' })).body;
    expect((await req('PATCH', `/api/units/${a.id}`, { parentId: b.id })).status).toBe(400);
    expect((await req('PATCH', `/api/units/${b.id}`, { lat: 52.6 })).status).toBe(400);
    const placed = (await req<Unit>('PATCH', `/api/units/${b.id}`, { lat: 52.6, lon: 8.37 })).body;
    expect([placed.lat, placed.lon]).toEqual([52.6, 8.37]);
  });

  it('übernimmt im Einsatz erfasste Einheiten als Systemeinheit (nur Admins)', async () => {
    const { hlf } = await catalog();
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const zug = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'Nachbarzug', strength: strength(2) })).body;
    await req('POST', `/api/incidents/${incident.id}/units`, { name: 'TLF 3000', parentId: zug.id, role: 'Wasserversorgung' });
    await req('POST', `/api/incidents/${incident.id}/units/deploy`, { tree: { forceUnitId: hlf.id, children: [] }, parentId: zug.id });

    expect((await req('POST', `/api/system/forces/adopt/${zug.id}`, undefined, await userCookie())).status).toBe(403);
    const adopted = (await req<ForceUnit>('POST', `/api/system/forces/adopt/${zug.id}`)).body;
    const list = (await req<ForceUnit[]>('GET', '/api/forces')).body;
    const tlf = list.find((u) => u.name === 'TLF 3000')!;
    // Das HLF wird verknüpft, nicht kopiert
    expect(adopted.members).toEqual([
      { unitId: tlf.id, role: 'Wasserversorgung' },
      { unitId: hlf.id, role: '' },
    ]);
    expect(list.filter((u) => u.name === 'HLF 20')).toHaveLength(1);
    const units = (await req<Unit[]>('GET', `/api/incidents/${incident.id}/units`)).body;
    expect(units.find((u) => u.id === zug.id)!.sourceId).toBe(adopted.id);
    expect((await req('POST', `/api/system/forces/adopt/${zug.id}`)).status).toBe(409);
  });
});
