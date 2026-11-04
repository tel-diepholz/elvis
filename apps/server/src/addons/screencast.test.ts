import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
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
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-screencast-'));
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

const req = async <T = unknown>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
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

const container = (name: string) => [...daemon.containers.values()].find((c) => c.name === `elvis-screencast-${name}`)!;

describe('Addon Bildschirmübertragung', () => {
  it('baut den Empfänger auf dem Host, startet MediaMTX und reicht /dev/dri nur beim Umkodieren per VA-API durch', async () => {
    await setup();
    const host = await addHost();
    const res = await req('POST', '/api/addons', { addonId: 'screencast', hostId: host.id, options: { receivers: 'Leinwand, Besprechung' } });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const done = await waitFor('screencast', (a) => a.status === 'running');

    expect(daemon.builds).toEqual([{ tag: 'elvis-addon-screencast-receiver:1.1.0', files: ['Dockerfile', 'receiver.py', 'share.html'] }]);
    const receiver = container('receiver');
    expect(receiver.spec.Image).toBe('elvis-addon-screencast-receiver:1.1.0');
    expect(receiver.spec.Env).toEqual(
      expect.arrayContaining(['RECEIVERS=Leinwand, Besprechung', 'AIRPLAY=true', 'BROWSER_SHARE=true', 'TRANSCODE=off', 'HOST_ADDRESS=10.0.0.2', 'SHARE_PORT=8443']),
    );
    expect(receiver.spec.HostConfig).toMatchObject({ NetworkMode: 'host' });
    expect(receiver.spec.HostConfig!.Devices).toBeUndefined();
    // RTSP und API nur lokal, WebRTC für alle; Ports weichen vom NDI-Gateway ab (beide auf einem Host möglich)
    expect(container('mediamtx').spec.Env).toEqual(
      expect.arrayContaining(['MTX_RTSPADDRESS=127.0.0.1:8564', 'MTX_APIADDRESS=127.0.0.1:9987', 'MTX_WEBRTCADDRESS=:8899', 'MTX_WEBRTCADDITIONALHOSTS=10.0.0.2']),
    );

    const update = await req('PATCH', '/api/addons/screencast', { options: { ...done.options, transcode: 'vaapi' } });
    expect(update.status, JSON.stringify(update.body)).toBe(202);
    await waitFor('screencast', (a) => a.status === 'running' && a.options.transcode === 'vaapi' && !!a.operation?.finishedAt);
    expect(container('receiver').spec.HostConfig).toMatchObject({ Devices: [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri' }] });
  });

  it('legt ein Zertifikat aus der ELVIS-CA ins Volume, bietet die CA öffentlich an und erneuert bei neuer Host-Adresse', async () => {
    await setup();
    const host = await addHost('10.0.0.2');
    await req('POST', '/api/addons', { addonId: 'screencast', hostId: host.id, options: {} });
    await waitFor('screencast', (a) => a.status === 'running');

    // CA ohne Anmeldung herunterladbar
    const ca = await app.server.inject({ method: 'GET', url: '/api/tls/ca.crt' });
    expect(ca.statusCode).toBe(200);
    expect(ca.headers['content-type']).toBe('application/x-x509-ca-cert');
    const caCert = forge.pki.certificateFromPem(ca.body);

    const tlsFiles = () => daemon.archives.filter((a) => a.volume === 'elvis-addon-screencast-data' && a.contents['elvis-tls/key.pem']);
    expect(tlsFiles()).toHaveLength(1);
    const files = tlsFiles()[0]!;
    expect(files.entries.filter((e) => !e.endsWith('/'))).toEqual(['elvis-tls/cert.pem', 'elvis-tls/ca.pem', 'elvis-tls/key.pem']);
    expect(files.contents['elvis-tls/ca.pem']!.toString()).toBe(ca.body);
    const cert = forge.pki.certificateFromPem(files.contents['elvis-tls/cert.pem']!.toString());
    expect(caCert.verify(cert)).toBe(true);
    const san = (c: forge.pki.Certificate) => (c.getExtension('subjectAltName') as { altNames: { ip?: string; value?: string }[] }).altNames.map((n) => n.ip ?? n.value);
    expect(san(cert)).toEqual(['10.0.0.2', 'server2']);
    expect(cert.subject.getField('CN').value).toBe('10.0.0.2');

    // nichts zu tun: gleiches Zertifikat bleibt
    await app.docker!.addons.renewCertificates();
    expect(tlsFiles()).toHaveLength(1);

    // neue Adresse des Hosts → neues Zertifikat; Konfiguration übernehmen nutzt danach das gespeicherte weiter
    expect((await req('PATCH', `/api/docker/hosts/${host.id}`, { address: '10.0.0.9' })).status).toBe(200);
    await app.docker!.addons.renewCertificates();
    expect(tlsFiles()).toHaveLength(2);
    const renewed = tlsFiles()[1]!.contents['elvis-tls/cert.pem']!.toString();
    expect(san(forge.pki.certificateFromPem(renewed))).toEqual(['10.0.0.9', 'server2']);
    const done = await req<InstalledAddon>('GET', '/api/addons/screencast');
    await req('PATCH', '/api/addons/screencast', { options: { ...done.body.options, fps: '60' } });
    await waitFor('screencast', (a) => a.status === 'running' && a.options.fps === '60' && !!a.operation?.finishedAt);
    expect(tlsFiles()).toHaveLength(3);
    expect(tlsFiles()[2]!.contents['elvis-tls/cert.pem']!.toString()).toBe(renewed);
  });

  it('meldet Empfänger als Videoquellen – wartend mit Anleitung, sendend mit Absender', async () => {
    status = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          encoder: 'durchgereicht',
          resolution: '1920x1080',
          problem: '',
          sources: [],
          streams: [
            { name: 'Leinwand', path: 'leinwand', state: 'running', error: '', sender: 'Henriks iPhone', via: 'airplay', connect: { airplay: 'Leinwand', shareUrl: 'https://10.0.0.2:8443/?r=leinwand' } },
            { name: 'Besprechung', path: 'besprechung', state: 'idle', error: '', sender: null, via: null, connect: { airplay: 'Besprechung', shareUrl: 'javascript:alert(1)' } },
          ],
        }),
      );
    });
    await new Promise<void>((r) => status!.listen(0, '127.0.0.1', r));
    const port = (status.address() as AddressInfo).port;
    await setup();
    const host = await addHost('127.0.0.1');
    await req('POST', '/api/addons', { addonId: 'screencast', hostId: host.id, options: { statusPort: port } });
    await waitFor('screencast', (a) => a.status === 'running');
    let sources: VideoSources = { providers: [], streams: [] };
    for (let i = 0; i < 100 && !sources.streams.length; i++) {
      await new Promise((r) => setTimeout(r, 30));
      sources = (await app.server.inject({ method: 'GET', url: '/api/video/sources' })).json();
    }
    expect(sources.streams).toEqual([
      {
        id: 'screencast-screen:leinwand',
        providerId: 'screencast-screen',
        name: 'Leinwand',
        state: 'running',
        error: null,
        url: 'http://127.0.0.1:8899/leinwand',
        sender: 'Henriks iPhone',
        via: 'airplay',
        connect: { airplay: 'Leinwand', shareUrl: 'https://10.0.0.2:8443/?r=leinwand' },
      },
      // Adressen außer http(s) fallen weg – die Kachel macht daraus einen QR-Code
      { id: 'screencast-screen:besprechung', providerId: 'screencast-screen', name: 'Besprechung', state: 'idle', error: null, url: 'http://127.0.0.1:8899/besprechung', sender: null, via: null, connect: { airplay: 'Besprechung' } },
    ]);
    expect(sources.providers[0]).toMatchObject({ name: 'Bildschirmübertragung', online: true, problem: null, encoder: 'durchgereicht' });
  });
});
