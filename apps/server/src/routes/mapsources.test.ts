import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MapSource, MapSourceInput, MapSourceSettings, MapSourceTestResult, User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

// 1×1 PNG (grau)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64');

let app: App;
let admin = '';
let dataDir: string;
let server: Server;
let base = '';
let requests: string[];

beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    requests.push(req.url!);
    // WMS-Fehler kommen als XML
    if (req.url!.includes('LAYERS=falsch')) return res.writeHead(200, { 'content-type': 'text/xml' }).end('<ServiceExceptionReport><ServiceException>Layer falsch nicht vorhanden</ServiceException></ServiceExceptionReport>');
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-mapsources-'));
  app = await buildApp(parseConfig({ dataDir, map: { sources: [{ id: 'osm', name: 'OSM', url: `${base}/osm/{z}/{x}/{y}.png`, attribution: '© OSM' }] } }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

async function req<T>(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

const wms = (layers = 'ni_dop20'): MapSourceInput => ({
  id: 'luftbild',
  name: 'Luftbild',
  url: `${base}/wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=${layers}&CRS=EPSG:3857&BBOX={bbox}&WIDTH={width}&HEIGHT={height}`,
  attribution: '© GeoBasis-DE/LGLN',
  maxZoom: 20,
  pixelRatio: 2,
  cache: true,
});

describe('Kartenquellen in den Einstellungen', () => {
  it('speichert WMS-Quellen und lädt Kacheln mit Ausschnitt und Bildgröße', async () => {
    expect((await req<MapSourceSettings>('GET', '/api/system/map-sources')).body.sources.map((s) => [s.id, s.origin])).toEqual([['osm', 'config']]);

    const saved = await req<MapSourceSettings>('PUT', '/api/system/map-sources', { sources: [wms()] });
    expect(saved.status).toBe(200);
    expect(saved.body.sources.map((s) => [s.id, s.origin])).toEqual([['osm', 'config'], ['luftbild', 'settings']]);
    expect(saved.body.updatedBy).toBe('Max Müller');
    expect((await req<MapSource[]>('GET', '/api/map/sources')).body.map((s) => s.id)).toEqual(['osm', 'luftbild']);

    const tile = await app.server.inject({ method: 'GET', url: '/api/map/tiles/luftbild/0/0/0', headers: { cookie: admin } });
    expect(tile.statusCode).toBe(200);
    expect(requests.at(-1)).toBe('/wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=ni_dop20&CRS=EPSG:3857&BBOX=-20037508.34,-20037508.34,20037508.34,20037508.34&WIDTH=512&HEIGHT=512');
    expect(existsSync(join(dataDir, 'tiles', 'luftbild', '0', '0', '0'))).toBe(true);

    // Geänderte URL: alte Kacheln verwerfen
    await req('PUT', '/api/system/map-sources', { sources: [{ ...wms(), url: wms().url.replace('ni_dop20', 'ni_dop20_neu') }] });
    expect(existsSync(join(dataDir, 'tiles', 'luftbild'))).toBe(false);

    // Nach einem Neustart sind die Quellen noch da
    await app.close();
    app = await buildApp(parseConfig({ dataDir, map: { sources: [{ id: 'osm', name: 'OSM', url: `${base}/osm/{z}/{x}/{y}.png`, attribution: '© OSM' }] } }), { logger: false });
    expect((await req<MapSource[]>('GET', '/api/map/sources')).body.map((s) => s.id)).toEqual(['osm', 'luftbild']);
  });

  it('lehnt ungültige Quellen und vergebene Kennungen ab', async () => {
    const noPlaceholder = await req<{ error: string }>('PUT', '/api/system/map-sources', { sources: [{ ...wms(), url: `${base}/bild.png` }] });
    expect(noPlaceholder.status).toBe(400);
    expect(noPlaceholder.body.error).toMatch(/\{bbox\}/);
    const taken = await req<{ error: string }>('PUT', '/api/system/map-sources', { sources: [{ ...wms(), id: 'osm' }] });
    expect(taken.status).toBe(400);
    expect(taken.body.error).toMatch(/schon vergeben/);
  });

  it('ist nur für Admins', async () => {
    const user = (await req<User>('POST', '/api/users', { firstName: 'Anna', lastName: 'Test', pin: '1111' })).body;
    const login = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
    const anna = sessionCookie(login.headers['set-cookie']);
    expect((await req('GET', '/api/system/map-sources', undefined, anna)).status).toBe(403);
    expect((await req('PUT', '/api/system/map-sources', { sources: [] }, anna)).status).toBe(403);
  });

  it('testet eine Quelle und meldet WMS-Fehler im Klartext', async () => {
    const ok = await req<MapSourceTestResult>('POST', '/api/system/map-sources/test', wms());
    expect(ok.body).toEqual({ ok: true, contentType: 'image/png', error: null });
    expect(requests.at(-1)).toContain('WIDTH=512');

    const bad = await req<MapSourceTestResult>('POST', '/api/system/map-sources/test', wms('falsch'));
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toBe('Kein Bild (text/xml): Layer falsch nicht vorhanden');
  });
});
