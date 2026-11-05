import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { MAIL_SIGNATURE_HEADER, mailSignaturePayload, type CloudLinkRequest, type CloudLinkStatus, type CloudStatus, type Topic } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { MailVault } from './mailcrypto.js';
import { RelayError, type RelayClient } from './relay.js';

export type CloudFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Buffer; timeoutMs: number }) => Promise<{ status: number; body: string | Buffer }>;

const defaultFetch: CloudFetch = async (url, { method, headers, body, timeoutMs }) => {
  const res = await fetch(url, { method, headers, body: typeof body === 'string' || body === undefined ? body : new Uint8Array(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

const KEY_KEY = 'cloud:key';
const STATE_KEY = 'cloud:state';
const TIMEOUT_MS = 15_000;
/** So lange gilt ein abgefragter Stand (das Portal pollt beim offenen Code öfter) */
const CACHE_MS = 4_000;

interface StoredKey {
  /** Ed25519 öffentlich (raw, base64url) und privat (PKCS#8, mit mail.secret versiegelt) */
  sigPublicKey: string;
  sigPrivateKey: string;
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/**
 * Cloud-Zugang: Verknüpfung der Installation mit einem Knoten der Baustruktur im Portal. ELVIS fordert einen Code an,
 * ein Verwalter gibt ihn im Portal ein. Alle Aufrufe sind mit einem eigenen Ed25519-Schlüssel signiert; der private
 * Schlüssel liegt versiegelt in der Datenbank (Passphrase in mail.secret, wie beim Postfach).
 */
export class CloudService {
  private readonly vault: MailVault;
  private signer: Promise<webcrypto.CryptoKey> | null = null;
  private checkedAt = 0;
  private lastError: string | null = null;
  private readonly unlinkListeners: (() => void)[] = [];
  private readonly linkListeners: (() => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly relay: RelayClient,
    private readonly opts: { dataDir: string; portalUrl: string; version: string; notify: (t: Topic[]) => void; fetch?: CloudFetch },
  ) {
    this.vault = new MailVault(opts.dataDir);
  }

  private setting<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }

  private save(key: string, value: unknown | null, by = 'system'): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else
      this.db
        .prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
        .run(key, JSON.stringify(value), new Date().toISOString(), by);
  }

  /** Zuletzt bekannter Stand (ohne Relay) */
  private known(): CloudLinkStatus {
    return this.setting<CloudLinkStatus>(STATE_KEY) ?? { state: 'none' };
  }

  private remember(link: CloudLinkStatus): void {
    const prev = this.known();
    const before = JSON.stringify(prev);
    this.save(STATE_KEY, link.state === 'none' ? null : link);
    if (JSON.stringify(link) !== before) this.opts.notify(['cloud']);
    // Verknüpft bzw. getrennt (auch im Portal): Abgleich anstoßen bzw. Cloud-Daten zu lokalen machen
    if (prev.state !== 'linked' && link.state === 'linked') for (const cb of this.linkListeners) cb();
    if (prev.state === 'linked' && link.state !== 'linked') for (const cb of this.unlinkListeners) cb();
  }

  private async key(create: boolean): Promise<StoredKey | null> {
    const stored = this.setting<StoredKey>(KEY_KEY);
    if (stored || !create) return stored;
    const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const key = {
      sigPublicKey: b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))),
      sigPrivateKey: this.vault.seal(Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey))),
    };
    this.save(KEY_KEY, key);
    this.signer = null;
    return key;
  }

  private async call<T>(method: string, path: string, key: StoredKey, body?: unknown): Promise<T> {
    const res = await this.callRaw(method, path, key, body === undefined ? '' : JSON.stringify(body), 'application/json');
    const text = res.toString('utf8');
    return (text ? JSON.parse(text) : null) as T;
  }

  private async callRaw(method: string, path: string, key: StoredKey, raw: string | Buffer, contentType: string): Promise<Buffer> {
    if (!this.relay.url) throw new HttpError(503, 'Cloud-Anbindung ist nicht eingerichtet (app.relayUrl in config/elvis.json)');
    const { token } = await this.relay.ensureCredentials();
    const t = Date.now();
    const n = randomBytes(16).toString('base64url');
    this.signer ??= webcrypto.subtle.importKey('pkcs8', this.vault.open(key.sigPrivateKey), { name: 'Ed25519' }, false, ['sign']);
    const payload = mailSignaturePayload(method, path, createHash('sha256').update(raw).digest('hex'), t, n);
    const sig = b64url(new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, await this.signer, new TextEncoder().encode(payload))));
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'x-elvis-version': this.opts.version,
      [MAIL_SIGNATURE_HEADER]: `t=${t},n=${n},s=${sig}`,
      ...(raw.length && { 'content-type': contentType }),
    };
    let res: { status: number; body: string | Buffer };
    try {
      // Dateien (bis 50 MB) brauchen länger
      res = await (this.opts.fetch ?? defaultFetch)(`${this.relay.url.replace(/\/$/, '')}${path}`, { method, headers, body: raw.length ? raw : undefined, timeoutMs: typeof raw === 'string' ? TIMEOUT_MS : 300_000 });
    } catch (e) {
      throw new HttpError(502, `Cloud nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    const body = typeof res.body === 'string' ? Buffer.from(res.body) : res.body;
    if (res.status >= 400) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (JSON.parse(body.toString('utf8')) as { error?: string }).error ?? msg;
      } catch {
        /* kein JSON */
      }
      throw new RelayError(res.status, `Cloud: ${msg}`);
    }
    return body;
  }

  /** Signierter Aufruf mit Datei (hochladen) bzw. Datei als Antwort (abholen) */
  async signedRaw(method: 'GET' | 'PUT', path: string, body?: Buffer): Promise<Buffer> {
    const key = await this.key(false);
    if (!key) throw new HttpError(409, 'Nicht mit der Cloud verknüpft');
    return this.callRaw(method, path, key, body ?? '', 'application/octet-stream');
  }

  /** Verknüpft (zuletzt bekannter Stand) */
  linked(): boolean {
    return this.known().state === 'linked';
  }

  /** Signierter Aufruf beim Relay mit dem Schlüssel der Verknüpfung (Stammdaten-Abgleich) */
  async signed<T>(method: string, path: string, body?: unknown): Promise<T> {
    const key = await this.key(false);
    if (!key) throw new HttpError(409, 'Nicht mit der Cloud verknüpft');
    return this.call<T>(method, path, key, body);
  }

  /** Beim Trennen (hier oder im Portal) */
  onUnlink(cb: () => void): void {
    this.unlinkListeners.push(cb);
  }

  /** Sobald die Verknüpfung bekannt wird (Code im Portal eingegeben) */
  onLink(cb: () => void): void {
    this.linkListeners.push(cb);
  }

  private view(link: CloudLinkStatus): CloudStatus {
    return { available: this.relay.enabled, portalUrl: this.opts.portalUrl, link, error: this.lastError, checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null };
  }

  /** Stand beim Relay abfragen (kurz zwischengespeichert); ohne Relay der zuletzt bekannte */
  async status(force = false): Promise<CloudStatus> {
    const key = await this.key(false);
    if (!this.relay.enabled || !key) return this.view(this.known());
    if (!force && Date.now() - this.checkedAt < CACHE_MS) return this.view(this.known());
    try {
      const link = await this.call<CloudLinkStatus>('GET', '/v1/elws/me/cloud', key);
      this.lastError = null;
      this.remember(link);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    this.checkedAt = Date.now();
    return this.view(this.known());
  }

  /** Verknüpfungscode anfordern (ersetzt einen offenen) */
  async requestLink(name: string, operator: string): Promise<CloudStatus> {
    const key = (await this.key(true))!;
    const body: CloudLinkRequest = { name, sigPublicKey: key.sigPublicKey, version: this.opts.version };
    const link = await this.call<CloudLinkStatus>('POST', '/v1/elws/me/cloud/link', key, body);
    this.lastError = null;
    this.checkedAt = Date.now();
    this.remember(link);
    this.store.addAudit({ operator, target: 'cloud', action: 'link', params: '', success: true, message: `Verknüpfungscode für „${name}“ angefordert` });
    this.opts.notify(['audit']);
    return this.view(link);
  }

  /** Verknüpfung trennen bzw. offenen Code zurückziehen; der Schlüssel wird verworfen */
  async unlink(operator: string): Promise<CloudStatus> {
    const key = await this.key(false);
    const before = this.known();
    if (key) {
      try {
        await this.call('DELETE', '/v1/elws/me/cloud', key);
      } catch (e) {
        // Relay kennt die Installation nicht mehr: lokal trotzdem trennen
        if (!(e instanceof RelayError && (e.status === 401 || e.status === 404))) throw e;
      }
    }
    this.save(KEY_KEY, null);
    this.signer = null;
    this.remember({ state: 'none' });
    this.lastError = null;
    if (before.state !== 'none') {
      this.store.addAudit({ operator, target: 'cloud', action: 'unlink', params: '', success: true, message: before.state === 'linked' ? `Von ${before.node.path.join(' › ')} getrennt` : 'Verknüpfungscode zurückgezogen' });
      this.opts.notify(['audit']);
    }
    return this.view({ state: 'none' });
  }
}
