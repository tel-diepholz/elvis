import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';
import { UpdateService, type UpdateFetch } from './updates.js';

const keys = nacl.sign.keyPair();
const publicKey = Buffer.from(keys.publicKey).toString('base64');
const installer = Buffer.from('MZ… ELVIS lite 1.2.0');
const sign = (bytes: Buffer, secret = keys.secretKey) => Buffer.from(nacl.sign.detached(bytes, secret)).toString('base64');
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

function asset(name: string, size = 1, digest: string | null = null) {
  return { name, size, browser_download_url: `https://dl.example/${name}`, digest };
}
function release(tag: string, assets: ReturnType<typeof asset>[], extra: Record<string, unknown> = {}) {
  return { tag_name: tag, name: `ELVIS ${tag}`, body: `Neu in ${tag}`, html_url: `https://github.com/x/${tag}`, published_at: '2026-11-01T10:00:00Z', draft: false, prerelease: false, assets, ...extra };
}

/** GitHub-Attrappe: Release-Liste und Dateien */
function github(releases: unknown[], files: Record<string, Buffer | string>): UpdateFetch {
  return async (url) => {
    if (url.includes('/releases')) return new Response(JSON.stringify(releases), { status: 200 });
    const name = url.split('/').pop()!;
    const body = files[name];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });
  };
}

const RELEASES = [
  release('v1.3.0', [asset('ELVIS-lite-1.3.0-setup.exe'), asset('ELVIS-lite-1.3.0-setup.exe.sig')], { prerelease: true }),
  release('v1.2.0', [asset('ELVIS-lite-1.2.0-setup.exe', installer.length, sha(installer)), asset('ELVIS-lite-1.2.0-setup.exe.sig')]),
  release('v1.1.5', [asset('ELVIS-lite-1.1.5-setup.exe')]), // ohne Signatur
  release('v1.1.0', [asset('ELVIS-lite-1.1.0-setup.exe'), asset('ELVIS-lite-1.1.0-setup.exe.sig')]),
];

describe('Updates (ELVIS lite)', () => {
  let dir: string;
  let dataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'elvis-updates-'));
    dataDir = join(dir, 'data');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const service = (files: Record<string, Buffer | string>, extra: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) =>
    new UpdateService({ edition: 'lite', dataDir, repo: 'tel-diepholz/elvis', apiUrl: 'https://api.example', current: '1.1.0', fetch: github(RELEASES, files), publicKey, platform: 'win32', service: true, ...extra });

  const settle = async (s: UpdateService) => {
    await vi.waitFor(() => expect(['installing', 'failed']).toContain(s.status().phase));
    return s.status();
  };

  it('findet das neueste Release mit Installer und Signatur, ohne Vorabversionen', async () => {
    const s = await service({}).check();
    expect(s).toMatchObject({ current: '1.1.0', available: true, checkError: null, latest: { version: '1.2.0', tag: 'v1.2.0', notes: 'Neu in v1.2.0', size: installer.length } });
    const same = await service({}, { current: '1.2.0' }).check();
    expect(same.available).toBe(false);
  });

  it('meldet fehlende Verbindung verständlich', async () => {
    const s = await service({}, { fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }).check();
    expect(s.checkError).toMatch(/Keine Verbindung zu GitHub/);
    expect(s.available).toBe(false);
  });

  it('installiert nur ein signiertes Update und übergibt es an den Installer', async () => {
    const launch = vi.fn(async () => {});
    const s = service({ 'ELVIS-lite-1.2.0-setup.exe': installer, 'ELVIS-lite-1.2.0-setup.exe.sig': sign(installer) }, { launch });
    await s.check();
    expect(s.install().phase).toBe('downloading');
    expect(await settle(s)).toMatchObject({ phase: 'installing', message: expect.stringMatching(/startet neu/) });
    const file = join(dir, 'updates', 'ELVIS-lite-setup.exe');
    expect(launch).toHaveBeenCalledWith(file);
    expect(readFileSync(file)).toEqual(installer);
    expect(() => s.install()).toThrow(/läuft bereits/);
  });

  it('verwirft gefälschte Signaturen und beschädigte Downloads', async () => {
    const launch = vi.fn(async () => {});
    const forged = service({ 'ELVIS-lite-1.2.0-setup.exe': installer, 'ELVIS-lite-1.2.0-setup.exe.sig': sign(installer, nacl.sign.keyPair().secretKey) }, { launch });
    await forged.check();
    forged.install();
    expect(await settle(forged)).toMatchObject({ phase: 'failed', message: expect.stringMatching(/Signatur.*ungültig/) });

    const broken = Buffer.from('MZ… kaputt');
    const corrupt = service({ 'ELVIS-lite-1.2.0-setup.exe': broken, 'ELVIS-lite-1.2.0-setup.exe.sig': sign(broken) }, { launch });
    await corrupt.check();
    corrupt.install();
    expect(await settle(corrupt)).toMatchObject({ phase: 'failed', message: expect.stringMatching(/Prüfsumme/) });
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'updates', 'ELVIS-lite-setup.exe'))).toBe(false);
  });

  it('installiert nur in der Windows-Installation und nur ein neueres Update', async () => {
    const linux = service({}, { platform: 'linux' });
    await linux.check();
    expect(linux.status()).toMatchObject({ installable: false, reason: expect.stringMatching(/Windows-Installation/), available: true });
    expect(() => linux.install()).toThrow(/Windows-Installation/);
    expect(() => service({}).install()).toThrow(/zuerst nach Updates suchen/);
    expect(service({}, { edition: 'full' }).status().reason).toMatch(/nur für ELVIS lite/);
  });

  it('zeigt das Ergebnis, das der Installer nach dem Neustart hinterlegt', () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(join(dir, 'updates', 'result.json'), '{"from":"1.1.0","to":"1.2.0","ok":false,"rolledBack":true}');
    expect(service({}).status().lastResult).toMatchObject({ from: '1.1.0', to: '1.2.0', ok: false, rolledBack: true, at: expect.any(String) });
    // Installer gab auf, die neue Version läuft aber (Dienst von Hand gestartet): gilt als geklappt
    writeFileSync(join(dir, 'updates', 'result.json'), '{"from":"1.1.0","to":"1.2.0","ok":false,"rolledBack":false}');
    expect(service({}, { current: '1.2.0' }).status().lastResult).toMatchObject({ ok: true });
    expect(service({}, { current: '1.1.0' }).status().lastResult).toMatchObject({ ok: false });
  });
});

describe('API /api/system/updates', () => {
  let app: App;
  let dataDir: string;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'elvis-updates-api-'));
    app = await buildApp(parseConfig({ dataDir, edition: 'lite' }), { logger: false, updateFetch: github(RELEASES, {}) });
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('nur für Admins, sucht auf GitHub und protokolliert abgelehnte Installationen', async () => {
    expect((await app.server.inject({ method: 'GET', url: '/api/system/updates' })).statusCode).toBe(401);
    const cookie = await adminCookie(app);
    const checked = (await app.server.inject({ method: 'POST', url: '/api/system/updates/check', headers: { cookie } })).json() as UpdateStatus;
    expect(checked).toMatchObject({ current: 'dev', available: true, latest: { version: '1.2.0' }, installable: false });
    const install = await app.server.inject({ method: 'POST', url: '/api/system/updates/install', headers: { cookie } });
    expect(install.statusCode).toBe(409);
    const audit = (await app.server.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).json() as { target: string; success: boolean }[];
    expect(audit[0]).toMatchObject({ target: 'update', success: false });
    expect(((await app.server.inject({ method: 'GET', url: '/api/info' })).json() as { version: string }).version).toBe('dev');
  });
});
