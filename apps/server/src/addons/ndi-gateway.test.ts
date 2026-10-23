import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DockerHost, InstalledAddon, VideoSources } from '@elvis/shared';
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
let status: Server | null = null;

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-ndi-'));
  daemon = new FakeDocker();
  app = await buildApp(parseConfig({ dataDir, addons: { builtinDir: BUILTIN } }), { logger: false, dockerFactory: () => daemon.asDocker() });
  await app.docker!.repos.refresh();
  cookie = await adminCookie(app);
}

afterEach(async () => {
  await app.close();
  status?.close();
  status = null;
  rmSync(dataDir, { recursive: true, force: true });
});

const req = async <T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: (res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) as T };
};

async function addHost(address = '10.0.0.2'): Promise<DockerHost> {
  return (await req<{ host: DockerHost }>('POST', '/api/docker/hosts', { certMode: 'custom', name: 'server2', address, caPem: PEM, certPem: PEM, keyPem: PEM })).body.host;
}

async function waitFor(id: string, done: (a: InstalledAddon) => boolean): Promise<InstalledAddon> {
  for (let i = 0; i < 200; i++) {
    const { body } = await req<InstalledAddon>('GET', `/api/addons/${id}`);
    if (done(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Zeitüberschreitung: ${JSON.stringify((await req('GET', `/api/addons/${id}`)).body).slice(0, 1500)}`);
}

const gateway = () => [...daemon.containers.values()].find((c) => c.name === 'elvis-ndi-gateway-gateway')!;

describe('NDI-Gateway-Addon', () => {
  it('baut das Gateway-Image auf dem Host, reicht je nach Encoder GPU oder /dev/dri durch und lädt die Laufzeit erst nach Zustimmung', async () => {
    await setup();
    const host = await addHost();
    const res = await req('POST', '/api/addons', { addonId: 'ndi-gateway', hostId: host.id, options: { encoder: 'vaapi', resolution: '1080', acceptLicense: true } });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const done = await waitFor('ndi-gateway', (a) => a.jobs[0]?.state === 'succeeded' && a.status === 'running');
    expect(done.status).toBe('running');

    // Image aus dem Build-Kontext des Addons gebaut (versioniert)
    expect(daemon.builds).toEqual([{ tag: 'elvis-addon-ndi-gateway-gateway:1.0.2', files: ['Dockerfile', 'gateway.py'] }]);
    expect(gateway().spec.Image).toBe('elvis-addon-ndi-gateway-gateway:1.0.2');
    expect(gateway().spec.Env).toEqual(expect.arrayContaining(['ENCODER=vaapi', 'RESOLUTION=1080', 'AUDIO=true', 'TRANSPORT=tcp']));
    expect(gateway().spec.HostConfig).toMatchObject({ NetworkMode: 'host', Devices: [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }] });
    expect(gateway().spec.HostConfig!.DeviceRequests).toBeUndefined();
    const job = [...daemon.containers.values()].find((c) => c.name === 'elvis-ndi-gateway-job-runtime-1')!;
    expect(job.spec.Env).toContain('ACCEPT_LICENSE=true');
    // MediaMTX lauscht für WebRTC auf allen Adressen, RTSP nur lokal
    const mtx = [...daemon.containers.values()].find((c) => c.name === 'elvis-ndi-gateway-mediamtx')!;
    expect(mtx.spec.Env).toEqual(expect.arrayContaining(['MTX_RTSPADDRESS=127.0.0.1:8554', 'MTX_WEBRTCADDITIONALHOSTS=10.0.0.2']));

    // Umstellen auf NVENC: GPU statt /dev/dri, gleiches Image wird nicht neu gebaut
    const update = await req('PATCH', '/api/addons/ndi-gateway', { options: { ...done.options, encoder: 'nvenc' } });
    expect(update.status, JSON.stringify(update.body)).toBe(202);
    await waitFor('ndi-gateway', (a) => a.status === 'running' && a.options.encoder === 'nvenc' && !!a.operation?.finishedAt);
    expect(gateway().spec.HostConfig).toMatchObject({ DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu', 'video', 'compute', 'utility']] }] });
    expect(gateway().spec.HostConfig!.Devices).toBeUndefined();
    expect(daemon.builds).toHaveLength(1);
  });

  it('meldet Build-Fehler mit den letzten Zeilen des Build-Protokolls', async () => {
    await setup();
    daemon.buildError = 'cargo build failed';
    const host = await addHost();
    await req('POST', '/api/addons', { addonId: 'ndi-gateway', hostId: host.id, options: { acceptLicense: true } });
    const failed = await waitFor('ndi-gateway', (a) => !!a.error && !!a.operation?.finishedAt);
    expect(failed.error).toMatch(/Build fehlgeschlagen: cargo build failed/);
  });

  it('bietet die Ströme des Gateways als Videoquellen an', async () => {
    // Status-Endpunkt des Gateways nachbilden
    status = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ encoder: 'cpu', resolution: '1280x720', problem: '', sources: ['STUDIO (Kamera 1)', 'STUDIO (Grafik)'], streams: [{ name: 'STUDIO (Kamera 1)', path: 'studio-kamera-1', state: 'running', error: '' }] }));
    });
    await new Promise<void>((r) => status!.listen(0, '127.0.0.1', r));
    const port = (status.address() as AddressInfo).port;
    await setup();
    const host = await addHost('127.0.0.1');
    await req('POST', '/api/addons', { addonId: 'ndi-gateway', hostId: host.id, options: { acceptLicense: true, statusPort: port } });
    await waitFor('ndi-gateway', (a) => a.status === 'running');
    let sources: VideoSources = { providers: [], streams: [] };
    for (let i = 0; i < 100 && !sources.streams.length; i++) {
      await new Promise((r) => setTimeout(r, 30));
      sources = (await app.server.inject({ method: 'GET', url: '/api/video/sources' })).json();
    }
    expect(sources.streams).toEqual([{ id: 'ndi-gateway-ndi:studio-kamera-1', providerId: 'ndi-gateway-ndi', name: 'STUDIO (Kamera 1)', state: 'running', error: null, url: 'http://127.0.0.1:8889/studio-kamera-1' }]);
    expect(sources.providers[0]).toMatchObject({ name: 'NDI', online: true, problem: null, encoder: 'cpu', discovered: ['STUDIO (Grafik)'] });
  });
});
