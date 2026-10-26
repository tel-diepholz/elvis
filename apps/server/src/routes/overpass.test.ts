import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Incident, type IncidentOverpassQuery, type JournalEntry, type MapObject, type OverpassQuerySettings, type OverpassResult, type User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { OverpassError, overpassErrorText, prepareQl, type OverpassFetch } from '../services/overpass.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';
const calls: { url: string; ql: string }[] = [];
let answer: (url: string, ql: string) => unknown = () => ({ elements: [] });

const overpassFetch: OverpassFetch = async (url, ql) => {
  calls.push({ url, ql });
  return answer(url, ql);
};

async function setup(map: Record<string, unknown> = {}) {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-overpass-'));
  app = await buildApp(parseConfig({ dataDir, map }), { logger: false, overpassFetch, overpassRetryDelaysMs: [10, 10] });
  admin = await adminCookie(app);
}

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ elements: [] });
});

afterEach(async () => {
  if (!dataDir) return; // reine Funktionstests ohne Server
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  dataDir = '';
});

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

async function userCookie(): Promise<string> {
  const user = (await req<User>('POST', '/api/users', { firstName: 'Anna', lastName: 'Test', pin: '1111' })).body;
  const res = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
  return sessionCookie(res.headers['set-cookie']);
}

const bounds = { s: 52.6, w: 8.4, n: 52.8, e: 8.6 };
const fireStations = { name: 'Feuerwehrhäuser', mode: 'simple', filters: [{ key: 'amenity', op: '=', value: 'fire_station' }] };

describe('Overpass-Abfrage', () => {
  it('bereitet die Abfrage vor: JSON, Laufzeit, Ausschnitt', () => {
    expect(prepareQl('node[amenity=fuel]({{bbox}});out;', bounds)).toBe('[out:json][timeout:60];\nnode[amenity=fuel](52.6,8.4,52.8,8.6);out;');
    expect(prepareQl('[out:xml][timeout:900];way({{bbox}});out geom;', bounds)).toBe('[out:json][timeout:180];way(52.6,8.4,52.8,8.6);out geom;');
    expect(prepareQl('[bbox:{{bbox}}];nwr[shop];out center;', bounds)).toBe('[out:json][timeout:60][bbox:52.6,8.4,52.8,8.6];nwr[shop];out center;');
    expect(overpassErrorText('<p><strong style="color:#FF0000">Error</strong>: line 1: parse error: Unknown type &quot;nod&quot; </p>')).toBe('line 1: parse error: Unknown type "nod"');
  });

  it('fragt ohne Addon den öffentlichen Server und liefert Treffer', async () => {
    await setup();
    expect((await req('GET', '/api/map/overpass/status')).body).toEqual({ source: 'online', name: 'overpass-api.de' });
    answer = () => ({ elements: [{ type: 'node', id: 7, lat: 52.7, lon: 8.5, tags: { amenity: 'fire_station', name: 'FF Barnstorf' } }] });

    const res = await req<OverpassResult>('POST', '/api/map/overpass', { query: fireStations, bounds });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'online', sourceName: 'overpass-api.de', truncated: false, skipped: 0, features: [{ id: 'N7', name: 'FF Barnstorf', geometry: { type: 'Point' } }] });
    expect(calls).toEqual([{ url: 'https://overpass-api.de/api/interpreter', ql: '[out:json][timeout:60];\nnwr["amenity"="fire_station"](52.6,8.4,52.8,8.6);\nout geom;' }]);

    // Nur angemeldet; Ausschnitt begrenzt
    expect((await req('POST', '/api/map/overpass', { query: fireStations, bounds }, '')).status).toBe(401);
    expect((await req('POST', '/api/map/overpass', { query: fireStations, bounds: { s: 50, w: 6, n: 55, e: 12 } })).status).toBe(400);
  });

  it('meldet fehlerhafte Abfragen und Ausfälle verständlich', async () => {
    await setup();
    answer = () => {
      throw new OverpassError('line 1: parse error', 400);
    };
    const bad = await req<{ error: string }>('POST', '/api/map/overpass', { query: { name: 'X', mode: 'ql', ql: 'nod;out;' }, bounds });
    expect(bad).toEqual({ status: 400, body: { error: 'Abfrage fehlerhaft: line 1: parse error' } });

    // Ausgelastet (502): bis zu zweimal neu versuchen
    let tries = 0;
    answer = () => {
      if (tries++ < 2) throw new OverpassError('HTTP 502', 502);
      return { elements: [] };
    };
    expect((await req('POST', '/api/map/overpass', { query: fireStations, bounds })).status).toBe(200);
    expect(tries).toBe(3);
    tries = 0;
    answer = () => {
      tries++;
      throw new OverpassError('HTTP 502', 502);
    };
    const full = await req<{ error: string }>('POST', '/api/map/overpass', { query: fireStations, bounds });
    expect(full).toEqual({ status: 502, body: { error: 'Overpass nicht erreichbar (overpass-api.de: öffentlicher Server ausgelastet, bitte in einer Minute erneut versuchen)' } });
    expect(tries).toBe(3);

    answer = () => {
      throw new OverpassError('HTTP 429', 429);
    };
    const busy = await req<{ error: string }>('POST', '/api/map/overpass', { query: fireStations, bounds });
    expect(busy.status).toBe(502);
    expect(busy.body.error).toContain('zu viele Anfragen');
  }, 15_000); // öffentliche Anfragen laufen gedrosselt (1 s Abstand)

  it('ohne öffentlichen Server und ohne Addon: kein Overpass', async () => {
    await setup({ overpassUrl: null });
    expect((await req('GET', '/api/map/overpass/status')).body).toEqual({ source: null, name: null });
    const res = await req<{ error: string }>('POST', '/api/map/overpass', { query: fireStations, bounds });
    expect(res).toEqual({ status: 502, body: { error: 'Kein Overpass-Server eingerichtet' } });
  });

  it('Vorlagen: anfangs keine, von Admins pflegbar, für alle lesbar', async () => {
    await setup();
    expect((await req('GET', '/api/map/overpass/queries', undefined, '')).body).toEqual([]);
    expect((await req<OverpassQuerySettings>('GET', '/api/system/overpass-queries')).body).toEqual({ queries: [], updatedAt: null, updatedBy: null });

    const own = [{ name: 'Hydranten', mode: 'simple', elements: 'node', filters: [{ key: 'emergency', op: '=', value: 'fire_hydrant' }], ql: '', icon: 'Droplet', badge: 'DN {fire_hydrant:diameter}', color: '#e53935' }];
    const user = await userCookie();
    expect((await req('PUT', '/api/system/overpass-queries', { queries: own }, user)).status).toBe(403);
    const saved = await req<OverpassQuerySettings>('PUT', '/api/system/overpass-queries', { queries: own });
    expect(saved.body).toMatchObject({ updatedBy: 'Max Müller', queries: own });
    expect((await req('GET', '/api/map/overpass/queries', undefined, user)).body).toEqual(own);
    expect((await req('PUT', '/api/system/overpass-queries', { queries: [{ name: 'X', mode: 'ql', ql: '' }] })).status).toBe(400);
    expect((await req<{ error: string }>('PUT', '/api/system/overpass-queries', { queries: [{ ...own[0], icon: 'GibtEsNicht' }] })).body.error).toBe('„Hydranten“: Symbol „GibtEsNicht“ gibt es nicht');
    expect((await req('PUT', '/api/system/overpass-queries', { queries: null })).status).toBe(400);
    expect((await req('PUT', '/api/system/overpass-queries', { queries: [{ ...own[0], color: 'rot' }] })).status).toBe(400);
  });

  it('Abfragen im Einsatz speichern; nach dem Einsatz nur noch lesbar', async () => {
    await setup();
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Waldbrand', keyword: 'F3' })).body;
    const url = `/api/incidents/${incident.id}/overpass-queries`;
    const ql = { name: 'Löschteiche', mode: 'ql', ql: 'nwr[emergency=fire_water_pond]({{bbox}});out geom;' };

    const created = await req<IncidentOverpassQuery>('POST', url, ql);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...ql, elements: 'nwr', filters: [], icon: null, badge: '', color: null, incidentId: incident.id, createdBy: 'Max Müller' });
    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body;
    expect(journal.some((j) => j.text === 'Overpass-Abfrage gespeichert: „Löschteiche“')).toBe(true);

    const renamed = await req<IncidentOverpassQuery>('PUT', `/api/overpass-queries/${created.body.id}`, { ...ql, name: 'Teiche' });
    expect(renamed.body.name).toBe('Teiche');
    expect((await req<IncidentOverpassQuery[]>('GET', url)).body.map((q) => q.name)).toEqual(['Teiche']);

    await req('POST', `/api/incidents/${incident.id}/close`);
    expect((await req('POST', url, ql)).status).toBe(409);
    expect((await req('DELETE', `/api/overpass-queries/${created.body.id}`)).status).toBe(409);
    expect((await req<IncidentOverpassQuery[]>('GET', url)).body).toHaveLength(1);
  });

  it('Treffer als Linie in die Objektliste übernehmen', async () => {
    await setup();
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Ölspur', keyword: 'TH1' })).body;
    const line = { kind: 'line', name: 'Hunte', lat: 52.7, lon: 8.5, data: { detail: 'waterway=river', osm: 'W12', path: { type: 'LineString', coordinates: [[8.5, 52.7], [8.6, 52.8]] } } };
    const res = await req<MapObject>('POST', `/api/incidents/${incident.id}/objects`, line);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'line', color: null, data: line.data });

    // Hydrant aus einer Vorlage: Farbe, Symbol und Schild
    const hydrant = { kind: 'point', name: 'Hydrant', lat: 52.7, lon: 8.5, color: '#e53935', data: { detail: '', osm: 'N7', icon: 'Droplet', badge: 'DN 100' } };
    expect((await req<MapObject>('POST', `/api/incidents/${incident.id}/objects`, hydrant)).body).toMatchObject({ color: '#e53935', data: { icon: 'Droplet', badge: 'DN 100' } });
  });
});
