import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DockerHost, HostSetup, InstalledAddon, MapSource } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { FakeDocker } from './fake-docker.js';
import { adminCookie } from '../test-helpers.js';

const BUILTIN = fileURLToPath(new URL('../../../../addons', import.meta.url));
const PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
let headers: Record<string, string> = {};

let app: App;
let dataDir: string;
let daemons: Map<string, FakeDocker>;

async function setup(opts: { builtinDir?: string; dockerEnabled?: boolean } = {}) {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-addons-'));
  daemons = new Map();
  app = await buildApp(parseConfig({ dataDir, docker: { enabled: opts.dockerEnabled ?? true }, addons: { builtinDir: opts.builtinDir ?? BUILTIN } }), {
    logger: false,
    dockerFactory: (c) => {
      const d = daemons.get(c.host);
      if (!d) throw new Error(`kein Fake-Daemon für ${c.host}`);
      return d.asDocker();
    },
  });
  await app.docker?.repos.refresh();
  headers = { cookie: await adminCookie(app) };
}

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = async <T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.server.inject({ method, url, payload: payload as object, headers });
  return { status: res.statusCode, body: (res.body && res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) as T };
};

async function addHost(name: string, address: string, daemon: FakeDocker): Promise<DockerHost> {
  daemons.set(address, daemon);
  const res = await req<{ host: DockerHost }>('POST', '/api/docker/hosts', { certMode: 'custom', name, address, caPem: PEM, certPem: PEM, keyPem: PEM });
  expect(res.status).toBe(201);
  return res.body.host;
}

async function waitFor(id: string, done: (a: InstalledAddon) => boolean): Promise<InstalledAddon> {
  for (let i = 0; i < 100; i++) {
    const { body } = await req<InstalledAddon>('GET', `/api/addons/${id}`);
    if (done(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Zeitüberschreitung: ${JSON.stringify((await req('GET', `/api/addons/${id}`)).body).slice(0, 1500)}`);
}

describe('Docker-Hosts', () => {
  it('verbindet einen Host mit eigenen Zertifikaten und liest Version und Architektur', async () => {
    await setup();
    const host = await addHost('server2', '10.0.0.2', new FakeDocker());
    expect(host).toMatchObject({ status: 'ready', dockerVersion: '27.3.1', arch: 'amd64', certMode: 'custom' });
  });

  it('liefert das Setup-Skript genau einmal aus', async () => {
    await setup();
    const { body } = await req<HostSetup>('POST', '/api/docker/hosts', { certMode: 'elvis', name: 'server1', address: '10.0.0.1' });
    expect(body.host.status).toBe('pending');
    const token = /setup\/([\w-]+)\.sh/.exec(body.command)![1];
    const first = await req<string>('GET', `/api/docker/setup/${token}.sh`);
    expect(first.status).toBe(200);
    expect(first.body).toContain('BEGIN CERTIFICATE');
    expect(first.body).toContain(`/api/docker/setup/${token}/done`);
    expect((await req('GET', `/api/docker/setup/${token}.sh`)).status).toBe(410);
    expect((await req('GET', '/api/docker/setup/gibtsnicht.sh')).status).toBe(404);
  });

  it('lässt sich ohne Addons entfernen', async () => {
    await setup();
    const host = await addHost('server2', '10.0.0.2', new FakeDocker());
    expect((await req('DELETE', `/api/docker/hosts/${host.id}`)).status).toBe(204);
  });
});

describe('Addon-Lebenszyklus', () => {
  it('installiert, konfiguriert, führt Jobs aus und deinstalliert „hello“', async () => {
    await setup();
    const daemon = new FakeDocker();
    const host = await addHost('server2', '10.0.0.2', daemon);

    const store = await req<{ manifest: { id: string } | null; installedVersion: string | null }[]>('GET', '/api/addons/store');
    expect(store.body.find((e) => e.manifest?.id === 'hello')?.installedVersion).toBeNull();

    const install = await req<InstalledAddon>('POST', '/api/addons', { addonId: 'hello', hostId: host.id, options: { name: 'ELW Test', port: 8123 } });
    expect(install.status).toBe(202);
    const running = await waitFor('hello', (a) => a.status === 'running');
    expect(running.operation?.steps.every((s) => s.state === 'done')).toBe(true);

    const web = daemon.byName('elvis-hello-web')!;
    expect(web.state).toBe('running');
    expect(web.spec.Env).toContain('WHOAMI_NAME=ELW Test');
    expect(web.spec.Labels).toMatchObject({ 'elvis.addon': 'hello', 'elvis.addon.version': '1.0.0' });
    expect(web.spec.HostConfig).toMatchObject({ PortBindings: { '8080/tcp': [{ HostPort: '8123' }] }, Privileged: false });
    expect(daemon.volumes.has('elvis-addon-hello-data')).toBe(true);

    // Optionen ändern → Container wird neu erstellt
    expect((await req('PATCH', '/api/addons/hello', { options: { name: 'Neu', port: 8123, verbose: true } })).status).toBe(202);
    await waitFor('hello', (a) => a.status === 'running' && a.options.name === 'Neu' && !!a.operation?.finishedAt);
    expect(daemon.byName('elvis-hello-web')!.spec.Env).toContain('WHOAMI_NAME=Neu');

    // Job
    expect((await req('POST', '/api/addons/hello/jobs/stamp')).status).toBe(202);
    await waitFor('hello', (a) => a.jobs[0]?.state === 'succeeded');
    const jobLog = await req<string>('GET', '/api/addons/hello/logs?target=job:stamp');
    expect(jobLog.body).toContain('Neu');

    // Stop / Start
    expect((await req<InstalledAddon>('POST', '/api/addons/hello/stop')).body.status).toBe('stopped');
    expect((await req<InstalledAddon>('POST', '/api/addons/hello/start')).body.status).toBe('running');

    // Host mit Addon kann nicht entfernt werden
    expect((await req('DELETE', `/api/docker/hosts/${host.id}`)).status).toBe(409);

    // Deinstallieren inkl. Daten
    expect((await req('DELETE', '/api/addons/hello?data=1')).status).toBe(204);
    expect(daemon.containers.size).toBe(0);
    expect(daemon.volumes.size).toBe(0);

    const audit = await req<{ target: string; action: string }[]>('GET', '/api/audit');
    expect(audit.body.filter((a) => a.target === 'addon:hello').map((a) => a.action)).toEqual(
      expect.arrayContaining(['install', 'reconfigure', 'job:stamp', 'stop', 'start', 'uninstall']),
    );
  });

  it('weist ungültige Optionen vor der Installation ab', async () => {
    await setup();
    const host = await addHost('server2', '10.0.0.2', new FakeDocker());
    const res = await req<{ error: string }>('POST', '/api/addons', { addonId: 'hello', hostId: host.id, options: { name: '', port: 80 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Name: Pflichtfeld/);
    expect(res.body.error).toMatch(/Port auf dem Host: mindestens 1024/);
  });

  it('überträgt Images von einem anderen Host, wenn das Ziel kein Internet hat', async () => {
    await setup();
    const source = new FakeDocker(['traefik/whoami:v1.10', 'alpine:3.20']);
    source.pullable = false;
    const target = new FakeDocker();
    target.pullable = false;
    await addHost('server1', '10.0.0.1', source);
    const t = await addHost('server2', '10.0.0.2', target);
    await req('POST', '/api/addons', { addonId: 'hello', hostId: t.id, options: {} });
    await waitFor('hello', (a) => a.status === 'running');
    expect(target.images.has('traefik/whoami:v1.10')).toBe(true);
  });

  it('rollt bei Fehlern zurück und meldet den Grund', async () => {
    await setup();
    const daemon = new FakeDocker();
    daemon.pullable = false;
    const host = await addHost('server2', '10.0.0.2', daemon);
    await req('POST', '/api/addons', { addonId: 'hello', hostId: host.id, options: {} });
    const failed = await waitFor('hello', (a) => a.status === 'error' && !!a.operation?.finishedAt);
    expect(failed.error).toMatch(/Image nicht verfügbar/);
    expect(daemon.containers.size).toBe(0);
    expect(daemon.volumes.size).toBe(0);
  });

  it('prüft die Architektur des Hosts', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elvis-repo-'));
    mkdirSync(join(repo, 'x86only'));
    writeFileSync(join(repo, 'repository.yaml'), 'name: Test\naddons: [x86only]\n');
    writeFileSync(join(repo, 'x86only', 'addon.yaml'), 'id: x86only\nname: Nur x86\nversion: 1.0.0\narch: [amd64]\ncontainers:\n  - name: app\n    image: demo:1\n');
    await setup({ builtinDir: repo });
    const arm = new FakeDocker();
    arm.arch = 'aarch64';
    const host = await addHost('pi', '10.0.0.9', arm);
    const res = await req<{ error: string }>('POST', '/api/addons', { addonId: 'x86only', hostId: host.id, options: {} });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/amd64/);
    rmSync(repo, { recursive: true, force: true });
  });

  it('meldet Kartenquellen laufender Addons an die Karte', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elvis-repo-'));
    mkdirSync(join(repo, 'tiles'));
    writeFileSync(join(repo, 'repository.yaml'), 'name: Test\naddons: [tiles]\n');
    writeFileSync(
      join(repo, 'tiles', 'addon.yaml'),
      [
        'id: tiles',
        'name: Kartenserver',
        'version: 1.0.0',
        'options:',
        '  port: { type: int, label: Port, default: 8081 }',
        'containers:',
        '  - name: server',
        '    image: tiles:1',
        '    ports: [{ container: 8080, host: "{{options.port}}" }]',
        'provides:',
        '  mapSources:',
        '    - { id: basic, name: Lokale Karte, url: "http://{{host.address}}:{{options.port}}/styles/basic/{z}/{x}/{y}{r}.png", attribution: "© OSM", pixelRatio: 2 }',
      ].join('\n'),
    );
    await setup({ builtinDir: repo });
    const host = await addHost('server2', '10.0.0.2', new FakeDocker(['tiles:1']));
    await req('POST', '/api/addons', { addonId: 'tiles', hostId: host.id, options: {} });
    await waitFor('tiles', (a) => a.status === 'running');
    const sources = await req<MapSource[]>('GET', '/api/map/sources');
    expect(sources.body.map((s) => s.id)).toContain('tiles-basic');
    expect(app.docker!.addons.list()[0]!.status).toBe('running');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('Abschaltbar', () => {
  it('bietet ohne docker.enabled keine Addon-Endpunkte an', async () => {
    await setup({ dockerEnabled: false });
    expect((await req('GET', '/api/addons')).status).toBe(404);
    expect((await req<{ docker: { enabled: boolean } }>('GET', '/api/info')).body.docker.enabled).toBe(false);
  });
});
