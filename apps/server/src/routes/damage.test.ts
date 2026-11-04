import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { damageTotals, type DamageAccount, type DamageCountBooking, type DamageEntry, type Incident, type JournalEntry, type Unit } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';
let inc: Incident;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const create = (payload: object) => req<DamageAccount>('POST', `/api/incidents/${inc.id}/damage-accounts`, payload);
const list = async () => (await req<DamageAccount[]>('GET', `/api/incidents/${inc.id}/damage-accounts`)).body;
const journal = async () => (await req<JournalEntry[]>('GET', `/api/incidents/${inc.id}/journal`)).body.map((e) => e.text);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-damage-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
  inc = (await req<Incident>('POST', '/api/incidents', { title: 'Zugunglück' })).body;
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Schadenkonten', () => {
  it('nummeriert je Einsatz fortlaufend und lehnt doppelte Bezeichnungen ab', async () => {
    const leader = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'ELW 1' })).body;
    const a = await create({ name: 'Bahnhof', leaderUnitId: leader.id, radio: 'Kanal 301' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ number: 1, name: 'Bahnhof', leaderUnitId: leader.id, leader: 'ELW 1', radio: 'Kanal 301', entries: [], counts: [] });
    expect((await create({ name: 'Brücke' })).body.number).toBe(2);
    expect((await create({ name: 'bahnhof' })).status).toBe(409);
    expect((await create({ name: '' })).status).toBe(400);
    expect((await create({ name: 'Ort', lat: 52 })).status).toBe(400);
    expect(await journal()).toContain('Schadenkonto 1 Bahnhof: eingerichtet, Leiter ELW 1, Fm Kanal 301');
    expect((await req('GET', `/api/incidents/${inc.id}/damage-accounts`, undefined, '')).status).toBe(401);
  });

  it('ändert Kopfdaten und Position; der Name ist der Abschnitt der Einheiten', async () => {
    const a = (await create({ name: 'EA Nord' })).body;
    const unit = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'HLF', accountId: a.id })).body;
    expect(unit).toMatchObject({ accountId: a.id, section: 'EA Nord' });
    const res = await req<DamageAccount>('PATCH', `/api/damage-accounts/${a.id}`, { name: 'EA Nordost', lat: 52.6, lon: 8.4 });
    expect(res.body).toMatchObject({ name: 'EA Nordost', lat: 52.6, lon: 8.4 });
    expect((await req<Unit>('GET', `/api/incidents/${inc.id}/units`)).body).toMatchObject([{ section: 'EA Nordost' }]);
    expect(await journal()).toContain('Schadenkonto 1 EA Nordost: umbenannt (vorher EA Nord), auf der Karte gesetzt');
  });

  it('führt Einträge mit „?“ und streicht Erledigtes durch statt zu löschen', async () => {
    const a = (await create({ name: 'Bahnhof' })).body;
    const gas = await req<DamageEntry>('POST', `/api/damage-accounts/${a.id}/entries`, { side: 'gefahr', text: 'Gasaustritt', uncertain: true });
    expect(gas.status).toBe(201);
    expect(gas.body).toMatchObject({ side: 'gefahr', text: 'Gasaustritt', uncertain: true, doneAt: null });
    expect((await req('POST', `/api/damage-accounts/${a.id}/entries`, { side: 'schaden' })).status).toBe(400);
    expect((await req('POST', `/api/damage-accounts/${a.id}/entries`, { side: 'schaden', sign: 'kaputt' })).status).toBe(400);

    await req('PATCH', `/api/damage-entries/${gas.body.id}`, { uncertain: false });
    const done = await req<DamageEntry>('PATCH', `/api/damage-entries/${gas.body.id}`, { done: true });
    expect(done.body.doneAt).not.toBeNull();
    expect((await list())[0]!.entries).toHaveLength(1);
    expect(await journal()).toEqual(
      expect.arrayContaining([
        'Schadenkonto 1 Bahnhof: Gefahr ? Gasaustritt',
        'Schadenkonto 1 Bahnhof: Gefahr Gasaustritt bestätigt',
        'Schadenkonto 1 Bahnhof: Gefahr Gasaustritt erledigt',
      ]),
    );
  });

  it('bucht Personenschäden als Stand mit Verlauf und summiert über alle Konten', async () => {
    const a = (await create({ name: 'Bahnhof' })).body;
    const b = (await create({ name: 'Brücke' })).body;
    const book = (id: number, payload: object) => req<DamageAccount>('POST', `/api/damage-accounts/${id}/counts`, payload);
    await book(a.id, { category: 'sk2', value: 3 });
    const res = await book(a.id, { category: 'sk2', value: 5, forces: 1, estimated: true });
    expect(res.body.counts).toMatchObject([{ category: 'sk2', value: 5, forces: 1, estimated: true }]);
    // Gleicher Stand wird nicht erneut gebucht
    await book(a.id, { category: 'sk2', value: 5, forces: 1, estimated: true });
    await book(b.id, { category: 'sk2', value: 2 });
    await book(b.id, { category: 'tot', value: 1 });
    expect((await book(b.id, { category: 'tot', value: 1, forces: 2 })).status).toBe(400);

    const history = (await req<DamageCountBooking[]>('GET', `/api/damage-accounts/${a.id}/counts`)).body;
    expect(history.map((h) => h.value)).toEqual([5, 3]);
    expect(damageTotals(await list())).toMatchObject([
      { category: 'tot', value: 1, forces: 0, estimated: false },
      { category: 'sk2', value: 7, forces: 1, estimated: true },
    ]);
    expect(await journal()).toContain('Schadenkonto 1 Bahnhof: Verletzte SK II 3 → ~5 (davon 1 EK) (geschätzt)');
  });

  it('löst ein Konto erst auf, wenn keine aktiven Einheiten mehr im Abschnitt sind', async () => {
    const a = (await create({ name: 'Bahnhof' })).body;
    const unit = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'HLF', accountId: a.id })).body;
    expect((await req('POST', `/api/damage-accounts/${a.id}/close`)).status).toBe(409);
    await req('PATCH', `/api/units/${unit.id}`, { status: 'entlassen' });
    const closed = await req<DamageAccount>('POST', `/api/damage-accounts/${a.id}/close`);
    expect(closed.body.closedAt).not.toBeNull();
    // Aufgelöst: keine Einträge, keine Zuordnung mehr; der Name ist wieder frei
    expect((await req('POST', `/api/damage-accounts/${a.id}/entries`, { side: 'schaden', text: 'x' })).status).toBe(409);
    expect((await req('POST', `/api/incidents/${inc.id}/units`, { name: 'TLF', accountId: a.id })).status).toBe(409);
    expect((await create({ name: 'Bahnhof' })).body.number).toBe(2);
  });

  it('weist Konten fremder Einsätze ab und sperrt nach Einsatzende', async () => {
    const a = (await create({ name: 'Bahnhof' })).body;
    await req('POST', `/api/incidents/${inc.id}/close`);
    expect((await req('POST', `/api/damage-accounts/${a.id}/counts`, { category: 'tot', value: 1 })).status).toBe(409);
    expect((await create({ name: 'Neu' })).status).toBe(409);
    const next = (await req<Incident>('POST', '/api/incidents', { title: 'Sturm' })).body;
    expect((await req('POST', `/api/incidents/${next.id}/units`, { name: 'HLF', accountId: a.id })).status).toBe(400);
    expect((await req<DamageAccount[]>('GET', `/api/incidents/${inc.id}/damage-accounts`)).body).toHaveLength(1);
  });
});
