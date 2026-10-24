import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { requestedPermissions, type AddonStoreEntry, type DockerHost, type InstalledAddon, type Workstation } from '@elvis/shared';
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

const req = async <T = unknown>(method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = { cookie }) => {
  const res = await app.server.inject({ method, url, payload: payload as object, headers });
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

describe('Arbeitsplatz-Addon (PXE)', () => {
  it('baut das Abbild, startet danach den Netzwerkstart im Host-Netz und registriert Notebooks mit dem Addon-Geheimnis', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'elvis-ap-'));
    daemon = new FakeDocker();
    app = await buildApp(parseConfig({ dataDir, addons: { builtinDir: BUILTIN } }), { logger: false, dockerFactory: () => daemon.asDocker() });
    await app.docker!.repos.refresh();
    cookie = await adminCookie(app);

    // Rechte vor der Installation: Host-Netz, Netzwerk-Capabilities, Bau ohne AppArmor-Profil
    const store = (await req<AddonStoreEntry[]>('GET', '/api/addons/store')).body;
    const entry = store.find((a) => a.manifest?.id === 'arbeitsplatz')!;
    expect(entry.error).toBeNull();
    expect(requestedPermissions(entry.manifest!).map((p) => p.kind)).toEqual(expect.arrayContaining(['host-network', 'capability', 'apparmor', 'build']));

    const host = (await req<{ host: DockerHost }>('POST', '/api/docker/hosts', { certMode: 'custom', name: 'server2', address: '10.0.0.2', caPem: PEM, certPem: PEM, keyPem: PEM })).body.host;
    const res = await req('POST', '/api/addons', {
      addonId: 'arbeitsplatz',
      hostId: host.id,
      options: { elvisUrl: 'http://10.0.0.1:8080', interface: 'eth0', adminPassword: 'notfall' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const done = await waitFor('arbeitsplatz', (a) => a.jobs.find((j) => j.id === 'image')?.state === 'succeeded' && a.status === 'running');
    expect(done.jobs.find((j) => j.id === 'image')!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);

    // Bauschritte: mount im chroot braucht SYS_ADMIN ohne AppArmor, aber nie privilegiert
    const rootfs = daemon.byName('elvis-arbeitsplatz-job-image-1')!.spec;
    expect(rootfs.HostConfig).toMatchObject({ CapAdd: ['SYS_ADMIN', 'MKNOD', 'SYS_CHROOT'], SecurityOpt: ['apparmor=unconfined'], Privileged: false });
    expect(rootfs.Cmd).toEqual(['sh', '/data/addon/build/rootfs.sh']);
    expect(daemon.byName('elvis-arbeitsplatz-job-image-3')!.spec.HostConfig?.SecurityOpt).toBeUndefined();

    // Erneut bauen (manuell): die Schritte nutzen das gebaute Image, nichts wird aus einer Registry gezogen
    daemon.images.delete('elvis-addon-arbeitsplatz-builder:1.0.3');
    expect((await req('POST', '/api/addons/arbeitsplatz/jobs/image')).status).toBe(202);
    const image = (a: InstalledAddon) => a.jobs.find((j) => j.id === 'image')!;
    const again = await waitFor('arbeitsplatz', (a) => image(a).state !== 'running' && image(a).triggeredBy !== 'Max Müller (Installation)');
    expect(image(again).state, JSON.stringify(image(again))).toBe('succeeded');
    expect(daemon.images.has('elvis-addon-arbeitsplatz-builder:1.0.3')).toBe(true);

    // Nur den Installer neu bauen (eigener Job, das Abbild bleibt)
    expect((await req('POST', '/api/addons/arbeitsplatz/jobs/installer')).status).toBe(202);
    const inst = await waitFor('arbeitsplatz', (a) => a.jobs.find((j) => j.id === 'installer')?.state === 'succeeded');
    expect(inst.jobs.find((j) => j.id === 'installer')!.steps.map((s) => s.label)).toEqual(['Installer', 'Netzwerkstart-Dateien']);
    expect(daemon.byName('elvis-arbeitsplatz-job-installer-1')!.spec.Cmd).toEqual(['sh', '/data/addon/build/installer.sh']);

    const archive = daemon.archives.find((a) => a.volume === 'elvis-addon-arbeitsplatz-data');
    expect(archive?.entries).toEqual(expect.arrayContaining(['addon/installer/elvis-install', 'addon/client/elvis-clientd.py', 'addon/client/post-install.sh', 'addon/client/sddm-theme/Main.qml']));

    const pxe = daemon.byName('elvis-arbeitsplatz-pxe')!;
    expect(pxe.state).toBe('running');
    expect(pxe.spec.HostConfig).toMatchObject({ NetworkMode: 'host', CapAdd: ['NET_ADMIN', 'NET_RAW', 'NET_BIND_SERVICE'] });
    const env = Object.fromEntries((pxe.spec.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    expect(env).toMatchObject({ INTERFACE: 'eth0', HTTP_PORT: '8089', ELVIS_URL: 'http://10.0.0.1:8080', HOSTNAME_PREFIX: 'elvis-ap' });

    // Der Installer registriert mit dem Geheimnis, das der Container bekommt
    const enroll = (token: string) => req<{ token: string }>('POST', '/api/clients/enroll', { hostname: 'elvis-ap-0001', mac: '52:54:00:00:00:01' }, { authorization: `Bearer ${token}` });
    expect((await enroll('falsch')).status).toBe(401);
    const ok = await enroll(env.ENROLL_TOKEN!);
    expect(ok.status).toBe(201);
    expect((await req<Workstation[]>('GET', '/api/system/workstations')).body.map((w) => w.hostname)).toEqual(['elvis-ap-0001']);
  });
});
