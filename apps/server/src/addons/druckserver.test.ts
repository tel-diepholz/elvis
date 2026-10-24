import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DockerHost, GuestPrintJob, InstalledAddon, PrintStatus } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';
import { FakeDocker } from './fake-docker.js';

const BUILTIN = fileURLToPath(new URL('../../../../addons', import.meta.url));
const PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
const PDF = Buffer.from('%PDF-1.4\n%%EOF');

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

async function waitFor(id: string, done: (a: InstalledAddon) => boolean): Promise<InstalledAddon> {
  for (let i = 0; i < 200; i++) {
    const { body } = await req<InstalledAddon>('GET', `/api/addons/${id}`);
    if (done(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Zeitüberschreitung: ${JSON.stringify((await req('GET', `/api/addons/${id}`)).body).slice(0, 1500)}`);
}

const container = (name: string) => [...daemon.containers.values()].find((c) => c.name === `elvis-druckserver-${name}`)!;
const env = (name: string) => Object.fromEntries((container(name).spec.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));

describe('Druckserver-Addon mit Gastdrucker', () => {
  it('startet den Gastdrucker im Host-Netz und nimmt dessen Aufträge mit dem Addon-Geheimnis an', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'elvis-druck-'));
    daemon = new FakeDocker();
    app = await buildApp(parseConfig({ dataDir, addons: { builtinDir: BUILTIN } }), { logger: false, dockerFactory: () => daemon.asDocker(), ippTransport: async () => Promise.reject(new Error('offline')) });
    await app.docker!.repos.refresh();
    cookie = await adminCookie(app);
    const host = (await req<{ host: DockerHost }>('POST', '/api/docker/hosts', { certMode: 'custom', name: 'server2', address: '10.0.0.2', caPem: PEM, certPem: PEM, keyPem: PEM })).body.host;

    const res = await req('POST', '/api/addons', {
      addonId: 'druckserver',
      hostId: host.id,
      options: { adminPassword: 'geheim', guestEnabled: true, guestInterface: 'eth0.20', elvisUrl: 'http://10.0.0.1:8080' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await waitFor('druckserver', (a) => a.status === 'running');

    expect(container('gast').spec.HostConfig).toMatchObject({ NetworkMode: 'host' });
    expect(container('gast').spec.Cmd).toEqual(['guest']);
    const e = env('gast');
    expect(e).toMatchObject({ GUEST_ENABLED: 'true', GUEST_INTERFACE: 'eth0.20', GUEST_NAME: 'ELVIS Gastdrucker', GUEST_PORT: '8631', ELVIS_URL: 'http://10.0.0.1:8080' });
    expect(e.ELVIS_TOKEN).toMatch(/^[\w-]{40,}$/);
    // Der CUPS-Container bekommt das Geheimnis nicht
    expect(env('cups').ELVIS_TOKEN).toBeUndefined();

    expect((await req<PrintStatus>('GET', '/api/printing')).body.guest.available).toBe(true);
    await req('PUT', '/api/system/printing', { archive: false, folderPath: '', defaultPrinter: null, guest: { mode: 'release', onlyWithGuestWifi: false } });
    const submit = (token: string) =>
      app.server.inject({ method: 'POST', url: '/api/printing/guest/submit', payload: PDF, headers: { 'content-type': 'application/pdf', authorization: `Bearer ${token}`, 'x-job-name': 'Test' } });
    expect((await submit('falsch')).statusCode).toBe(401);
    expect((await submit(e.ELVIS_TOKEN!)).statusCode).toBe(201);
    expect((await req<GuestPrintJob[]>('GET', '/api/printing/guest')).body).toHaveLength(1);
  });
});
