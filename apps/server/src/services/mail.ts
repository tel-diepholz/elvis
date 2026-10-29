import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { simpleParser, type AddressObject } from 'mailparser';
import * as openpgp from 'openpgp';
import {
  MAIL_SIGNATURE_HEADER,
  mailDraftSchema,
  mailSignaturePayload,
  type MailAccountRequest,
  type MailAccountState,
  type MailAccountStatus,
  type MailAttachment,
  type MailboxStatus,
  type MailDraft,
  type MailEncryption,
  type MailFolder,
  type MailList,
  type MailMessage,
  type MailRecipientKey,
  type MailSendResult,
  type MailSignature,
  type MailSummary,
  type RelayMailBatch,
  type RelayStatus,
  type StatusLevel,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { checkPublicKey, generateMailKeys, keyFromAutocrypt, MailCrypto, MailVault, verifyDetached, wkdLookup, type StoredMailKeys, type WkdFetch } from './mailcrypto.js';
import { addressOf, compose, detectPgpMime, headerValue, mergeDecrypted, splitEntity, splitMessage, wrapEncrypted, wrapSigned } from './mailmime.js';
import { RelayError, type RelayClient } from './relay.js';

/** Anfrage ans Relay (für Tests austauschbar) */
export type MailFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }) => Promise<{ status: number; body: Buffer }>;

const defaultFetch: MailFetch = async (url, { method, headers, body, timeoutMs }) => {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

const STATE_KEY = 'mail:state';
const KEYS_KEY = 'mail:keys';
const TIMEOUT_MS = 30_000;
/** Erfolglose WKD-Suche erst nach einem Tag wiederholen */
const WKD_RETRY_MS = 24 * 3600_000;
const HEALTH_TTL_MS = 5 * 60_000;
/** Anhänge, die nur PGP/MIME-Technik sind */
const PGP_PARTS = /^application\/(pgp-signature|pgp-encrypted)$/i;

interface MailState {
  status: MailAccountState;
  address: string;
  adminEmail: string;
  fingerprint: string;
  requestedAt: string;
  activatedAt: string | null;
  keysMailedAt: string | null;
  lastFetchAt: string | null;
  lastFetchCountry: string | null;
  /** Letzte abgeholte Mail (seq im Relay) */
  cursor: number;
}

interface MessageRow {
  id: number;
  folder: MailFolder;
  relay_seq: number | null;
  message_id: string | null;
  in_reply_to: string | null;
  from_text: string;
  from_address: string;
  reply_to: string | null;
  to_json: string;
  cc_json: string;
  subject: string;
  date: string;
  body_text: string;
  body_html: string | null;
  encryption: MailEncryption;
  signature: MailSignature;
  seen: number;
  attachments?: number;
}

interface KeyRow {
  address: string;
  public_key: string | null;
  fingerprint: string | null;
  source: MailRecipientKey['source'];
  checked_at: string;
}

const addresses = (a: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => (v.name ? `${v.name} <${v.address ?? ''}>` : (v.address ?? '')))).filter(Boolean);

const summary = (r: MessageRow): MailSummary => ({
  id: r.id,
  folder: r.folder,
  from: r.from_text,
  to: JSON.parse(r.to_json) as string[],
  cc: JSON.parse(r.cc_json) as string[],
  subject: r.subject,
  date: r.date,
  seen: !!r.seen,
  encryption: r.encryption,
  signature: r.signature,
  attachments: r.attachments ?? 0,
  snippet: r.body_text.replace(/\s+/g, ' ').trim().slice(0, 160),
});

/** Autocrypt-Kopfzeile falten (keydata darf Leerraum enthalten) */
const foldAutocrypt = (value: string) => value.replace(/(.{1,76})(?=.)/g, '$1\r\n ');

/**
 * Postfach des ELW über das Cloud-Relay: beantragen, übernehmen, kündigen, Mails abholen, entschlüsseln, ablegen
 * und senden. Jeder Aufruf an das Postfach beim Relay ist mit dem Ed25519-Schlüssel des ELW signiert. Anders als
 * die App-Anbindung meldet sich ELVIS bei einem 401 nicht neu an – das Postfach hängt an diesem Zugang.
 */
export class MailService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private crypto: MailCrypto | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private health: { level: StatusLevel | null; at: number } = { level: null, at: 0 };
  private readonly vault: MailVault;

  constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly notify: (topics: Topic[]) => void,
    private readonly relay: RelayClient,
    private readonly opts: {
      enabled: boolean;
      pollMs: number;
      dataDir: string | ':memory:';
      /** Domain der Postfächer beim Relay */
      domain: string;
      vehicleName: () => string;
      fetch?: MailFetch;
      wkdFetch?: WkdFetch;
    },
  ) {
    this.vault = new MailVault(opts.dataDir);
  }

  get enabled(): boolean {
    return this.opts.enabled && this.relay.url !== null;
  }

  // --- Zustand ---

  private read<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private write(key: string, value: unknown, by: string): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
      .run(key, JSON.stringify(value), new Date().toISOString(), by);
  }

  private state(): MailState | null {
    return this.read<MailState>(STATE_KEY);
  }

  private setState(patch: Partial<MailState>, by = 'system'): void {
    const current = this.state();
    if (!current) return;
    const next = { ...current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    this.write(STATE_KEY, next, by);
    this.notify(['mail']);
  }

  private cryptoOf(): MailCrypto | null {
    const keys = this.read<StoredMailKeys>(KEYS_KEY);
    if (!keys) return (this.crypto = null);
    if (this.crypto?.keys.fingerprint !== keys.fingerprint) this.crypto = new MailCrypto(keys, this.vault);
    return this.crypto;
  }

  /** Postfach nutzbar (für Navigation und Bediener) */
  available(): { available: boolean; address: string | null } {
    const s = this.state();
    return { available: this.enabled && s?.status === 'active', address: s?.status === 'active' ? s.address : null };
  }

  status(): MailAccountStatus {
    const s = this.state();
    void this.refreshHealth();
    return {
      enabled: this.enabled,
      relayUrl: this.relay.url,
      state: s?.status ?? 'none',
      address: s?.address ?? null,
      fingerprint: s?.fingerprint ?? null,
      adminEmail: s?.adminEmail ?? null,
      requestedAt: s?.requestedAt ?? null,
      activatedAt: s?.activatedAt ?? null,
      keysMailedAt: s?.keysMailedAt ?? null,
      lastFetchAt: s?.lastFetchAt ?? null,
      lastFetchCountry: s?.lastFetchCountry ?? null,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      relayHealth: this.health.level,
    };
  }

  /** Gesamtstatus der Statusseite des Relays, höchstens alle 5 Minuten abgefragt */
  private async refreshHealth(): Promise<void> {
    if (!this.relay.url || Date.now() - this.health.at < HEALTH_TTL_MS) return;
    this.health.at = Date.now();
    try {
      const res = await (this.opts.fetch ?? defaultFetch)(`${this.relay.url.replace(/\/$/, '')}/v1/status`, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: 10_000 });
      this.health.level = res.status === 200 ? (JSON.parse(res.body.toString('utf8')) as RelayStatus).overall : 'outage';
    } catch {
      this.health.level = 'outage';
    }
  }

  // --- Relay ---

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Buffer }> {
    if (!this.enabled || !this.relay.url) throw new HttpError(503, 'E-Mail ist nicht eingerichtet (mail.enabled und app.relayUrl in config/elvis.json)');
    const { token } = await this.relay.ensureCredentials();
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...(raw && { 'content-type': 'application/json' }) };
    const crypto = this.cryptoOf();
    if (crypto) {
      const t = Date.now();
      const n = randomBytes(16).toString('base64url');
      const payload = mailSignaturePayload(method, path, createHash('sha256').update(raw).digest('hex'), t, n);
      headers[MAIL_SIGNATURE_HEADER] = `t=${t},n=${n},s=${await crypto.signRequest(payload)}`;
    }
    let res: { status: number; body: Buffer };
    try {
      res = await (this.opts.fetch ?? defaultFetch)(`${this.relay.url.replace(/\/$/, '')}${path}`, { method, headers, body: raw || undefined, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      throw new HttpError(502, `Cloud-Anbindung nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 400) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (JSON.parse(res.body.toString('utf8')) as { error?: string }).error ?? msg;
      } catch {
        /* kein JSON */
      }
      throw new RelayError(res.status, `Cloud: ${msg}`);
    }
    return res;
  }

  private async callJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body);
    return (res.body.length ? JSON.parse(res.body.toString('utf8')) : null) as T;
  }

  /** Zustand beim Relay abfragen und übernehmen */
  async refresh(): Promise<MailAccountStatus> {
    const s = this.state();
    if (!s || !this.enabled) return this.status();
    try {
      const r = await this.callJson<MailboxStatus>('GET', '/v1/elws/me/mailbox');
      this.lastError = null;
      const status: MailAccountState =
        r.status === 'none' ? (s.status === 'rebind-pending' || s.status === 'pending' ? 'none' : 'lost') : r.status;
      this.setState({
        status,
        activatedAt: r.activatedAt ?? s.activatedAt,
        keysMailedAt: r.keysMailedAt ?? s.keysMailedAt,
        lastFetchAt: r.lastFetchAt ?? s.lastFetchAt,
        lastFetchCountry: r.lastFetchCountry ?? s.lastFetchCountry,
        ...(status === 'active' && r.fingerprint && { fingerprint: r.fingerprint }),
      });
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    return this.status();
  }

  // --- Beantragen, übernehmen, kündigen (Admins) ---

  async request(input: MailAccountRequest, operator: string): Promise<MailAccountStatus> {
    if (!this.enabled) throw new HttpError(503, 'E-Mail ist nicht eingerichtet');
    const current = this.state();
    if (current && ['active', 'approval'].includes(current.status)) throw new HttpError(409, 'Es gibt schon ein Postfach – erst kündigen');
    // Offenen eigenen Antrag zurückziehen, damit der neue gilt
    if (current?.status === 'pending') await this.call('DELETE', '/v1/elws/me/mailbox').catch(() => undefined);

    const mode = input.mode ?? 'new';
    const address = `${input.localpart}@${this.opts.domain}`;
    const { keys, revocationCert } = await generateMailKeys(address, this.opts.vehicleName(), this.vault);
    // Bis zur Antwort des Relays gilt der alte Schlüssel weiter (Signatur des Antrags spielt keine Rolle)
    this.crypto = null;
    const previousKeys = this.read<StoredMailKeys>(KEYS_KEY);
    this.write(KEYS_KEY, null, operator);
    let r: MailboxStatus;
    try {
      r = await this.callJson<MailboxStatus>('POST', mode === 'new' ? '/v1/elws/me/mailbox' : '/v1/elws/me/mailbox/rebind', {
        localpart: input.localpart,
        adminEmail: input.adminEmail,
        publicKey: keys.publicKey,
        revocationCert,
        sigPublicKey: keys.sigPublicKey,
      });
    } catch (e) {
      if (previousKeys) this.write(KEYS_KEY, previousKeys, 'system');
      this.audit(operator, mode === 'new' ? 'request' : 'rebind', address, false, e instanceof Error ? e.message : String(e));
      throw e;
    }
    // Das Widerrufszertifikat geht nur über das Relay an den Admin, ELVIS behält keine Kopie
    this.write(KEYS_KEY, keys, operator);
    this.crypto = null;
    const state: MailState = {
      status: r.status === 'none' ? 'pending' : r.status,
      address: r.address ?? address,
      adminEmail: input.adminEmail,
      fingerprint: keys.fingerprint,
      requestedAt: new Date().toISOString(),
      activatedAt: null,
      keysMailedAt: null,
      lastFetchAt: null,
      lastFetchCountry: null,
      cursor: 0,
    };
    this.write(STATE_KEY, state, operator);
    this.lastError = null;
    this.audit(operator, mode === 'new' ? 'request' : 'rebind', address, true, `Bestätigungslink an ${input.adminEmail}`);
    this.notify(['mail', 'audit']);
    return this.status();
  }

  async cancel(operator: string): Promise<void> {
    const s = this.state();
    if (!s) return;
    if (['pending', 'approval', 'active'].includes(s.status)) await this.call('DELETE', '/v1/elws/me/mailbox');
    this.write(STATE_KEY, null, operator);
    this.write(KEYS_KEY, null, operator);
    this.crypto = null;
    this.audit(operator, 'cancel', s.address, true, s.status === 'active' ? 'Postfach gekündigt' : 'Antrag verworfen');
    this.notify(['mail', 'audit']);
  }

  private audit(operator: string, action: string, params: string, success: boolean, message: string): void {
    this.store.addAudit({ operator, target: 'mail', action, params, success, message });
  }

  // --- Abruf ---

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ein Lauf: neue Mails holen bzw. auf Bestätigung warten (überlappt nicht) */
  poll(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const s = this.state();
    if (!s || !this.enabled) return;
    if (s.status === 'pending' || s.status === 'approval' || s.status === 'rebind-pending') {
      await this.refresh();
      return;
    }
    if (s.status !== 'active') return;
    const crypto = this.cryptoOf();
    if (!crypto) return;
    try {
      let cursor = s.cursor;
      for (;;) {
        const batch = await this.callJson<RelayMailBatch>('GET', `/v1/elws/me/mail?after=${cursor}`);
        for (const item of batch.items) {
          const blob = (await this.call('GET', `/v1/elws/me/mail/${item.seq}`)).body;
          await this.ingest(crypto, blob, item.seq, item.receivedAt);
          cursor = item.seq;
          this.setState({ cursor });
        }
        if (batch.items.length < 100) break;
      }
      this.setState({ lastFetchAt: new Date().toISOString() });
      this.lastError = null;
    } catch (e) {
      if (e instanceof RelayError && e.status === 403) this.setState({ status: 'moved' });
      else if (e instanceof RelayError && e.status === 404) this.setState({ status: 'lost' });
      else if (e instanceof RelayError && e.status === 409) await this.refresh();
      this.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.lastPollAt = new Date().toISOString();
    }
  }

  /** Mail aus dem Relay entschlüsseln, PGP/MIME auspacken, Schlüssel aus Autocrypt lernen, ablegen */
  async ingest(crypto: MailCrypto, blob: Buffer, seq: number | null, receivedAt: string): Promise<number> {
    if (seq !== null) {
      const existing = this.db.prepare('SELECT id FROM mail_messages WHERE relay_seq = ?').get(seq) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    let raw: string;
    try {
      raw = (await crypto.decryptBlob(blob)).toString('latin1');
    } catch {
      // Nicht lesbar (z. B. mit einem alten Schlüssel verschlüsselt): sichtbar ablegen statt den Abruf zu blockieren
      return this.insert({ folder: 'inbox', seq, raw: blob, from: 'ELVIS', fromAddress: '', subject: 'Mail konnte nicht entschlüsselt werden', text: '', html: null, encryption: 'relay', signature: 'none', date: receivedAt, to: [], cc: [], messageId: null, inReplyTo: null, replyTo: null, attachments: [], by: 'system' });
    }

    const head = splitMessage(raw).head;
    const fromAddress = addressOf(headerValue(head, 'from') ?? '');
    const autocrypt = headerValue(head, 'autocrypt');
    if (autocrypt && fromAddress && fromAddress !== crypto.keys.address) {
      const learned = await keyFromAutocrypt(autocrypt, fromAddress);
      if (learned) this.saveKey(fromAddress, learned, 'autocrypt');
    }
    const senderKey = this.keyRow(fromAddress)?.public_key ?? null;

    let encryption: MailEncryption = 'relay';
    let signature: MailSignature = 'none';
    let final = raw;
    let pgp = detectPgpMime(raw);
    if (pgp?.kind === 'encrypted') {
      try {
        const res = await crypto.decryptMessage(pgp.armored, senderKey);
        final = mergeDecrypted(raw, res.data);
        encryption = 'e2e';
        signature = res.signature;
        pgp = detectPgpMime(final);
      } catch {
        signature = 'none';
        pgp = null;
      }
    }
    if (pgp?.kind === 'signed') signature = await verifyDetached(pgp.entity, pgp.signature, senderKey);

    const parsed = await simpleParser(Buffer.from(final, 'latin1'));
    const id = this.insert({
      folder: 'inbox',
      seq,
      raw: Buffer.from(final, 'latin1'),
      from: parsed.from?.text ?? fromAddress,
      fromAddress: parsed.from?.value[0]?.address?.toLowerCase() ?? fromAddress,
      subject: parsed.subject ?? '',
      text: parsed.text ?? '',
      html: typeof parsed.html === 'string' ? parsed.html : null,
      encryption,
      signature,
      date: (parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : new Date(receivedAt)).toISOString(),
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      replyTo: parsed.replyTo?.text ?? null,
      attachments: parsed.attachments
        .filter((a) => !PGP_PARTS.test(a.contentType) && a.filename !== 'encrypted.asc')
        .map((a) => ({ filename: a.filename ?? 'anhang', contentType: a.contentType, content: a.content })),
      by: 'system',
    });
    this.notify(['mail']);
    return id;
  }

  private insert(m: {
    folder: MailFolder;
    seq: number | null;
    raw: Buffer;
    from: string;
    fromAddress: string;
    subject: string;
    text: string;
    html: string | null;
    encryption: MailEncryption;
    signature: MailSignature;
    date: string;
    to: string[];
    cc: string[];
    messageId: string | null;
    inReplyTo: string | null;
    replyTo: string | null;
    attachments: { filename: string; contentType: string; content: Buffer }[];
    by: string;
  }): number {
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `INSERT INTO mail_messages (folder, relay_seq, message_id, in_reply_to, from_text, from_address, reply_to, to_json, cc_json, subject, date, body_text, body_html, encryption, signature, seen, raw, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.folder, m.seq, m.messageId, m.inReplyTo, m.from, m.fromAddress, m.replyTo, JSON.stringify(m.to), JSON.stringify(m.cc), m.subject, m.date, m.text, m.html, m.encryption, m.signature, m.folder === 'sent' ? 1 : 0, m.raw, new Date().toISOString(), m.by);
      const id = Number(r.lastInsertRowid);
      const att = this.db.prepare('INSERT INTO mail_attachments (message_id, filename, content_type, size, content) VALUES (?, ?, ?, ?, ?)');
      for (const a of m.attachments) att.run(id, a.filename, a.contentType, a.content.length, a.content);
      return id;
    })();
  }

  // --- Lesen (Bediener) ---

  list(folder: MailFolder): MailList {
    const rows = this.db
      .prepare(
        'SELECT m.*, (SELECT COUNT(*) FROM mail_attachments a WHERE a.message_id = m.id) AS attachments FROM mail_messages m WHERE folder = ? ORDER BY date DESC, id DESC LIMIT 500',
      )
      .all(folder) as MessageRow[];
    return { items: rows.map(summary), unread: this.unread() };
  }

  unread(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM mail_messages WHERE folder = 'inbox' AND seen = 0").get() as { n: number }).n;
  }

  private row(id: number): MessageRow {
    const r = this.db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(id) as MessageRow | undefined;
    if (!r) throw new HttpError(404, 'Mail nicht gefunden');
    return r;
  }

  message(id: number): MailMessage {
    const r = this.row(id);
    const attachments = (this.db.prepare('SELECT id, filename, content_type AS contentType, size FROM mail_attachments WHERE message_id = ? ORDER BY id').all(id) as MailAttachment[]);
    const { attachments: _count, ...base } = summary(r);
    return { ...base, messageId: r.message_id, replyTo: r.reply_to, text: r.body_text, html: r.body_html, attachments, fromAddress: r.from_address };
  }

  setSeen(id: number, seen: boolean): void {
    this.row(id);
    this.db.prepare('UPDATE mail_messages SET seen = ? WHERE id = ?').run(seen ? 1 : 0, id);
    this.notify(['mail']);
  }

  remove(id: number, operator: string): void {
    const r = this.row(id);
    this.db.prepare('DELETE FROM mail_messages WHERE id = ?').run(id);
    this.audit(operator, 'delete', r.subject, true, `${r.folder === 'inbox' ? 'Von' : 'An'} ${r.folder === 'inbox' ? r.from_text : JSON.parse(r.to_json).join(', ')}`);
    this.notify(['mail', 'audit']);
  }

  attachment(id: number): { filename: string; contentType: string; content: Buffer } {
    const a = this.db.prepare('SELECT filename, content_type AS contentType, content FROM mail_attachments WHERE id = ?').get(id) as
      | { filename: string; contentType: string; content: Buffer }
      | undefined;
    if (!a) throw new HttpError(404, 'Anhang nicht gefunden');
    return a;
  }

  raw(id: number): Buffer {
    const r = this.db.prepare('SELECT raw FROM mail_messages WHERE id = ?').get(id) as { raw: Buffer } | undefined;
    if (!r) throw new HttpError(404, 'Mail nicht gefunden');
    return r.raw;
  }

  // --- Schlüssel der Gegenstellen ---

  private keyRow(address: string): KeyRow | undefined {
    return this.db.prepare('SELECT * FROM mail_keys WHERE address = ?').get(address.toLowerCase()) as KeyRow | undefined;
  }

  private saveKey(address: string, key: { armored: string; fingerprint: string } | null, source: NonNullable<MailRecipientKey['source']>): void {
    const existing = this.keyRow(address);
    // Von Hand importierte Schlüssel überschreibt nur ein neuer Import
    if (existing?.source === 'manual' && source !== 'manual') return;
    const ts = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO mail_keys (address, public_key, fingerprint, source, checked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET public_key = excluded.public_key, fingerprint = excluded.fingerprint, source = excluded.source, checked_at = excluded.checked_at, updated_at = excluded.updated_at',
      )
      .run(address.toLowerCase(), key?.armored ?? null, key?.fingerprint ?? null, key ? source : null, ts, ts);
  }

  keys(): MailRecipientKey[] {
    return (this.db.prepare('SELECT * FROM mail_keys WHERE public_key IS NOT NULL ORDER BY address').all() as KeyRow[]).map((r) => ({
      address: r.address,
      encrypt: true,
      fingerprint: r.fingerprint,
      source: r.source,
    }));
  }

  async importKey(armored: string, operator: string): Promise<MailRecipientKey[]> {
    let key: { armored: string; fingerprint: string };
    try {
      key = await checkPublicKey({ armored });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'Schlüssel ungültig');
    }
    const emails = [...new Set((await openpgp.readKey({ armoredKey: key.armored })).users.map((u) => u.userID?.email.toLowerCase()).filter((e): e is string => !!e))];
    if (!emails.length) throw new HttpError(400, 'Schlüssel enthält keine Mailadresse');
    for (const e of emails) this.saveKey(e, key, 'manual');
    this.audit(operator, 'key-import', emails.join(', '), true, key.fingerprint);
    this.notify(['mail', 'audit']);
    return emails.map((address) => ({ address, encrypt: true, fingerprint: key.fingerprint, source: 'manual' }));
  }

  removeKey(address: string, operator: string): void {
    this.db.prepare('DELETE FROM mail_keys WHERE address = ?').run(address.toLowerCase());
    this.audit(operator, 'key-delete', address, true, '');
    this.notify(['mail', 'audit']);
  }

  /** Schlüssel für Empfänger: bekannt, sonst per WKD suchen (Fehlschläge einen Tag lang merken) */
  async recipients(list: string[]): Promise<MailRecipientKey[]> {
    const own = this.state()?.address;
    return Promise.all(
      [...new Set(list.map((a) => a.trim().toLowerCase()).filter(Boolean))].map(async (address) => {
        let row = this.keyRow(address);
        if (!row?.public_key && (!row || Date.now() - new Date(row.checked_at).getTime() > WKD_RETRY_MS)) {
          const found = address === own ? null : await wkdLookup(address, this.opts.wkdFetch).catch(() => null);
          this.saveKey(address, found, 'wkd');
          row = this.keyRow(address);
        }
        if (address === own) {
          const keys = this.cryptoOf()?.keys;
          return { address, encrypt: !!keys, fingerprint: keys?.fingerprint ?? null, source: null };
        }
        return { address, encrypt: !!row?.public_key, fingerprint: row?.fingerprint ?? null, source: row?.public_key ? row.source : null };
      }),
    );
  }

  // --- Senden ---

  async send(input: MailDraft, operator: string): Promise<MailSendResult> {
    const draft = mailDraftSchema.parse(input);
    const s = this.state();
    const crypto = this.cryptoOf();
    if (!s || s.status !== 'active' || !crypto) throw new HttpError(409, 'Kein aktives Postfach');
    const all = [...new Set([...draft.to, ...draft.cc, ...draft.bcc])];
    const keys = await this.recipients(all);
    const missing = keys.filter((k) => !k.encrypt).map((k) => k.address);
    const encrypt = missing.length === 0;
    if (!encrypt && !draft.allowUnencrypted) throw new HttpError(409, `Kein Schlüssel für ${missing.join(', ')} – nur unverschlüsselt möglich`);

    const original = draft.replyToId ? this.row(draft.replyToId) : null;
    const domain = s.address.split('@')[1]!;
    const raw = await compose({
      from: `${this.opts.vehicleName().replace(/[<>"]/g, '')} <${s.address}>`,
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      text: draft.text,
      attachments: draft.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.data, 'base64') })),
      messageId: `<${randomUUID()}@${domain}>`,
      inReplyTo: original?.message_id ?? null,
      references: original?.message_id ?? null,
      headers: { Autocrypt: foldAutocrypt(await crypto.autocryptHeader()) },
      date: new Date(),
    });
    const { outer, entity } = splitEntity(raw);
    let final: string;
    if (encrypt) {
      const recipientKeys = all.filter((a) => a !== s.address).map((a) => this.keyRow(a)!.public_key!);
      final = wrapEncrypted(outer, await crypto.encryptAndSign(entity, recipientKeys));
    } else {
      const { signature, micalg } = await crypto.signDetached(entity);
      final = wrapSigned(outer, entity, signature, micalg);
    }

    let sent: number;
    try {
      sent = (await this.callJson<{ sent: number }>('POST', '/v1/elws/me/mail/outbox', { to: all, raw: Buffer.from(final, 'latin1').toString('base64') })).sent;
    } catch (e) {
      this.audit(operator, 'send', all.join(', '), false, e instanceof Error ? e.message : String(e));
      this.notify(['audit']);
      // Meldung des Relays (z. B. Versandlimit, Tageskontingent erschöpft) an die Oberfläche statt „Interner Fehler“
      if (e instanceof RelayError) throw new HttpError(e.status === 429 ? 429 : 502, e.message);
      throw e;
    }

    const parsed = await simpleParser(Buffer.from(raw, 'latin1'));
    const id = this.insert({
      folder: 'sent',
      seq: null,
      raw: Buffer.from(raw, 'latin1'),
      from: parsed.from?.text ?? s.address,
      fromAddress: s.address,
      subject: draft.subject,
      text: draft.text,
      html: null,
      encryption: encrypt ? 'e2e' : 'none',
      signature: 'valid',
      date: (parsed.date ?? new Date()).toISOString(),
      to: [...draft.to, ...draft.bcc.map((b) => `${b} (Bcc)`)],
      cc: draft.cc,
      messageId: parsed.messageId ?? null,
      inReplyTo: original?.message_id ?? null,
      replyTo: null,
      attachments: draft.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.data, 'base64') })),
      by: operator,
    });
    this.audit(operator, 'send', all.join(', '), sent === all.length, `${draft.subject || '(ohne Betreff)'} – ${encrypt ? 'verschlüsselt' : 'unverschlüsselt'}${sent < all.length ? `, nur ${sent} von ${all.length} zugestellt` : ''}`);
    this.notify(['mail', 'audit']);
    if (sent < all.length) throw new HttpError(502, `Nur an ${sent} von ${all.length} Empfängern versendet`);
    return { id, encrypted: encrypt };
  }
}
