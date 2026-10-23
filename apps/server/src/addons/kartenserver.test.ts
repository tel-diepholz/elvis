import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { afterEach, describe, expect, it } from 'vitest';
import type { DockerHost, InstalledAddon, MapSource } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';
import { FakeDocker } from './fake-docker.js';

const BUILTIN = fileURLToPath(new URL('../../../../addons', import.meta.url));
const PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';

let app: App;
let dataDir: string;
let cookie: string;
let daemon: FakeDocker;

async function setup(builtinDir = BUILTIN) {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-karten-'));
  daemon = new FakeDocker();
  app = await buildApp(parseConfig({ dataDir, addons: { builtinDir } }), { logger: false, dockerFactory: () => daemon.asDocker() });
  await app.docker!.repos.refresh();
  cookie = await adminCookie(app);
}

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
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

describe('Kartenserver-Addon', () => {
  it('kopiert Dateien, wartet mit dem Server auf die Kartendaten und startet ihn nach dem ersten Lauf', async () => {
    await setup();
    const host = await addHost();
    const res = await req('POST', '/api/addons', { addonId: 'kartenserver', hostId: host.id, options: { regions: ['germany/thueringen', 'germany/hessen'] } });
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const done = await waitFor('kartenserver', (a) => a.jobs[0]?.state === 'succeeded' && a.status === 'running');
    expect(done.jobs[0]!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(done.jobs[0]!.percent).toBe(100);
    expect(done.jobs[0]!.triggeredBy).toBe('Max Müller (Installation)');
    expect(done.jobs[0]!.schedule).toMatchObject({ interval: 'weekly', hour: 3 });

    // Dateien im Volume
    const archive = daemon.archives.find((a) => a.volume === 'elvis-addon-kartenserver-data');
    expect(archive?.entries).toEqual(expect.arrayContaining(['addon/scripts/download.sh', 'addon/scripts/sources.sh', 'addon/styles/druck.json']));

    // Regionen gelangen als Liste in den Download-Schritt
    const download = daemon.byName('elvis-kartenserver-job-update-3')!;
    expect(download.spec.Env).toContain('REGIONS=germany/thueringen,germany/hessen');
    // Planetiler bekommt die vorab geladenen Zusatzdaten und lädt selbst nichts
    const tiles = daemon.byName('elvis-kartenserver-job-update-4')!.spec;
    expect(tiles.Env).toContain('JAVA_TOOL_OPTIONS=-Xmx4g');
    expect(tiles.Cmd).toEqual(expect.arrayContaining(['--download=false', '--water-polygons-path=/data/sources/water-polygons-split-3857.zip']));

    // Server läuft erst jetzt, Kartenvarianten sind angemeldet (ohne Cache)
    expect(daemon.byName('elvis-kartenserver-server')!.state).toBe('running');
    const sources = (await req<MapSource[]>('GET', '/api/map/sources')).body;
    expect(sources.filter((s) => s.id.startsWith('kartenserver-')).map((s) => [s.id, s.variant])).toEqual([
      ['kartenserver-standard', 'light'],
      ['kartenserver-dunkel', 'dark'],
      ['kartenserver-druck', 'print'],
    ]);

    // Job-Protokoll fasst alle Schritte zusammen
    const log = (await req<string>('GET', '/api/addons/kartenserver/logs?target=job:update')).body;
    expect(log).toContain('=== Schritt 4: Kacheln erzeugen ===');
  });

  it('meldet einen fehlgeschlagenen Schritt und lässt den Server warten', async () => {
    await setup();
    daemon.jobExitCode = 1;
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'kartenserver', hostId: host.id, options: {} });
    const failed = await waitFor('kartenserver', (a) => a.jobs[0]?.state === 'failed');
    expect(failed.jobs[0]!.steps[0]!.state).toBe('error');
    expect(failed.status).toBe('waiting');
    expect(failed.error).toMatch(/Wartet auf erfolgreichen Lauf/);
    expect(daemon.byName('elvis-kartenserver-server')!.state).toBe('created');
    // Starten wird ohne Daten übersprungen
    await req('POST', '/api/addons/kartenserver/start');
    expect(daemon.byName('elvis-kartenserver-server')!.state).toBe('created');
  });

  it('führt fällige Zeitplan-Jobs aus', async () => {
    await setup();
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'kartenserver', hostId: host.id, options: { updateInterval: 'daily', updateHour: 3 } });
    await waitFor('kartenserver', (a) => a.jobs[0]?.state === 'succeeded');
    expect(await app.docker!.addons.runScheduledJobs()).toEqual([]);
    // Letzten Lauf zwei Tage zurückdatieren → fällig
    const db = (app.docker!.addons as unknown as { db: import('../db/index.js').Db }).db;
    db.prepare("UPDATE addon_job_runs SET started_at = datetime('now', '-2 days')").run();
    expect(await app.docker!.addons.runScheduledJobs()).toEqual(['kartenserver/update']);
    const again = await waitFor('kartenserver', (a) => a.jobs[0]?.state === 'succeeded' && a.jobs[0]?.triggeredBy === 'Zeitplan');
    expect(again.jobs[0]!.schedule?.nextRun).toBeTruthy();
  });

  it('verweigert Neukonfiguration, solange ein Job läuft', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elvis-repo-'));
    mkdirSync(join(repo, 'slow'));
    writeFileSync(join(repo, 'repository.yaml'), 'name: Test\naddons: [slow]\n');
    writeFileSync(
      join(repo, 'slow', 'addon.yaml'),
      ['id: slow', 'name: Langsam', 'version: 1.0.0', 'containers: [{ name: app, image: demo:1 }]', 'jobs:', '  run: { label: Lauf, image: demo:1, command: ["ELVIS_PROGRESS 40 halb"] }'].join('\n'),
    );
    await setup(repo);
    daemon.images.add('demo:1');
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'slow', hostId: host.id, options: {} });
    await waitFor('slow', (a) => a.status === 'running');
    const started = await req<InstalledAddon>('POST', '/api/addons/slow/jobs/run');
    expect(started.status).toBe(202);
    expect(started.body.jobs[0]!.state).toBe('running');
    expect((await req('PATCH', '/api/addons/slow', { options: {} })).status).toBe(409);
    await waitFor('slow', (a) => a.jobs[0]?.state === 'succeeded');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('Druckstil', () => {
  it('ist ein gültiger MapLibre-Stil, der nur lokale Quellen und Schriften verwendet', () => {
    const style = JSON.parse(readFileSync(join(BUILTIN, 'kartenserver/files/styles/druck.json'), 'utf8'));
    expect(validateStyleMin(style)).toEqual([]);
    expect(style.sources.openmaptiles.url).toBe('mbtiles://{openmaptiles}');
    const fonts = new Set<string>();
    for (const l of style.layers) for (const f of l.layout?.['text-font'] ?? []) fonts.add(f);
    // nur Schriften aus dem OpenMapTiles-Schriftpaket v2.0
    expect([...fonts].every((f) => ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'].includes(f))).toBe(true);
  });
});
