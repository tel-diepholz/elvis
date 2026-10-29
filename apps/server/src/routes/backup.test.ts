import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoveryKeyCheck, type BackupSetup, type BackupStatus, type BackupSummary, type Contact, type RestoreStatus } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { BackupFetch } from '../services/backup/elwCloud.js';
import { decryptStream, encryptStream } from '../services/backup/crypto.js';
import { extractArchive } from '../services/backup/archive.js';
import { applyPendingRestore } from '../services/backup/restore.js';
import type { RelayFetch } from '../services/relay.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

const relayUrl = 'https://relay.test';

/** Backup-Endpunkte des Relays im Speicher (wie elvis-relay/src/backup.ts, ohne Kontingent) */
function fakeRelay() {
  const vaults = new Map<string, { token: string; backups: Map<string, { meta: string; parts: Uint8Array[]; complete: boolean; createdAt: string }> }>();
  const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const info = (v: NonNullable<ReturnType<typeof vaults.get>>) => {
    const backups = [...v.backups.entries()]
      .filter(([, b]) => b.complete)
      .map(([id, b]) => ({ id, meta: b.meta, createdAt: b.createdAt, parts: b.parts.length, size: b.parts.reduce((s, p) => s + p.length, 0) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { quota: { maxBackups: 30, maxBytes: 1e9 }, usedBytes: backups.reduce((s, b) => s + b.size, 0), backups };
  };
  let clock = Date.parse('2026-10-29T10:00:00Z');
  const backupFetch: BackupFetch = async (url, init) => {
    const m = /\/v1\/backups\/([0-9a-f]{32})(?:\/backups\/([0-9a-f-]+)(?:\/(complete|parts\/(\d+)))?)?$/.exec(url)!;
    const [, vaultId, backupId, action, part] = m;
    const headers = init.headers as Record<string, string>;
    const token = headers.authorization?.replace('Bearer ', '');
    let v = vaults.get(vaultId!);
    if (!v && init.method === 'PUT' && !backupId) {
      if (headers['x-elvis-elw'] !== 'elw-token') return json(401, { error: 'ELW nicht angemeldet' });
      vaults.set(vaultId!, (v = { token: token!, backups: new Map() }));
      return json(201, info(v));
    }
    if (!v || v.token !== token) return json(404, { error: 'Tresor nicht gefunden' });
    if (!backupId) return json(200, info(v));
    if (!action && init.method === 'POST') {
      v.backups.set(backupId, { meta: JSON.parse(init.body as string).meta, parts: [], complete: false, createdAt: new Date((clock += 60_000)).toISOString() });
      return json(201, null);
    }
    const b = v.backups.get(backupId);
    if (!b) return json(404, { error: 'Backup nicht gefunden' });
    if (!action && init.method === 'DELETE') return v.backups.delete(backupId), json(204, null);
    if (action === 'complete') return (b.complete = true), json(200, null);
    if (init.method === 'PUT') return (b.parts[Number(part)] = new Uint8Array(init.body as Uint8Array)), json(204, null);
    return new Response(b.parts[Number(part)] as BodyInit, { headers: { 'content-type': 'application/octet-stream' } });
  };
  const relayFetch: RelayFetch = async () => ({ status: 201, body: { elwId: 'elw-1', token: 'elw-token' } });
  return { vaults, backupFetch, relayFetch };
}

let relay: ReturnType<typeof fakeRelay>;
const dirs: string[] = [];
const apps: App[] = [];

async function start(dataDir: string, configFile: string | null = null) {
  const app = await buildApp(parseConfig({ dataDir, configFile, app: { relayUrl } }), { logger: false, relayFetch: relay.relayFetch, backupFetch: relay.backupFetch });
  apps.push(app);
  return app;
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'elvis-backup-'));
  dirs.push(d);
  return d;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
async function req<T = unknown>(app: App, method: Method, url: string, payload?: unknown, cookie = '') {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

beforeEach(() => {
  relay = fakeRelay();
});

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Verschlüsselung', () => {
  const key = Buffer.alloc(32, 7);
  const roundtrip = async (plain: Buffer, k = key) => {
    const enc = Buffer.concat(await Readable.from([plain]).pipe(encryptStream(key, 16)).toArray());
    return { enc, dec: () => Readable.from([enc]).pipe(decryptStream(k, 16)).toArray().then((c) => Buffer.concat(c)) };
  };

  it('entschlüsselt in Blöcken, auch Grenzfälle', async () => {
    for (const len of [0, 1, 16, 17, 32, 100]) {
      const plain = Buffer.from(Array.from({ length: len }, (_, i) => i));
      expect(await (await roundtrip(plain)).dec()).toEqual(plain);
    }
  });

  it('erkennt falschen Schlüssel, Manipulation und abgeschnittene Dateien', async () => {
    const { enc } = await roundtrip(Buffer.alloc(100, 1));
    await expect((await roundtrip(Buffer.alloc(100, 1), Buffer.alloc(32, 8))).dec()).rejects.toThrow(/entschlüsseln/);
    const flipped = Buffer.from(enc);
    flipped[40]! ^= 1;
    await expect(Readable.from([flipped]).pipe(decryptStream(key, 16)).toArray()).rejects.toThrow(/entschlüsseln/);
    // ohne den letzten Block: der vorletzte ist nicht als letzter markiert
    await expect(Readable.from([enc.subarray(0, 16 + 4 * 32)]).pipe(decryptStream(key, 16)).toArray()).rejects.toThrow(/entschlüsseln/);
  });
});

describe('Archiv', () => {
  it('entpackt nichts außerhalb des Zielordners', async () => {
    const pack = tar.pack();
    pack.entry({ name: '../../etc/evil' }, 'x');
    pack.finalize();
    const target = join(tempDir(), 'ziel');
    await expect(extractArchive(pack.pipe(createGzip()), target)).rejects.toThrow(/Unerlaubter Pfad/);
  });
});

describe('Backup und Wiederherstellung', () => {
  async function setup(app: App, admin: string) {
    const { body } = await req<BackupSetup>(app, 'POST', '/api/system/backup/setup', { driver: 'elw-cloud' }, admin);
    expect(body.recoveryKey).toMatch(/^ELVIS-/);
    expect((await req(app, 'POST', '/api/system/backup/setup/confirm', { check: 'AAAA-AAAA', interval: '1h', keep: 2 }, admin)).status).toBe(400);
    const confirmed = await req<BackupStatus>(app, 'POST', '/api/system/backup/setup/confirm', { check: recoveryKeyCheck(body.recoveryKey).toLowerCase(), interval: '1h', keep: 2 }, admin);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.state).toBe('active');
    await app.backup.run();
    return body.recoveryKey;
  }

  it('sichert, bewahrt die neuesten auf und stellt eine frische Installation wieder her', async () => {
    const dirA = tempDir();
    const configFile = join(tempDir(), 'elvis.json');
    writeFileSync(configFile, JSON.stringify({ vehicle: { name: 'ELW Test' } }));
    mkdirSync(join(dirA, 'documents'));
    writeFileSync(join(dirA, 'documents', 'lage.pdf'), 'Lagebericht');
    writeFileSync(join(dirA, 'mail.secret'), 'geheim');
    mkdirSync(join(dirA, 'tiles'));
    writeFileSync(join(dirA, 'tiles', 'cache.png'), 'Kachel');

    const a = await start(dirA, configFile);
    const admin = await adminCookie(a);
    const contact = (await req<Contact>(a, 'POST', '/api/contacts', { kind: 'organization', organization: 'Getränke Meyer', categoryIds: [] }, admin)).body;
    expect((await req(a, 'GET', '/api/system/backup', undefined, '')).status).toBe(401);
    expect((await req<BackupStatus>(a, 'GET', '/api/system/backup', undefined, admin)).body.state).toBe('off');

    const key = await setup(a, admin);
    await a.backup.run();
    await a.backup.run();
    const status = (await req<BackupStatus>(a, 'GET', '/api/system/backup', undefined, admin)).body;
    expect(status.lastError).toBeNull();
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.backups).toHaveLength(2);
    expect(status.backups[0]).toMatchObject({ vehicle: 'ELW 2', schemaVersion: expect.any(Number) });
    // Beim Relay liegt nichts im Klartext
    const stored = [...[...relay.vaults.values()][0]!.backups.values()][0]!;
    expect(Buffer.concat(stored.parts).includes('Getränke Meyer')).toBe(false);
    // Eingerichtete Installation: kein Wiederherstellen
    expect((await req(a, 'POST', '/api/restore/list', { driver: 'elw-cloud', recoveryKey: key })).status).toBe(409);

    // Frische Installation
    const dirB = tempDir();
    const configB = join(tempDir(), 'elvis.json');
    const b = await start(dirB, configB);
    expect((await req(b, 'POST', '/api/restore/list', { driver: 'elw-cloud', recoveryKey: key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A') })).status).toBe(400);
    const list = await req<BackupSummary[]>(b, 'POST', '/api/restore/list', { driver: 'elw-cloud', recoveryKey: key.toLowerCase() });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const started = await req<RestoreStatus>(b, 'POST', '/api/restore/start', { driver: 'elw-cloud', recoveryKey: key, backupId: list.body[0]!.id });
    expect(started.status).toBe(202);
    await vi.waitFor(async () => expect((await req<RestoreStatus>(b, 'GET', '/api/restore/status')).body.state).toBe('restarting'));
    await b.close();

    // Neustart: Daten tauschen, Caches bleiben
    writeFileSync(join(dirB, 'mail.secret'), 'alt');
    expect(applyPendingRestore(dirB, configB, () => undefined)).toBe(true);
    expect(readFileSync(join(dirB, 'mail.secret'))).toEqual(readFileSync(join(dirA, 'mail.secret')));
    expect(readFileSync(join(dirB, 'documents', 'lage.pdf'), 'utf8')).toBe('Lagebericht');
    expect(existsSync(join(dirB, 'tiles', 'cache.png'))).toBe(false);
    expect(JSON.parse(readFileSync(configB, 'utf8')).vehicle.name).toBe('ELW Test');
    expect(applyPendingRestore(dirB, configB, () => undefined)).toBe(false);

    const restored = await start(dirB, configB);
    const login = await restored.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 1, pin: '4711' } });
    expect(login.statusCode).toBe(200);
    const cookie = sessionCookie(login.headers['set-cookie']);
    expect((await req<Contact[]>(restored, 'GET', '/api/contacts', undefined, cookie)).body.map((c) => c.id)).toEqual([contact.id]);
    // Das Backup läuft im selben Tresor weiter
    expect((await req<BackupStatus>(restored, 'GET', '/api/system/backup', undefined, cookie)).body).toMatchObject({ state: 'active', keep: 2 });
  });

  it('bewahrt höchstens „keep“ Backups auf und lässt sich abschalten', async () => {
    const app = await start(tempDir());
    const admin = await adminCookie(app);
    await setup(app, admin);
    expect((await req<BackupStatus>(app, 'PUT', '/api/system/backup', { interval: '24h', keep: 1 }, admin)).body).toMatchObject({ interval: '24h', keep: 1 });
    expect((await req(app, 'POST', '/api/system/backup/run', undefined, admin)).status).toBe(202);
    await app.backup.run();
    expect((await req<BackupStatus>(app, 'GET', '/api/system/backup', undefined, admin)).body.backups).toHaveLength(1);
    expect((await req(app, 'DELETE', '/api/system/backup', undefined, admin)).status).toBe(204);
    expect((await req<BackupStatus>(app, 'GET', '/api/system/backup', undefined, admin)).body.state).toBe('off');
    expect((await req(app, 'POST', '/api/system/backup/run', undefined, admin)).status).toBe(409);
  });
});
