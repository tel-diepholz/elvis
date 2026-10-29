import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tar from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { GeorefJob, GeorefPage, GeorefStatus, Incident, IncidentDocument, MapObject } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { FakeDocker } from '../addons/fake-docker.js';
import { GEOREF_IMAGE } from '../services/georef.js';
import { adminCookie } from '../test-helpers.js';

const PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';

let app: App;
let dataDir: string;
let admin = '';
let daemon: FakeDocker;

async function setup(docker = true) {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-georef-'));
  daemon = new FakeDocker();
  app = await buildApp(parseConfig({ dataDir, docker: { enabled: docker } }), { logger: false, dockerFactory: () => daemon.asDocker() });
  admin = await adminCookie(app);
  if (docker) expect((await req('POST', '/api/docker/hosts', { certMode: 'custom', name: 'server1', address: '10.0.0.1', caPem: PEM, certPem: PEM, keyPem: PEM })).status).toBe(201);
}

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie: admin } });
  const json = res.headers['content-type']?.toString().includes('json');
  return { status: res.statusCode, body: (json ? res.json() : res.rawPayload) as T };
}

async function upload(incidentId: number, name: string, type: string): Promise<IncidentDocument> {
  const boundary = '----elvis' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
    Buffer.from('%PDF-1.4 Lageplan'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.server.inject({ method: 'POST', url: `/api/incidents/${incidentId}/documents`, payload, headers: { cookie: admin, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  expect(res.statusCode).toBe(201);
  return res.json() as IncidentDocument;
}

/** PNG-Kopf mit Signatur und IHDR – mehr liest der Dienst nicht */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

async function tarOf(files: Record<string, Buffer>): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, data] of Object.entries(files)) pack.entry({ name }, data);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const tileOf = (lat: number, lon: number, z: number) => {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
};

/** Ausgeführte Skripte der GDAL-Container */
let scripts: string[] = [];

/** GDAL-Container nachstellen: Seiten bzw. Kacheln je nach Skript */
function fakeGdal() {
  scripts = [];
  daemon.archiveOut = (path, c) => {
    expect(path).toBe('/tmp/work/out');
    const script = (c.spec as { Cmd: string[] }).Cmd[2]!;
    scripts.push(script);
    if (script.includes('gdal2tiles')) {
      const [, min, max] = /-z (\d+)-(\d+)/.exec(script)!.map(Number) as [number, number, number];
      const files: Record<string, Buffer> = { 'out/tilemapresource.xml': Buffer.from('<x/>') };
      for (const z of [min, max]) {
        const t = tileOf(52.6, 8.37, z);
        files[`out/${z}/${t.x}/${t.y}.png`] = png(256, 256);
        files[`out/${z}/${t.x + 1}/${t.y}.png`] = png(256, 256);
      }
      return tarOf(files);
    }
    return tarOf({ 'out/1.png': png(800, 600), 'out/1.thumb.png': png(240, 180), 'out/2.png': png(600, 800), 'out/2.thumb.png': png(180, 240) });
  };
}

async function waitJob(id: string): Promise<GeorefJob> {
  for (let i = 0; i < 200; i++) {
    const { body } = await req<GeorefJob>('GET', `/api/georef/jobs/${id}`);
    if (body.state === 'done' || body.state === 'failed') return body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Zeitüberschreitung');
}

/** 1 px ≈ 1 m rund um Diepholz, Norden oben */
const GCPS = [
  { x: 0, y: 0, lat: 52.6027, lon: 8.3700 },
  { x: 800, y: 0, lat: 52.6027, lon: 8.3818 },
  { x: 0, y: 600, lat: 52.5973, lon: 8.3700 },
  { x: 800, y: 600, lat: 52.5973, lon: 8.3818 },
];

describe('PDF in Karte integrieren', () => {
  it('ist ohne Docker nicht verfügbar', async () => {
    await setup(false);
    expect((await req<GeorefStatus>('GET', '/api/georef/status')).body).toEqual({ available: false, reason: 'Docker ist in ELVIS abgeschaltet' });
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const doc = await upload(incident.id, 'Plan.pdf', 'application/pdf');
    expect((await req('POST', `/api/documents/${doc.id}/georef/pages`)).status).toBe(409);
  });

  it('rendert die Seiten, legt ein Overlay mit Kacheln an und räumt beim Entfernen auf', async () => {
    await setup();
    fakeGdal();
    expect((await req<GeorefStatus>('GET', '/api/georef/status')).body.available).toBe(true);
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const doc = await upload(incident.id, 'Plan.pdf', 'application/pdf');

    const render = await req<GeorefJob>('POST', `/api/documents/${doc.id}/georef/pages`);
    expect(render.status).toBe(202);
    expect((await waitJob(render.body.id)).state).toBe('done');
    expect(daemon.images.has(GEOREF_IMAGE)).toBe(true);
    expect([...daemon.uploads.values()][0]).toEqual(['work/', 'work/in.pdf']);
    expect(daemon.containers.size).toBe(0);
    expect((await req<GeorefPage[]>('GET', `/api/documents/${doc.id}/georef/pages`)).body).toEqual([
      { page: 1, width: 800, height: 600 },
      { page: 2, width: 600, height: 800 },
    ]);
    expect((await req('GET', `/api/documents/${doc.id}/georef/pages/2?thumb=1`)).status).toBe(200);
    expect((await req('GET', `/api/documents/${doc.id}/georef/pages/3`)).status).toBe(404);

    expect((await req('POST', `/api/documents/${doc.id}/georef/overlay`, { page: 1, name: 'Lageplan', gcps: GCPS.slice(0, 2) })).status).toBe(400);
    // Legende unten rechts wegschneiden; was über die Seite (800 × 600) hinausragt, fällt weg
    const make = await req<GeorefJob>('POST', `/api/documents/${doc.id}/georef/overlay`, {
      page: 1,
      name: 'Lageplan',
      gcps: GCPS,
      cuts: [[600, 450, 900, 700]],
      outline: [[100, 100], [500, 100], [500, 400], [100, 400]],
      background: { color: '#ffffff', tolerance: 40 },
      erase: [{ width: 30, points: [[50, 500], [300, 520]] }],
    });
    expect(make.status).toBe(202);
    const done = await waitJob(make.body.id);
    expect(done).toMatchObject({ state: 'done', kind: 'overlay' });
    expect(scripts.at(-1)).toContain("json.load(open('prep.json'))");
    expect(scripts.at(-1)).toContain('page.tif gcp.vrt');
    expect([...daemon.uploads.values()].at(-1)).toEqual(['work/', 'work/page.png', 'work/prep.json']);

    const objects = (await req<MapObject[]>('GET', `/api/incidents/${incident.id}/objects`)).body;
    const overlay = objects.find((o) => o.id === done.objectId)!;
    expect(overlay).toMatchObject({ kind: 'overlay', name: 'Lageplan', data: { documentId: doc.id, filename: 'Plan.pdf', page: 1, opacity: 0.8, cuts: [[600, 450, 800, 600]], background: { color: '#ffffff', tolerance: 40 }, erased: 1 } });
    if (overlay.kind !== 'overlay') throw new Error('kein Overlay');
    const { minZoom, maxZoom, bounds } = overlay.data;
    expect(maxZoom - minZoom).toBe(8);
    expect(bounds[0][0]).toBeLessThan(52.6);
    expect(bounds[1][0]).toBeGreaterThan(52.6);
    const t = tileOf(52.6, 8.37, maxZoom);
    expect((await req('GET', `/api/map/overlays/${overlay.id}/${maxZoom}/${t.x}/${t.y}`)).status).toBe(200);

    // Nur die Deckkraft ist änderbar
    expect((await req<MapObject>('PATCH', `/api/map-objects/${overlay.id}`, { data: { opacity: 0.5 } })).body.data).toMatchObject({ opacity: 0.5 });
    expect((await req('PATCH', `/api/map-objects/${overlay.id}`, { lat: 52 })).status).toBe(400);
    expect((await req('PATCH', `/api/map-objects/${overlay.id}`, { data: { sectorM: 500 } })).status).toBe(400);

    expect((await req('DELETE', `/api/map-objects/${overlay.id}`)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect((await req('GET', `/api/map/overlays/${overlay.id}/${maxZoom}/${t.x}/${t.y}`)).status).toBe(404);
  });

  it('nimmt nur PDFs und lässt Overlays nicht direkt anlegen', async () => {
    await setup();
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const doc = await upload(incident.id, 'Notiz.txt', 'text/plain');
    expect((await req('POST', `/api/documents/${doc.id}/georef/pages`)).status).toBe(400);
    const direct = await req('POST', `/api/incidents/${incident.id}/objects`, { kind: 'overlay', name: 'X', lat: 52, lon: 8, data: {} });
    expect(direct.status).toBe(400);
  });

  it('meldet Fehler von GDAL am Lauf', async () => {
    await setup();
    daemon.archiveOut = () => null;
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const doc = await upload(incident.id, 'Plan.pdf', 'application/pdf');
    const job = await waitJob((await req<GeorefJob>('POST', `/api/documents/${doc.id}/georef/pages`)).body.id);
    expect(job.state).toBe('failed');
    expect((await req<GeorefPage[]>('GET', `/api/documents/${doc.id}/georef/pages`)).body).toEqual([]);
  });
});
