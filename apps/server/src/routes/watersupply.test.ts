import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_HYDRAULICS, suggestPumps, type ElevationProfile, type ObjectType, type WaterSupplyPrintRequest, type WaterSupplyResult } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { ElevationFetch } from '../services/elevation.js';
import type { RouterFetch } from '../services/router.js';
import { adminCookie } from '../test-helpers.js';

/** Polyline6 für die Testantworten; Punkte [Länge, Breite] */
function encodePolyline6(points: [number, number][]): string {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [lon, lat] of points) {
    const la = Math.round(lat * 1e6);
    const lo = Math.round(lon * 1e6);
    enc(la - pLat);
    enc(lo - pLon);
    pLat = la;
    pLon = lo;
  }
  return out;
}

const ORIGIN = { lat: 52.7, lon: 8.5 };
// 1×1 PNG (grau)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64');
let tileServer: Server;

let app: App;
let cookie = '';
let dataDir: string;
const routerCalls: { url: string; body: { locations: { lat: number; lon: number }[]; costing: string } }[] = [];
const elevationCalls: string[] = [];
/** Wegstrecke je Start-Breite (km); fehlt sie, gibt es keine Route */
let walkKm: Record<string, number> = {};
let elevationDown = false;

const routerFetch: RouterFetch = async (url, body) => {
  const b = body as (typeof routerCalls)[number]['body'];
  routerCalls.push({ url, body: b });
  const [from, to] = b.locations;
  const km = walkKm[from!.lat.toFixed(4)];
  if (km === undefined) return { status: 400, json: { error_code: 442, error: 'No path could be found for input' } };
  const shape = encodePolyline6([
    [from!.lon, from!.lat],
    [to!.lon, to!.lat],
  ]);
  return { status: 200, json: { trip: { summary: { length: km, time: 600 }, legs: [{ shape, summary: { length: km, time: 600 }, maneuvers: [] }] } } };
};

const elevationFetch: ElevationFetch = async (url) => {
  elevationCalls.push(url);
  if (elevationDown) throw new Error('getaddrinfo ENOTFOUND api.open-meteo.com');
  const lats = new URL(url).searchParams.get('latitude')!.split(',').map(Number);
  // Höhe steigt nach Norden: 1 m je 0,0001°
  return { status: 200, json: { elevation: lats.map((lat) => Math.round((lat - 52.7) * 10_000)) } };
};

beforeEach(async () => {
  routerCalls.length = 0;
  elevationCalls.length = 0;
  walkKm = {};
  elevationDown = false;
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-water-'));
  tileServer = createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
  await new Promise<void>((r) => tileServer.listen(0, '127.0.0.1', r));
  const { port } = tileServer.address() as AddressInfo;
  const sources = [{ id: 'test', name: 'Test', url: `http://127.0.0.1:${port}/{z}/{x}/{y}.png`, attribution: '© Test' }];
  app = await buildApp(parseConfig({ dataDir, map: { routerUrl: null, sources } }), { logger: false, routerFetch, elevationFetch });
  cookie = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  tileServer.closeAllConnections();
  await new Promise((r) => tileServer.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

async function req<T = unknown>(method: 'GET' | 'POST', url: string, payload?: unknown, c = cookie) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: c ? { cookie: c } : {} });
  return { status: res.statusCode, body: (String(res.headers['content-type'] ?? '').includes('json') ? res.json() : res.rawPayload) as T, headers: res.headers };
}

const local = () => app.router.setProvisions([{ id: 'osm-daten-valhalla', name: 'Routing (lokal)', type: 'valhalla', url: 'http://10.0.0.5:8002' }]);

async function addWater(name: string, dLat: number, props: Record<string, unknown> = { art: 'Hydrant Unterflur', dn: 100 }) {
  const types = (await req<ObjectType[]>('GET', '/api/library/types')).body;
  const water = types.find((t) => t.builtin === 'water')!;
  const site = types.find((t) => t.builtin === 'site')!;
  const typeId = name.startsWith('Objekt') ? site.id : water.id;
  const res = await req('POST', '/api/library/objects', { typeId, name, lat: ORIGIN.lat + dLat, lon: ORIGIN.lon, props: name.startsWith('Objekt') ? {} : props });
  expect(res.status).toBe(201);
}

describe('Wasserversorgung', () => {
  it('ohne Routing nicht verfügbar, nur angemeldet', async () => {
    expect((await req('POST', '/api/map/water-supply', ORIGIN, '')).status).toBe(401);
    const res = await req<{ error: string }>('POST', '/api/map/water-supply', ORIGIN);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('OSM-Daten');
  });

  it('nimmt die nächsten Entnahmestellen und sortiert nach Fußweg', async () => {
    local();
    // Luftlinie: H1 ≈ 111 m, H2 ≈ 222 m, H3 ≈ 333 m, H4 ≈ 444 m; Fußweg: H1 hinter dem Bahndamm am längsten
    await addWater('H1', 0.001);
    await addWater('H2', 0.002);
    await addWater('H3', 0.003);
    await addWater('H4', 0.004);
    await addWater('Weit weg', 0.2);
    await addWater('Objekt Schule', 0.0005);
    walkKm = { '52.7010': 1.5, '52.7020': 0.3, '52.7040': 0.5 };
    const res = await req<WaterSupplyResult>('POST', '/api/map/water-supply', { ...ORIGIN, count: 3 });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('Routing (lokal)');
    expect(res.body.candidates.map((c) => [c.object.name, c.route?.distanceM ?? null])).toEqual([
      ['H2', 300],
      ['H1', 1500],
      ['H3', null],
    ]);
    expect(res.body.candidates[0]!.airDistanceM).toBe(222);
    expect(res.body.candidates[2]!.error).toBe('Keine Route zwischen den Halten gefunden');
    // zu Fuß von der Entnahmestelle zum Einsatzort
    expect(routerCalls).toHaveLength(3);
    expect(routerCalls[0]!.body.costing).toBe('pedestrian');
    expect(routerCalls[0]!.body.locations[1]).toMatchObject(ORIGIN);
    expect(res.body.candidates[0]!.route!.path.at(-1)).toEqual([ORIGIN.lon, ORIGIN.lat]);
  });

  it('sucht weiter, wenn in der Nähe zu wenige liegen', async () => {
    local();
    await addWater('Löschteich', 0.04, { art: 'Löschteich' });
    walkKm = { '52.7400': 5 };
    const res = await req<WaterSupplyResult>('POST', '/api/map/water-supply', ORIGIN);
    expect(res.body.candidates.map((c) => c.object.name)).toEqual(['Löschteich']);
  });

  it('liefert den Höhenschnitt in Abschnitten zu 100 Punkten', async () => {
    // 3 km nach Norden → 151 Stützpunkte alle 20 m
    const path: [number, number][] = [
      [8.5, 52.7],
      [8.5, 52.7 + 3000 / 111_195],
    ];
    const res = await req<ElevationProfile>('POST', '/api/map/elevation', { path });
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(151);
    expect(res.body.points[0]).toMatchObject({ d: 0, h: 0 });
    expect(res.body.points.at(-1)!.h).toBe(270);
    expect(elevationCalls).toHaveLength(2);
    expect(elevationCalls[0]).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/elevation\?latitude=/);
    // zweiter Abruf aus dem Zwischenspeicher
    await req('POST', '/api/map/elevation', { path });
    expect(elevationCalls).toHaveLength(2);
  });

  it('meldet fehlende Höhendaten verständlich', async () => {
    elevationDown = true;
    const res = await req<{ error: string }>('POST', '/api/map/elevation', { path: [[8.5, 52.7], [8.5, 52.71]] });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('offline');
  });

  it('druckt Karte, Pumpentabelle und Höhenschnitt auf A4 quer', async () => {
    const path: [number, number][] = [
      [8.5, 52.7],
      [8.5, 52.7 + 2000 / 111_195],
    ];
    const profile = (await req<ElevationProfile>('POST', '/api/map/elevation', { path })).body;
    const pumpDs = suggestPumps(profile.points, DEFAULT_HYDRAULICS).pumpDs;
    expect(pumpDs.length).toBeGreaterThan(1);
    const payload: WaterSupplyPrintRequest = {
      title: 'Wasserversorgung Brand Scheune',
      sourceId: 'test',
      incident: { lat: 52.7 + 2000 / 111_195, lon: 8.5, name: 'Brand Scheune' },
      water: { name: 'Löschteich Mühle', info: 'Löschteich · 400 m³', address: 'Mühlenweg', lat: 52.7, lon: 8.5 },
      routeSource: 'Routing (lokal)',
      path,
      profile: profile.points,
      elevationSource: profile.source,
      hydraulics: DEFAULT_HYDRAULICS,
      pumpDs,
    };
    const res = await req<Buffer>('POST', '/api/print/water-supply', payload);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-missing-tiles']).toBe('0');
    const pdf = res.body.toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(2);
    // A4 quer
    expect(pdf).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
    expect((await req<{ action: string }[]>('GET', '/api/audit')).body[0]?.action).toBe('print-water-supply');
    expect((await req('POST', '/api/print/water-supply', payload, '')).status).toBe(401);
  });
});
