import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_SIGNATURE_HEADER, mailSignaturePayload, type CloudLinkStatus, type CloudStatus } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { CloudFetch } from '../services/cloud.js';
import type { RelayFetch } from '../services/relay.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

/** Relay im Kleinen: prüft Token und Ed25519-Signatur wie elvis-relay (src/cloud/elw.ts) */
const relay = {
  link: { state: 'none' } as CloudLinkStatus,
  key: null as string | null,
  versions: [] as string[],
  down: false,
};

const relayFetch: RelayFetch = async (url) => (url.endsWith('/v1/elws') ? { status: 201, body: { elwId: 'e1', token: 'tok' } } : { status: 404, body: null });

async function verify(method: string, path: string, headers: Record<string, string>, body: string, key: string): Promise<boolean> {
  const parts = Object.fromEntries(headers[MAIL_SIGNATURE_HEADER]!.split(',').map((p) => p.split('=', 2) as [string, string]));
  const payload = mailSignaturePayload(method, path, createHash('sha256').update(body).digest('hex'), Number(parts.t), parts.n!);
  const k = await webcrypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
  return webcrypto.subtle.verify({ name: 'Ed25519' }, k, Buffer.from(parts.s!, 'base64url'), new TextEncoder().encode(payload));
}

const cloudFetch: CloudFetch = async (url, { method, headers, body = '' }) => {
  if (relay.down) throw new Error('ECONNREFUSED');
  const path = new URL(url).pathname;
  if (headers.authorization !== 'Bearer tok') return { status: 401, body: '{"error":"ELW nicht angemeldet"}' };
  relay.versions.push(headers['x-elvis-version'] ?? '');
  if (method === 'POST' && path === '/v1/elws/me/cloud/link') {
    const req = JSON.parse(body) as { name: string; sigPublicKey: string };
    if (!(await verify(method, path, headers, body, req.sigPublicKey))) return { status: 401, body: '{"error":"Signatur ungültig"}' };
    relay.key = req.sigPublicKey;
    relay.link = { state: 'pending', code: 'ABCDEFGH', expiresAt: '2030-01-01T00:00:00.000Z' };
    return { status: 201, body: JSON.stringify(relay.link) };
  }
  if (path === '/v1/elws/me/cloud') {
    if (relay.key && !(await verify(method, path, headers, body, relay.key))) return { status: 401, body: '{"error":"Signatur ungültig"}' };
    if (method === 'DELETE') return (relay.link = { state: 'none' }), (relay.key = null), { status: 204, body: '' };
    return { status: 200, body: JSON.stringify(relay.link) };
  }
  return { status: 404, body: '{"error":"Nicht gefunden"}' };
};

beforeEach(async () => {
  relay.link = { state: 'none' };
  relay.key = null;
  relay.versions = [];
  relay.down = false;
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-cloud-'));
  app = await buildApp(parseConfig({ dataDir, app: { relayUrl: 'https://relay.test', cloudUrl: 'https://cloud.test' } }), { logger: false, relayFetch, cloudFetch });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function req<T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.json() as T };
}

describe('Cloud-Zugang', () => {
  it('fordert einen signierten Code an, sieht die Verknüpfung und trennt', async () => {
    expect((await req<CloudStatus>('GET', '/api/system/cloud')).body).toMatchObject({ available: true, portalUrl: 'https://cloud.test', link: { state: 'none' } });
    const pending = await req<CloudStatus>('POST', '/api/system/cloud/link', { name: 'ELW 1 Weyhe' });
    expect(pending.body.link).toEqual({ state: 'pending', code: 'ABCDEFGH', expiresAt: '2030-01-01T00:00:00.000Z' });

    // Verwalter gibt den Code im Portal ein
    relay.link = { state: 'linked', node: { id: 'ars:032510047047', name: 'Weyhe', path: ['Niedersachsen', 'Landkreis Diepholz', 'Weyhe'] }, linkedAt: '2026-11-05T10:00:00Z', linkedBy: 'kbm@lk-diepholz.de' };
    const linked = await req<CloudStatus>('GET', '/api/system/cloud?refresh=1');
    expect(linked.body.link).toMatchObject({ state: 'linked', node: { name: 'Weyhe' } });
    expect(relay.versions.every((v) => v.length > 0)).toBe(true);

    // Relay weg: letzter Stand bleibt sichtbar, mit Fehler
    relay.down = true;
    const offline = await req<CloudStatus>('GET', '/api/system/cloud?refresh=1');
    expect(offline.body).toMatchObject({ link: { state: 'linked' }, error: expect.stringContaining('nicht erreichbar') });
    relay.down = false;

    expect((await req<CloudStatus>('DELETE', '/api/system/cloud')).body.link).toEqual({ state: 'none' });
    expect(relay.key).toBeNull();
    const audit = await app.server.inject({ method: 'GET', url: '/api/audit?limit=10', headers: { cookie: admin } });
    expect(audit.body).toContain('Von Niedersachsen › Landkreis Diepholz › Weyhe getrennt');
  });

  it('nur für Admins', async () => {
    expect((await req('GET', '/api/system/cloud', undefined, '')).status).toBe(401);
    expect((await req('POST', '/api/system/cloud/link', { name: '' })).status).toBe(400);
  });
});
