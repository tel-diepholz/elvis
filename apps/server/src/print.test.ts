import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MapPrintRequest } from '@elvis/shared';
import { buildApp, type App } from './app.js';
import { parseConfig } from './config.js';
import { pdfText } from './services/print.js';
import { adminCookie } from './test-helpers.js';

// 1×1 PNG (grau)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64');

let app: App;
let cookie = '';
let dataDir: string;
let tileServer: Server;
let tileRequests: number;

beforeEach(async () => {
  tileRequests = 0;
  tileServer = createServer((req, res) => {
    tileRequests++;
    expect(req.headers['user-agent']).toContain('ELVIS');
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  });
  await new Promise<void>((r) => tileServer.listen(0, '127.0.0.1', r));
  const { port } = tileServer.address() as AddressInfo;
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-print-'));
  app = await buildApp(
    parseConfig({
      dataDir,
      map: { sources: [{ id: 'test', name: 'Test', url: `http://127.0.0.1:${port}/{z}/{x}/{y}.png`, attribution: '© Test' }] },
    }),
    { logger: false },
  );
  cookie = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  tileServer.closeAllConnections();
  await new Promise((r) => tileServer.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

const request: MapPrintRequest = {
  paper: 'A3',
  orientation: 'landscape',
  zoom: 15,
  center: { lat: 51.1657, lon: 10.4515 },
  sourceId: 'test',
  title: 'B3 · Brand Lagerhalle',
  subtitle: 'Industriestr. 5',
  markers: [
    { kind: 'vehicle', lat: 51.1657, lon: 10.4515, label: 'ELW 2' },
    { kind: 'incident', lat: 51.1662, lon: 10.456, label: 'Einsatzort' },
    { kind: 'point', lat: 51.1655, lon: 10.452, label: 'Hydrant Industriestr.', color: '#43a047' },
  ],
  polygons: [{ points: [[51.1662, 10.456], [51.17, 10.47], [51.165, 10.47]], stroke: '#e53935', fill: '#e53935', fillOpacity: 0.3 }],
  legend: [{ color: '#e53935', label: 'hoch ≥ 1·10⁻³ s/m³' }],
  notes: ['Wind 3,9 m/s aus WSW'],
};

describe('Kartendruck', () => {
  it('erzeugt ein PDF im gewählten Format und protokolliert den Druck', async () => {
    const res = await app.server.inject({ method: 'POST', url: '/api/print/map', payload: request, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-missing-tiles']).toBe('0');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // A3 quer: 420 × 297 mm = 1190,55 × 841,89 pt
    expect(res.rawPayload.toString('latin1')).toMatch(/MediaBox \[0 0 1190\.55\d* 841\.88\d*\]/);
    expect(res.rawPayload.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBe(1);

    const audit = (await app.server.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).json() as { action: string }[];
    expect(audit[0]?.action).toBe('print');
  });

  it('erzeugt genau eine Seite, auch wenn Markierungen außerhalb des Ausschnitts liegen', async () => {
    const formats = [...(['A4', 'A3', 'A2', 'A1'] as const).map((paper) => [paper, 'portrait'] as const), ['A4', 'landscape'] as const];
    for (const [paper, orientation] of formats) {
      for (const lat of [51.0, 51.3]) {
        const payload = { ...request, paper, orientation, markers: [{ kind: 'vehicle', lat, lon: 10.4515, label: 'ELW 2' }] };
        const res = await app.server.inject({ method: 'POST', url: '/api/print/map', payload, headers: { cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.rawPayload.toString('latin1').match(/\/Type \/Page\b/g)?.length, `${paper} ${orientation} lat ${lat}`).toBe(1);
      }
    }
  });

  it('nutzt den Kachel-Cache, auch wenn die Quelle offline ist', async () => {
    const first = await app.server.inject({ method: 'GET', url: '/api/map/tiles/test/15/17335/10991' });
    expect(first.statusCode).toBe(200);
    expect(tileRequests).toBe(1);

    tileServer.closeAllConnections();
    await new Promise((r) => tileServer.close(r));
    const cached = await app.server.inject({ method: 'GET', url: '/api/map/tiles/test/15/17335/10991' });
    expect(cached.statusCode).toBe(200);
    expect(cached.rawPayload.equals(PNG)).toBe(true);
    await new Promise<void>((r) => tileServer.listen(0, '127.0.0.1', r)); // für afterEach
  });

  it('weist zu hohe Zoomstufen und unbekannte Quellen ab', async () => {
    const tooClose = await app.server.inject({ method: 'POST', url: '/api/print/map', payload: { ...request, zoom: 20 }, headers: { cookie } });
    expect(tooClose.statusCode).toBe(400);
    const unknown = await app.server.inject({ method: 'POST', url: '/api/print/map', payload: { ...request, sourceId: 'gibtsnicht' }, headers: { cookie } });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('PDF-Text', () => {
  it('ersetzt Zeichen außerhalb von WinAnsi lesbar', () => {
    expect(pdfText('hoch ≥ 1·10⁻³ s/m³')).toBe('hoch >= 1·10^-3 s/m³');
    expect(pdfText('Brandbekämpfung → EA Nord')).toBe('Brandbekämpfung -> EA Nord');
  });
});
