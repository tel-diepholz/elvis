import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DockerHost, GeocodeResponse, InstalledAddon } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { GeocodeFetch } from '../services/geocoder.js';
import { adminCookie } from '../test-helpers.js';
import { FakeDocker } from './fake-docker.js';

const BUILTIN = fileURLToPath(new URL('../../../../addons', import.meta.url));
const PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';

let app: App;
let dataDir: string;
let cookie: string;
let daemon: FakeDocker;
const calls: string[] = [];

/** Lokales Nominatim (Addon) und öffentliches Photon liefern unterschiedliche Namen; /lookup liefert einen Umriss */
const geocodeFetch: GeocodeFetch = async (url) => {
  calls.push(url);
  if (url.startsWith('http://10.0.0.2:8088/lookup')) return { type: 'FeatureCollection', features: [{ geometry: { type: 'Polygon', coordinates: [[[8.4, 52.6], [8.5, 52.6], [8.5, 52.7], [8.4, 52.6]]] } }] };
  if (url.startsWith('http://10.0.0.2:8088/search')) return [{ osm_type: 'relation', osm_id: 1461203, lat: '52.7', lon: '8.5', addresstype: 'town', name: 'Barnstorf', place_rank: 16 }];
  return { features: [{ geometry: { coordinates: [8.5, 52.7] }, properties: { osm_type: 'W', osm_id: 1, type: 'street', name: 'Online-Straße' } }] };
};

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  calls.length = 0;
});

const req = async <T = unknown>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: (res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) as T };
};

async function waitFor(id: string, done: (a: InstalledAddon) => boolean): Promise<InstalledAddon> {
  for (let i = 0; i < 150; i++) {
    const { body } = await req<InstalledAddon>('GET', `/api/addons/${id}`);
    if (done(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Zeitüberschreitung: ${JSON.stringify((await req('GET', `/api/addons/${id}`)).body).slice(0, 1200)}`);
}

describe('Ortssuche-Addon', () => {
  it('importiert die Suchdaten, startet Nominatim danach und ersetzt den öffentlichen Dienst', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'elvis-ortssuche-'));
    daemon = new FakeDocker();
    app = await buildApp(parseConfig({ dataDir, addons: { builtinDir: BUILTIN }, map: { outlineUrl: null } }), { logger: false, dockerFactory: () => daemon.asDocker(), geocodeFetch });
    await app.docker!.repos.refresh();
    cookie = await adminCookie(app);

    // Vorher: öffentlicher Dienst, kein Umriss (öffentliches Nominatim hier abgeschaltet)
    expect((await req<GeocodeResponse>('GET', '/api/map/search?q=Lange')).body.source).toBe('photon.komoot.io');
    expect((await req('GET', '/api/map/outline/R1461203')).status).toBe(404);

    const host = (await req<{ host: DockerHost }>('POST', '/api/docker/hosts', { certMode: 'custom', name: 'server2', address: '10.0.0.2', caPem: PEM, certPem: PEM, keyPem: PEM })).body.host;
    const res = await req('POST', '/api/addons', { addonId: 'ortssuche', hostId: host.id, options: { region: 'germany/niedersachsen' } });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const done = await waitFor('ortssuche', (a) => a.jobs[0]?.state === 'succeeded' && a.status === 'running');
    expect(done.jobs[0]!.steps.map((s) => s.state)).toEqual(['done']);

    // Import-Skript im Volume, Job mit Region, Replikation und mehr Shared Memory
    const archive = daemon.archives.find((a) => a.volume === 'elvis-addon-ortssuche-scripts');
    expect(archive?.entries).toEqual(expect.arrayContaining(['addon/scripts/import.sh']));
    const job = daemon.byName('elvis-ortssuche-job-import-1')!.spec;
    expect(job.Cmd).toEqual(['bash', '/elvis/addon/scripts/import.sh']);
    expect(job.Env).toEqual(
      expect.arrayContaining([
        'PBF_URL=https://download.geofabrik.de/europe/germany/niedersachsen-latest.osm.pbf',
        'REPLICATION_URL=https://download.geofabrik.de/europe/germany/niedersachsen-updates/',
        'IMPORT_STYLE=full',
        'POSTGRES_SHARED_BUFFERS=2GB',
      ]),
    );
    expect(job.HostConfig?.ShmSize).toBe(2 * 1024 ** 3);
    expect(job.HostConfig?.Binds).toEqual(['elvis-addon-ortssuche-db:/var/lib/postgresql/16/main', 'elvis-addon-ortssuche-scripts:/elvis:ro']);

    // Suchdienst läuft erst jetzt, auf derselben Datenbank, mit laufender Replikation
    const server = daemon.byName('elvis-ortssuche-nominatim')!;
    expect(server.state).toBe('running');
    expect(server.spec.Env).toEqual(expect.arrayContaining(['UPDATE_MODE=continuous']));
    expect(server.spec.HostConfig?.ShmSize).toBe(1024 ** 3);

    // Suche und Umrisse gehen jetzt an das lokale Nominatim
    const local = (await req<GeocodeResponse>('GET', '/api/map/search?q=Barnstorf&lat=52.7&lon=8.5')).body;
    expect(local).toMatchObject({ source: 'Ortssuche (lokal)', results: [{ name: 'Barnstorf', kind: 'city', osm: 'R1461203' }] });
    expect(calls.at(-1)).toMatch(/^http:\/\/10\.0\.0\.2:8088\/search\?q=Barnstorf&format=jsonv2/);
    const outline = await req<{ type: string }>('GET', '/api/map/outline/R1461203');
    expect(outline.status).toBe(200);
    expect(outline.body.type).toBe('Polygon');

    // Nach dem Deinstallieren wieder der öffentliche Dienst
    expect((await req('DELETE', '/api/addons/ortssuche')).status).toBeLessThan(300);
    for (let i = 0; i < 50 && (await req<GeocodeResponse>('GET', '/api/map/search?q=Lange')).body.source !== 'photon.komoot.io'; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await req<GeocodeResponse>('GET', '/api/map/search?q=Lange')).body.source).toBe('photon.komoot.io');
  });
});
