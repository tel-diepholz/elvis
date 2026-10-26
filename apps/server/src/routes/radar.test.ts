import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RadarFrames } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { RadarFetch } from '../services/radar.js';

let app: App;
let dataDir: string;

const caps = `<WMS_Capabilities><Layer><Name>Niederschlagsradar</Name>
  <Dimension name="time" units="ISO8601">2026-10-23T00:00:00.000Z/2026-10-26T18:30:00.000Z/PT5M</Dimension>
  <Dimension name="REFERENCE_TIME" default="2026-10-26T16:30:00.000Z" units="ISO8601">2026-10-26T16:30:00.000Z</Dimension>
</Layer></WMS_Capabilities>`;

const radarFetch: RadarFetch = async (url) =>
  url.includes('GetCapabilities')
    ? { status: 200, contentType: 'application/xml', body: Buffer.from(caps) }
    : { status: 200, contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-radar-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false, radarFetch });
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const get = (url: string) => app.server.inject({ method: 'GET', url });

describe('Regenradar-Routen', () => {
  it('liefert Zeitschritte ohne Anmeldung', async () => {
    const res = await get('/api/map/radar');
    expect(res.statusCode).toBe(200);
    const body = res.json<RadarFrames>();
    expect(body.reference).toBe('2026-10-26T16:30:00.000Z');
    expect(body.frames).toContain('2026-10-26T18:30:00.000Z');
    expect(body.attribution).toContain('Wetterdienst');
  });

  it('liefert Kacheln mit passender Cache-Dauer', async () => {
    const measured = await get('/api/map/radar/2026-10-26T16:00:00.000Z/8/134/83');
    expect(measured.statusCode).toBe(200);
    expect(measured.headers['content-type']).toBe('image/png');
    expect(measured.headers['cache-control']).toBe('public, max-age=86400');
    const forecast = await get('/api/map/radar/2026-10-26T17:00:00.000Z/8/134/83');
    expect(forecast.headers['cache-control']).toBe('public, max-age=120');
    expect((await get('/api/map/radar/2026-10-26T16:02:00.000Z/8/134/83')).statusCode).toBe(404);
    expect((await get('/api/map/radar/legend')).statusCode).toBe(200);
  });
});
