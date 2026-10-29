import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { afterEach, describe, expect, it } from 'vitest';
import type { DockerHost, GeocodeResponse, InstalledAddon, MapSource } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { GeocodeFetch } from '../services/geocoder.js';
import type { OverpassFetch } from '../services/overpass.js';
import type { RouterFetch } from '../services/router.js';
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

const overpassFetch: OverpassFetch = async (url) => {
  calls.push(url);
  return { elements: [] };
};

const routerFetch: RouterFetch = async (url) => {
  calls.push(url);
  return { status: 200, json: { trip: { summary: { length: 1, time: 60 }, legs: [{ shape: '_c`|@_c`|@_ibE_ibE', summary: { length: 1, time: 60 }, maneuvers: [] }] } } };
};

async function setup(builtinDir = BUILTIN) {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-osm-'));
  daemon = new FakeDocker();
  app = await buildApp(parseConfig({ dataDir, addons: { builtinDir }, map: { outlineUrl: null } }), { logger: false, dockerFactory: () => daemon.asDocker(), geocodeFetch, overpassFetch, routerFetch });
  await app.docker!.repos.refresh();
  cookie = await adminCookie(app);
}

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  calls.length = 0;
});

const req = async <T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: (res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) as T };
};

async function addHost(): Promise<DockerHost> {
  return (await req<{ host: DockerHost }>('POST', '/api/docker/hosts', { certMode: 'custom', name: 'server2', address: '10.0.0.2', caPem: PEM, certPem: PEM, keyPem: PEM })).body.host;
}

async function waitFor(id: string, done: (a: InstalledAddon) => boolean): Promise<InstalledAddon> {
  for (let i = 0; i < 150; i++) {
    const { body } = await req<InstalledAddon>('GET', `/api/addons/${id}`);
    if (done(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Zeitüberschreitung: ${JSON.stringify((await req('GET', `/api/addons/${id}`)).body).slice(0, 1200)}`);
}

const SERVICES = ['tiles', 'nominatim', 'valhalla', 'overpass'];
const states = () => SERVICES.map((n) => daemon.byName(`elvis-osm-daten-${n}`)!.state);

describe('OSM-Daten-Addon', () => {
  it('baut alle Dienste aus denselben Regionen und startet sie erst danach', async () => {
    await setup();
    // Vorher: öffentlicher Suchdienst, kein Umriss (öffentliches Nominatim hier abgeschaltet)
    expect((await req<GeocodeResponse>('GET', '/api/map/search?q=Lange')).body.source).toBe('photon.komoot.io');
    expect((await req('GET', '/api/map/outline/R1461203')).status).toBe(404);
    // Overpass: öffentlich, solange das Addon nicht bereit ist
    expect((await req('GET', '/api/map/overpass/status')).body).toEqual({ source: 'online', name: 'overpass-api.de' });
    // Routing gibt es nur lokal
    expect((await req('GET', '/api/map/router')).body).toEqual({ available: false, name: null });

    const host = await addHost();
    const res = await req('POST', '/api/addons', {
      addonId: 'osm-daten',
      hostId: host.id,
      options: { regions: ['europe/germany/niedersachsen', 'europe/luxembourg'], extraRegions: 'africa/mali' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const done = await waitFor('osm-daten', (a) => a.jobs[0]?.state === 'succeeded' && a.status === 'running');
    expect(done.jobs[0]!.steps.every((s) => s.state === 'done')).toBe(true);
    expect(done.jobs[0]!.steps).toHaveLength(8);
    expect(done.jobs[0]!.triggeredBy).toBe('Max Müller (Installation)');
    // Keine automatische Aktualisierung
    expect(done.jobs[0]!.schedule).toBeNull();

    const archive = daemon.archives.find((a) => a.volume === 'elvis-addon-osm-daten-data');
    expect(archive?.entries).toEqual(expect.arrayContaining(['addon/scripts/regions.sh', 'addon/scripts/nominatim.sh', 'addon/scripts/valhalla.sh', 'addon/styles/dunkel.json', 'addon/styles/druck.json']));

    // Regionen gelangen als Listen in den Download-Schritt
    const download = daemon.byName('elvis-osm-daten-job-build-1')!.spec;
    expect(download.Env).toEqual(expect.arrayContaining(['REGIONS=europe/germany/niedersachsen,europe/luxembourg', 'EXTRA_REGIONS=africa/mali', 'REFRESH=false']));
    // Alle Dienste lesen dieselbe zusammengeführte Datei
    expect(daemon.byName('elvis-osm-daten-job-build-4')!.spec.Cmd).toContain('--osm-path=/data/work/input.osm.pbf');
    const search = daemon.byName('elvis-osm-daten-job-build-6')!.spec;
    expect(search.Env).toEqual(expect.arrayContaining(['PBF_PATH=/data/work/input.osm.pbf', 'UPDATE_MODE=none', 'POSTGRES_SHARED_BUFFERS=2GB']));
    expect(search.Env!.some((e) => e.startsWith('REPLICATION_URL='))).toBe(false);
    expect(search.HostConfig?.Binds).toEqual(['elvis-addon-osm-daten-nominatim-db:/var/lib/postgresql/16/main', 'elvis-addon-osm-daten-data:/data:ro']);
    expect(daemon.byName('elvis-osm-daten-job-build-8')!.spec.HostConfig?.Binds).toEqual(['elvis-addon-osm-daten-data:/data', 'elvis-addon-osm-daten-overpass:/db']);

    // Beim ersten Bau lief die Ortssuche noch nicht – nichts anzuhalten
    expect(daemon.stops).toEqual([]);
    expect(states()).toEqual(['running', 'running', 'running', 'running']);

    // Kartenvarianten angemeldet (ohne Cache)
    const sources = (await req<MapSource[]>('GET', '/api/map/sources')).body;
    expect(sources.filter((s) => s.id.startsWith('osm-daten-')).map((s) => [s.id, s.variant])).toEqual([
      ['osm-daten-standard', 'light'],
      ['osm-daten-dunkel', 'dark'],
      ['osm-daten-druck', 'print'],
    ]);

    // Suche und Umrisse gehen jetzt an das lokale Nominatim
    const local = (await req<GeocodeResponse>('GET', '/api/map/search?q=Barnstorf&lat=52.7&lon=8.5')).body;
    expect(local).toMatchObject({ source: 'Ortssuche (lokal)', results: [{ name: 'Barnstorf', kind: 'city', osm: 'R1461203' }] });
    expect(calls.at(-1)).toMatch(/^http:\/\/10\.0\.0\.2:8088\/search\?q=Barnstorf&format=jsonv2/);
    expect((await req<{ type: string }>('GET', '/api/map/outline/R1461203')).body.type).toBe('Polygon');

    // Overpass-Abfragen gehen an die lokale Overpass-API
    expect((await req('GET', '/api/map/overpass/status')).body).toEqual({ source: 'local', name: 'Overpass (lokal)' });
    const query = { name: 'Tankstellen', mode: 'simple', filters: [{ key: 'amenity', op: '=', value: 'fuel' }] };
    expect((await req('POST', '/api/map/overpass', { query, bounds: { s: 52.6, w: 8.4, n: 52.8, e: 8.6 } })).body).toMatchObject({ source: 'local', sourceName: 'Overpass (lokal)' });
    expect(calls.at(-1)).toBe('http://10.0.0.2:8089/api/interpreter');

    // Routen rechnet das lokale Valhalla
    expect((await req('GET', '/api/map/router')).body).toEqual({ available: true, name: 'Routing (lokal)' });
    const stops = [{ lat: 52.7, lon: 8.5, name: 'A' }, { lat: 52.71, lon: 8.51, name: 'B' }];
    expect((await req('POST', '/api/map/route', { stops })).status).toBe(200);
    expect(calls.at(-1)).toBe('http://10.0.0.2:8002/route');

    const log = (await req<string>('GET', '/api/addons/osm-daten/logs?target=job:build')).body;
    expect(log).toContain('=== Schritt 5: Routing bauen ===');

    // Nach dem Deinstallieren wieder der öffentliche Dienst
    expect((await req('DELETE', '/api/addons/osm-daten')).status).toBeLessThan(300);
    for (let i = 0; i < 50 && (await req<GeocodeResponse>('GET', '/api/map/search?q=Lange')).body.source !== 'photon.komoot.io'; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await req<GeocodeResponse>('GET', '/api/map/search?q=Lange')).body.source).toBe('photon.komoot.io');
  });

  it('hält beim erneuten Bau die Ortssuche für ihren Schritt an und startet danach alles neu', async () => {
    await setup();
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'osm-daten', hostId: host.id, options: {} });
    await waitFor('osm-daten', (a) => a.jobs[0]?.state === 'succeeded' && a.status === 'running');

    // Region ergänzen und neu bauen
    expect((await req('PATCH', '/api/addons/osm-daten', { options: { regions: ['europe/germany', 'europe/austria'] } })).status).toBeLessThan(300);
    await waitFor('osm-daten', (a) => a.status === 'running');
    expect((await req('POST', '/api/addons/osm-daten/jobs/build')).status).toBe(202);
    await waitFor('osm-daten', (a) => a.jobs[0]?.state === 'succeeded' && a.jobs[0]?.triggeredBy === 'Max Müller' && a.status === 'running');
    expect(daemon.stops).toEqual(['elvis-osm-daten-nominatim']);
    expect(daemon.byName('elvis-osm-daten-job-build-1')!.spec.Env).toContain('REGIONS=europe/germany,europe/austria');
    expect(states()).toEqual(['running', 'running', 'running', 'running']);
  });

  it('startet die angehaltene Ortssuche auch nach einem Fehler wieder', async () => {
    await setup();
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'osm-daten', hostId: host.id, options: {} });
    await waitFor('osm-daten', (a) => a.jobs[0]?.state === 'succeeded' && a.status === 'running');

    daemon.failingJob = 'elvis-osm-daten-job-build-6';
    await req('POST', '/api/addons/osm-daten/jobs/build');
    const failed = await waitFor('osm-daten', (a) => a.jobs[0]?.state === 'failed' && a.status === 'running');
    expect(failed.jobs[0]!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'error', 'pending', 'pending']);
    expect(daemon.stops).toEqual(['elvis-osm-daten-nominatim']);
    expect(daemon.byName('elvis-osm-daten-nominatim')!.state).toBe('running');
  });

  it('meldet einen fehlgeschlagenen ersten Bau und lässt die Dienste warten', async () => {
    await setup();
    daemon.jobExitCode = 1;
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'osm-daten', hostId: host.id, options: {} });
    const failed = await waitFor('osm-daten', (a) => a.jobs[0]?.state === 'failed');
    expect(failed.jobs[0]!.steps[0]!.state).toBe('error');
    expect(failed.status).toBe('waiting');
    expect(failed.error).toMatch(/Wartet auf erfolgreichen Lauf/);
    expect(states()).toEqual(['created', 'created', 'created', 'created']);
    // Starten wird ohne Daten übersprungen
    await req('POST', '/api/addons/osm-daten/start');
    expect(states()).toEqual(['created', 'created', 'created', 'created']);
  });
});

describe('Job-Verwaltung', () => {
  function repoWith(manifest: string[]): string {
    const repo = mkdtempSync(join(tmpdir(), 'elvis-repo-'));
    mkdirSync(join(repo, 'demo'));
    writeFileSync(join(repo, 'repository.yaml'), 'name: Test\naddons: [demo]\n');
    writeFileSync(join(repo, 'demo', 'addon.yaml'), ['id: demo', 'name: Demo', 'version: 1.0.0', 'containers: [{ name: app, image: demo:1 }]', ...manifest].join('\n'));
    return repo;
  }

  it('führt fällige Zeitplan-Jobs aus', async () => {
    const repo = repoWith(['jobs:', '  run: { label: Lauf, image: demo:1, schedule: { interval: daily, hour: 3 } }']);
    await setup(repo);
    daemon.images.add('demo:1');
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'demo', hostId: host.id, options: {} });
    await waitFor('demo', (a) => a.status === 'running');
    // Noch nie gelaufen, aber seit der Installation kein Termin verstrichen
    const db = (app.docker!.addons as unknown as { db: import('../db/index.js').Db }).db;
    db.prepare("UPDATE addons SET installed_at = datetime('now', '-2 days')").run();
    expect(await app.docker!.addons.runScheduledJobs()).toEqual(['demo/run']);
    const ran = await waitFor('demo', (a) => a.jobs[0]?.state === 'succeeded' && a.jobs[0]?.triggeredBy === 'Zeitplan');
    expect(ran.jobs[0]!.schedule?.nextRun).toBeTruthy();
    expect(await app.docker!.addons.runScheduledJobs()).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it('verweigert Neukonfiguration, solange ein Job läuft', async () => {
    const repo = repoWith(['jobs:', '  run: { label: Lauf, image: demo:1, command: ["ELVIS_PROGRESS 40 halb"] }']);
    await setup(repo);
    daemon.images.add('demo:1');
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'demo', hostId: host.id, options: {} });
    await waitFor('demo', (a) => a.status === 'running');
    const started = await req<InstalledAddon>('POST', '/api/addons/demo/jobs/run');
    expect(started.status).toBe(202);
    expect(started.body.jobs[0]!.state).toBe('running');
    expect((await req('PATCH', '/api/addons/demo', { options: {} })).status).toBe(409);
    await waitFor('demo', (a) => a.jobs[0]?.state === 'succeeded');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('Eigene Stile', () => {
  it.each(['dunkel', 'druck'])('%s ist ein gültiger MapLibre-Stil, der nur lokale Quellen und Schriften verwendet', (name) => {
    const style = JSON.parse(readFileSync(join(BUILTIN, `osm-daten/files/styles/${name}.json`), 'utf8'));
    expect(validateStyleMin(style)).toEqual([]);
    expect(style.sources.openmaptiles.url).toBe('mbtiles://{openmaptiles}');
    const fonts = new Set<string>();
    for (const l of style.layers) for (const f of l.layout?.['text-font'] ?? []) fonts.add(f);
    // nur Schriften aus dem OpenMapTiles-Schriftpaket v2.0
    expect([...fonts].every((f) => ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'].includes(f))).toBe(true);
  });
});
