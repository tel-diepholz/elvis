import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceSnapshot, DockerHost, InstalledAddon, MessengerState } from '@elvis/shared';
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

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = async <T = unknown>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: (res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) as T };
};

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Zeitüberschreitung: ${JSON.stringify(await fn()).slice(0, 1500)}`);
}

describe('Signal-Addon (signal-cli)', () => {
  it('baut das Image, gibt dem Container das Token und meldet den Dienst an das Modul Signal', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'elvis-signal-addon-'));
    daemon = new FakeDocker();
    app = await buildApp(parseConfig({ dataDir, addons: { builtinDir: BUILTIN } }), { logger: false, dockerFactory: () => daemon.asDocker() });
    await app.docker!.repos.refresh();
    cookie = await adminCookie(app);
    const host = (await req<{ host: DockerHost }>('POST', '/api/docker/hosts', { certMode: 'custom', name: 'server2', address: '10.0.0.2', caPem: PEM, certPem: PEM, keyPem: PEM })).body.host;

    // Anleitung im Store, schon vor der Installation
    const store = (await req<{ manifest: { id: string } | null; hasDocs: boolean }[]>('GET', '/api/addons/store')).body;
    expect(store.find((e) => e.manifest?.id === 'signal-cli')?.hasDocs).toBe(true);
    expect((await req<{ markdown: string }>('GET', '/api/addons/store/signal-cli/docs')).body.markdown).toContain('Weg B: Eigene Nummer registrieren');
    expect((await req('GET', '/api/addons/store/hello/docs')).status).toBe(404);

    const res = await req('POST', '/api/addons', { addonId: 'signal-cli', hostId: host.id, options: {} });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await until(async () => (await req<InstalledAddon>('GET', '/api/addons/signal-cli')).body, (a) => a.status === 'running');

    const c = [...daemon.containers.values()].find((x) => x.name === 'elvis-signal-cli-daemon')!;
    const env = Object.fromEntries((c.spec.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    expect(env.ELVIS_TOKEN).toMatch(/^\S{16,}$/);
    expect(c.spec.HostConfig?.PortBindings).toEqual({ '8080/tcp': [{ HostPort: '8087' }] });
    // Die Vorlage für nginx liegt im Volume unter addon/ – der Container liest sie unter /data/addon/
    expect(c.spec.HostConfig?.Binds).toContain('elvis-addon-signal-cli-addon:/data:ro');
    expect(readFileSync(join(BUILTIN, 'signal-cli/files/docker/entrypoint.sh'), 'utf8')).toContain('TEMPLATE=/data/addon/nginx.conf.template');

    // Modul Signal mit Treiber signal-cli: nutzt den Dienst des Addons
    expect((await req('PUT', '/api/system/devices/signal', { enabled: true, driver: 'signal-cli', options: {} })).status).toBe(200);
    const signal = await until(async () => (await req<DeviceSnapshot<'signal'>>('GET', '/api/devices/signal')).body, (d) => d.driver === 'signal-cli' && (d.state as MessengerState).link?.target === 'http://10.0.0.2:8087');
    expect((signal.state as MessengerState).link?.connected).toBe(false);
  }, 20_000);
});
