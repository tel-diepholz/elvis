import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoutePrintRequest, RouteResult, RouterStatus } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { decodePolyline6, type RouterFetch } from '../services/router.js';
import { adminCookie } from '../test-helpers.js';

// 1×1 PNG (grau)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64');

/** Gegenstück zu decodePolyline6 für die Testantworten; Punkte [Länge, Breite] */
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

const leg1: [number, number][] = [
  [8.5, 52.7],
  [8.501, 52.7],
  [8.501, 52.701],
];
const leg2: [number, number][] = [
  [8.501, 52.701],
  [8.502, 52.702],
];

const valhalla = {
  trip: {
    summary: { length: 0.42, time: 61 },
    legs: [
      {
        shape: encodePolyline6(leg1),
        summary: { length: 0.25, time: 40 },
        maneuvers: [
          { type: 1, instruction: 'Fahren Sie Richtung Osten auf der Lange Straße.', street_names: ['Lange Straße'], length: 0.1, time: 15, begin_shape_index: 0, bearing_after: 90 },
          { type: 15, instruction: 'Biegen Sie links ab auf die Kirchweg.', street_names: ['Kirchweg'], length: 0.15, time: 25, begin_shape_index: 1, bearing_before: 90, bearing_after: 0 },
          { type: 4, instruction: 'Sie haben Ihr Ziel erreicht.', length: 0, time: 0, begin_shape_index: 2, bearing_before: 0 },
        ],
      },
      {
        shape: encodePolyline6(leg2),
        summary: { length: 0.17, time: 21 },
        maneuvers: [
          { type: 1, instruction: 'Fahren Sie Richtung Nordosten.', length: 0.17, time: 21, begin_shape_index: 0, bearing_after: 30 },
          { type: 4, instruction: 'Sie haben Ihr Ziel erreicht.', length: 0, time: 0, begin_shape_index: 1, bearing_before: 30 },
        ],
      },
    ],
  },
};

let app: App;
let cookie = '';
let dataDir: string;
let tileServer: Server;
const calls: { url: string; body: unknown }[] = [];
let answer: () => Awaited<ReturnType<RouterFetch>> = () => ({ status: 200, json: valhalla });

const routerFetch: RouterFetch = async (url, body) => {
  calls.push({ url, body });
  return answer();
};

const stops = [
  { lat: 52.7, lon: 8.5, name: 'ELW 1' },
  { lat: 52.701, lon: 8.501, name: 'Hydrant' },
  { lat: 52.702, lon: 8.502, name: 'Einsatzort' },
];

beforeEach(async () => {
  calls.length = 0;
  answer = () => ({ status: 200, json: valhalla });
  tileServer = createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
  await new Promise<void>((r) => tileServer.listen(0, '127.0.0.1', r));
  const { port } = tileServer.address() as AddressInfo;
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-route-'));
  app = await buildApp(parseConfig({ dataDir, map: { sources: [{ id: 'test', name: 'Test', url: `http://127.0.0.1:${port}/{z}/{x}/{y}.png`, attribution: '© Test' }] } }), {
    logger: false,
    routerFetch,
  });
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
  return { status: res.statusCode, body: (res.headers['content-type']?.includes('json') ? res.json() : res.rawPayload) as T, headers: res.headers };
}

const local = () => app.router.setProvisions([{ id: 'osm-daten-valhalla', name: 'Routing (lokal)', type: 'valhalla', url: 'http://10.0.0.5:8002/' }]);

describe('Routing', () => {
  it('dekodiert Valhalla-Polylines (6 Nachkommastellen)', () => {
    expect(decodePolyline6(encodePolyline6(leg1))).toEqual(leg1);
    expect(decodePolyline6(encodePolyline6([[-122.4194, 37.7749]]))).toEqual([[-122.4194, 37.7749]]);
  });

  it('ohne Addon nicht verfügbar', async () => {
    expect((await req<RouterStatus>('GET', '/api/map/router', undefined, '')).body).toEqual({ available: false, name: null });
    const res = await req<{ error: string }>('POST', '/api/map/route', { stops });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('OSM-Daten');
    expect(calls).toHaveLength(0);
  });

  it('verlangt eine Anmeldung', async () => {
    local();
    expect((await req('POST', '/api/map/route', { stops }, '')).status).toBe(401);
  });

  it('berechnet die Route über das lokale Valhalla', async () => {
    local();
    expect((await req<RouterStatus>('GET', '/api/map/router')).body).toEqual({ available: true, name: 'Routing (lokal)' });
    const res = await req<RouteResult>('POST', '/api/map/route', { profile: 'truck', stops });
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual({
      url: 'http://10.0.0.5:8002/route',
      body: {
        locations: stops.map((s) => ({ lat: s.lat, lon: s.lon, type: 'break' })),
        costing: 'truck',
        directions_options: { language: 'de-DE', units: 'kilometers' },
      },
    });
    const r = res.body;
    expect(r).toMatchObject({ profile: 'truck', source: 'Routing (lokal)', distanceM: 420, durationS: 61, legs: [{ distanceM: 250, durationS: 40 }, { distanceM: 170, durationS: 21 }] });
    // Teilstrecken ohne doppelten Punkt am Zwischenziel
    expect(r.path).toEqual([...leg1, leg2[1]]);
    expect(r.maneuvers).toHaveLength(5);
    expect(r.maneuvers[1]).toEqual({ type: 15, instruction: 'Biegen Sie links ab auf die Kirchweg.', distanceM: 150, durationS: 25, street: 'Kirchweg', lat: 52.7, lon: 8.501, bearingBefore: 90, bearingAfter: 0 });
    expect(r.maneuvers[4]).toMatchObject({ lat: 52.702, lon: 8.502, street: null, bearingAfter: null });
  });

  it('meldet fehlende Route verständlich', async () => {
    local();
    answer = () => ({ status: 400, json: { error_code: 442, error: 'No path could be found for input', status_code: 400 } });
    expect((await req<{ error: string }>('POST', '/api/map/route', { stops })).body).toEqual({ error: 'Keine Route zwischen den Halten gefunden' });
    answer = () => ({ status: 400, json: { error_code: 171, error: 'No suitable edges near location' } });
    expect((await req('POST', '/api/map/route', { stops })).status).toBe(422);
    answer = () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await req<{ error: string }>('POST', '/api/map/route', { stops });
    expect(down.status).toBe(502);
    expect(down.body.error).toContain('ECONNREFUSED');
  });

  it('druckt Übersicht und Fahrhinweise über mehrere Seiten', async () => {
    local();
    const route = (await req<RouteResult>('POST', '/api/map/route', { stops })).body;
    // viele Hinweise erzwingen Folgeseiten
    const many = { ...route, maneuvers: Array.from({ length: 12 }, (_, i) => route.maneuvers[i % route.maneuvers.length]!) };
    const payload: RoutePrintRequest = { title: 'Anfahrt Einsatzort', sourceId: 'test', stops, route: many };
    const res = await req<Buffer>('POST', '/api/print/route', payload);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-missing-tiles']).toBe('0');
    const pdf = res.body.toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf.match(/\/Type \/Page\b/g)!.length).toBeGreaterThanOrEqual(3);

    const audit = (await req<{ action: string }[]>('GET', '/api/audit')).body;
    expect(audit[0]?.action).toBe('print-route');
  });
});
