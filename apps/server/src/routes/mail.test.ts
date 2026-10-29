import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_SIGNATURE_HEADER, mailSignaturePayload, type MailAccountStatus, type MailList, type MailMessage, type MailRecipientKey } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { MailFetch } from '../services/mail.js';
import { detectPgpMime, splitMessage } from '../services/mailmime.js';
import { verifyDetached, wkdHash, type WkdFetch } from '../services/mailcrypto.js';
import type { RelayFetch } from '../services/relay.js';
import { adminCookie } from '../test-helpers.js';

const RELAY = 'https://relay.test';
const ADDRESS = 'elw2-diepholz@einsatzleitwagen.app';

/** Relay im Speicher: prüft die Signaturen wie das echte Relay und verschlüsselt eingehende Mails mit dem ELW-Schlüssel */
class FakeRelay {
  mailbox: { status: string; publicKey: string; sigPublicKey: string; revocationCert: string; adminEmail: string } | null = null;
  inbox: { seq: number; blob: Uint8Array }[] = [];
  sent: { to: string[]; raw: string }[] = [];
  nonces = new Set<string>();
  moved = false;
  sendError: { status: number; error: string } | null = null;
  seq = 0;

  relayFetch: RelayFetch = async (_url, { method }) => (method === 'POST' ? { status: 201, body: { elwId: 'E1', token: 'elw-token' } } : { status: 404, body: null });

  private async signed(path: string, method: string, headers: Record<string, string>, body: string): Promise<boolean> {
    if (!this.mailbox) return false;
    const parts = Object.fromEntries((headers[MAIL_SIGNATURE_HEADER] ?? '').split(',').map((p) => p.split('=', 2) as [string, string]));
    if (!parts.s || this.nonces.has(parts.n!)) return false;
    this.nonces.add(parts.n!);
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(this.mailbox.sigPublicKey, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
    const payload = mailSignaturePayload(method, path, createHash('sha256').update(body).digest('hex'), Number(parts.t), parts.n!);
    return webcrypto.subtle.verify({ name: 'Ed25519' }, key, Buffer.from(parts.s, 'base64url'), new TextEncoder().encode(payload));
  }

  fetch: MailFetch = async (url, { method, headers, body = '' }) => {
    const path = url.slice(RELAY.length);
    const json = (status: number, b: unknown) => ({ status, body: Buffer.from(b === null ? '' : JSON.stringify(b)) });
    if (path === '/v1/status') return json(200, { overall: 'ok' });
    if (headers.authorization !== 'Bearer elw-token') return json(401, { error: 'ELW nicht angemeldet' });
    if (this.moved) return path === '/v1/elws/me/mailbox' ? json(200, { status: 'moved' }) : json(403, { error: 'Postfach wurde übertragen' });

    if (method === 'POST' && (path === '/v1/elws/me/mailbox' || path === '/v1/elws/me/mailbox/rebind')) {
      const b = JSON.parse(body) as { localpart: string; adminEmail: string; publicKey: string; revocationCert: string; sigPublicKey: string };
      this.mailbox = { status: path.endsWith('rebind') ? 'rebind-pending' : 'pending', ...b };
      return json(path.endsWith('rebind') ? 202 : 201, { status: this.mailbox.status, address: `${b.localpart}@einsatzleitwagen.app` });
    }
    if (!(await this.signed(path, method, headers, body))) return json(401, { error: 'Signatur ungültig' });
    if (method === 'GET' && path === '/v1/elws/me/mailbox') return json(200, { status: this.mailbox!.status, address: ADDRESS, activatedAt: null, keysMailedAt: null });
    if (method === 'DELETE' && path === '/v1/elws/me/mailbox') {
      this.mailbox = null;
      return json(204, null);
    }
    const list = /^\/v1\/elws\/me\/mail\?after=(\d+)$/.exec(path);
    if (method === 'GET' && list) {
      this.inbox = this.inbox.filter((m) => m.seq > Number(list[1]));
      const items = this.inbox.map((m) => ({ seq: m.seq, size: m.blob.length, receivedAt: '2026-10-25T10:00:00.000Z' }));
      return json(200, { items, next: items.at(-1)?.seq ?? Number(list[1]) });
    }
    const one = /^\/v1\/elws\/me\/mail\/(\d+)$/.exec(path);
    if (method === 'GET' && one) return { status: 200, body: Buffer.from(this.inbox.find((m) => m.seq === Number(one[1]))!.blob) };
    if (method === 'POST' && path === '/v1/elws/me/mail/outbox') {
      if (this.sendError) return json(this.sendError.status, { error: this.sendError.error });
      const b = JSON.parse(body) as { to: string[]; raw: string };
      this.sent.push({ to: b.to, raw: Buffer.from(b.raw, 'base64').toString('latin1') });
      return json(200, { sent: b.to.length });
    }
    return json(404, { error: 'Nicht gefunden' });
  };

  /** Eingang wie beim Relay: ganze Rohmail mit dem Schlüssel des ELW verschlüsseln */
  async deliver(raw: string) {
    const encryptionKeys = await openpgp.readKey({ armoredKey: this.mailbox!.publicKey });
    const blob = (await openpgp.encrypt({ message: await openpgp.createMessage({ binary: Buffer.from(`Return-Path: <x@example.org>\r\n${raw}`, 'latin1') }), encryptionKeys, format: 'binary' })) as Uint8Array;
    this.inbox.push({ seq: ++this.seq, blob });
  }
}

let app: App;
let dataDir: string;
let admin = '';
let relay: FakeRelay;
let wkd: Map<string, Uint8Array>;

type Method = 'GET' | 'POST' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie: admin } });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-mail-'));
  relay = new FakeRelay();
  wkd = new Map();
  const wkdFetch: WkdFetch = async (url) => {
    const hit = [...wkd].find(([hu]) => url.includes(`/hu/${hu}`));
    return hit ? { status: 200, body: hit[1] } : { status: 404, body: new Uint8Array() };
  };
  app = await buildApp(parseConfig({ dataDir, app: { relayUrl: RELAY } }), { logger: false, relayFetch: relay.relayFetch, mailFetch: relay.fetch, wkdFetch });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function activate() {
  const res = await req<MailAccountStatus>('POST', '/api/system/mail', { localpart: 'ELW2-Diepholz', adminEmail: 'admin@feuerwehr.example' });
  expect(res.status).toBe(201);
  relay.mailbox!.status = 'active';
  await app.mail.poll();
  return res.body;
}

/** Gegenstelle mit eigenem Schlüssel */
async function party(email = 'leitstelle@example.org') {
  const k = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ name: 'Leitstelle', email }], format: 'object' });
  return { email, privateKey: k.privateKey, publicKey: k.publicKey };
}

describe('E-Mail', () => {
  it('beantragt ein Postfach mit eigenem Schlüssel und wird nach Bestätigung aktiv', async () => {
    const res = await req<MailAccountStatus>('POST', '/api/system/mail', { localpart: 'ELW2-Diepholz', adminEmail: 'admin@feuerwehr.example' });
    expect(res.body).toMatchObject({ state: 'pending', address: ADDRESS, adminEmail: 'admin@feuerwehr.example' });
    const key = await openpgp.readKey({ armoredKey: relay.mailbox!.publicKey });
    expect(key.users[0]!.userID!.email).toBe(ADDRESS);
    expect(key.isPrivate()).toBe(false);
    expect(res.body.fingerprint).toBe(key.getFingerprint().toUpperCase());
    // Passphrase liegt getrennt von der Datenbank und ist nur für den Dienst lesbar
    expect(statSync(join(dataDir, 'mail.secret')).mode & 0o077).toBe(0);
    expect((await req<{ available: boolean }>('GET', '/api/mail/available')).body.available).toBe(false);

    relay.mailbox!.status = 'active';
    expect((await req<MailAccountStatus>('GET', '/api/system/mail')).body.state).toBe('active');
    expect((await req<{ available: boolean }>('GET', '/api/mail/available')).body).toEqual({ available: true, address: ADDRESS });
    expect((await req<MailAccountStatus>('POST', '/api/system/mail', { localpart: 'neu', adminEmail: 'a@b.de' })).status).toBe(409);
  });

  it('holt Mails ab, entschlüsselt sie und lernt Schlüssel aus Autocrypt', async () => {
    await activate();
    const p = await party();
    const autocrypt = `addr=${p.email}; prefer-encrypt=mutual; keydata=${Buffer.from(p.publicKey.write()).toString('base64')}`;
    await relay.deliver(`From: Leitstelle <${p.email}>\r\nTo: ${ADDRESS}\r\nSubject: =?UTF-8?Q?Lage=C3=BCbersicht?=\r\nAutocrypt: ${autocrypt}\r\nMessage-ID: <1@example.org>\r\nDate: Sun, 25 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBitte melden.\r\n`);
    await app.mail.poll();

    const list = (await req<MailList>('GET', '/api/mail/messages?folder=inbox')).body;
    expect(list.unread).toBe(1);
    expect(list.items[0]).toMatchObject({ subject: 'Lageübersicht', encryption: 'relay', signature: 'none', seen: false });
    const mail = (await req<MailMessage>('GET', `/api/mail/messages/${list.items[0]!.id}`)).body;
    expect(mail.text.trim()).toBe('Bitte melden.');
    expect(mail.fromAddress).toBe(p.email);
    expect((await req<MailRecipientKey[]>('GET', '/api/mail/keys')).body).toEqual([{ address: p.email, encrypt: true, fingerprint: p.publicKey.getFingerprint().toUpperCase(), source: 'autocrypt' }]);

    // Abgeholt und bestätigt: beim nächsten Lauf löscht das Relay
    await app.mail.poll();
    expect(relay.inbox).toHaveLength(0);
    expect((await req<MailList>('GET', '/api/mail/messages')).body.items).toHaveLength(1);
  });

  it('entschlüsselt PGP/MIME der Gegenstelle und prüft die Signatur', async () => {
    await activate();
    const p = await party();
    await req('POST', '/api/mail/keys', { publicKey: p.publicKey.armor() });
    const own = await openpgp.readKey({ armoredKey: relay.mailbox!.publicKey });
    const inner = 'Content-Type: text/plain; charset=utf-8\r\nSubject: Geheim\r\n\r\nNur für den ELW.\r\n';
    const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: inner }), encryptionKeys: own, signingKeys: p.privateKey });
    const b = 'XYZ';
    await relay.deliver(
      `From: ${p.email}\r\nTo: ${ADDRESS}\r\nSubject: ...\r\nMIME-Version: 1.0\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n${armored}\r\n--${b}--\r\n`,
    );
    await app.mail.poll();
    const [item] = (await req<MailList>('GET', '/api/mail/messages')).body.items;
    expect(item).toMatchObject({ subject: 'Geheim', encryption: 'e2e', signature: 'valid', attachments: 0 });
    expect((await req<MailMessage>('GET', `/api/mail/messages/${item!.id}`)).body.text.trim()).toBe('Nur für den ELW.');
  });

  it('verschlüsselt an Empfänger mit Schlüssel (WKD) und sendet sonst nur nach Bestätigung signiert', async () => {
    await activate();
    const p = await party();
    wkd.set(wkdHash('leitstelle'), p.publicKey.write());

    const keys = (await req<MailRecipientKey[]>('POST', '/api/mail/recipients', { addresses: [p.email, 'ohne@example.org'] })).body;
    expect(keys.map((k) => [k.address, k.encrypt, k.source])).toEqual([
      [p.email, true, 'wkd'],
      ['ohne@example.org', false, null],
    ]);

    // Verschlüsselt: nur die Gegenstelle kann lesen, Signatur des ELW ist gültig
    const ok = await req<{ id: number; encrypted: boolean }>('POST', '/api/mail/send', { to: [p.email], subject: 'Rückmeldung', text: 'Verstanden – ELW 2', attachments: [{ filename: 'lage.txt', contentType: 'text/plain', data: Buffer.from('Lage').toString('base64') }] });
    expect(ok.body.encrypted).toBe(true);
    const enc = relay.sent.at(-1)!;
    expect(enc.to).toEqual([p.email]);
    expect(enc.raw).not.toContain('Verstanden');
    expect(splitMessage(enc.raw).head).toContain('Autocrypt: addr=elw2-diepholz@einsatzleitwagen.app');
    const pgp = detectPgpMime(enc.raw);
    expect(pgp?.kind).toBe('encrypted');
    const own = await openpgp.readKey({ armoredKey: relay.mailbox!.publicKey });
    const dec = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: pgp!.kind === 'encrypted' ? pgp!.armored : '' }), decryptionKeys: p.privateKey, verificationKeys: own });
    expect(dec.data).toContain('filename=lage.txt');
    await expect(dec.signatures[0]!.verified).resolves.toBe(true);

    // Ohne Schlüssel: erst nach Bestätigung, dann signiert
    expect((await req('POST', '/api/mail/send', { to: ['ohne@example.org'], subject: 'Info', text: 'Hallo' })).status).toBe(409);
    const plain = await req<{ encrypted: boolean }>('POST', '/api/mail/send', { to: ['ohne@example.org'], bcc: ['chef@example.org'], subject: 'Info', text: 'Hallo', allowUnencrypted: true });
    expect(plain.body.encrypted).toBe(false);
    const signed = relay.sent.at(-1)!;
    expect(signed.to).toEqual(['ohne@example.org', 'chef@example.org']);
    expect(signed.raw).not.toMatch(/^Bcc:/im);
    const s = detectPgpMime(signed.raw);
    expect(s?.kind).toBe('signed');
    if (s?.kind === 'signed') expect(await verifyDetached(s.entity, s.signature, own.armor())).toBe('valid');

    const sent = (await req<MailList>('GET', '/api/mail/messages?folder=sent')).body.items;
    expect(sent.map((m) => [m.subject, m.encryption])).toEqual([
      ['Info', 'none'],
      ['Rückmeldung', 'e2e'],
    ]);
    const audit = (await req<{ target: string; action: string }[]>('GET', '/api/audit')).body.filter((e) => e.target === 'mail');
    expect(audit.filter((e) => e.action === 'send')).toHaveLength(2);
    // Fehler des Relays kommen mit seiner Meldung an, nicht als „Interner Fehler“
    relay.sendError = { status: 429, error: 'Das Tageskontingent für den Mailversand des Relays ist erschöpft, Versand erst morgen wieder möglich' };
    const quota = await req<{ error: string }>('POST', '/api/mail/send', { to: ['ohne@example.org'], subject: 'Info', text: 'Hallo', allowUnencrypted: true });
    expect(quota.status).toBe(429);
    expect(quota.body.error).toMatch(/^Cloud: Das Tageskontingent/);
    relay.sendError = { status: 502, error: 'Versand fehlgeschlagen' };
    expect((await req('POST', '/api/mail/send', { to: ['ohne@example.org'], subject: 'Info', text: 'Hallo', allowUnencrypted: true })).status).toBe(502);
  });

  it('erkennt ein übertragenes Postfach und kündigt', async () => {
    await activate();
    relay.moved = true;
    await app.mail.poll();
    expect((await req<MailAccountStatus>('GET', '/api/system/mail')).body.state).toBe('moved');
    expect((await req('DELETE', '/api/system/mail')).status).toBe(204);
    expect((await req<MailAccountStatus>('GET', '/api/system/mail')).body.state).toBe('none');

    relay.moved = false;
    await activate();
    expect((await req('DELETE', '/api/system/mail')).status).toBe(204);
    expect(relay.mailbox).toBeNull();
  });

  it('übernimmt nach Neuinstallation die Adresse', async () => {
    const res = await req<MailAccountStatus>('POST', '/api/system/mail', { localpart: 'elw2-diepholz', adminEmail: 'admin@feuerwehr.example', mode: 'rebind' });
    expect(res.body.state).toBe('rebind-pending');
    relay.mailbox!.status = 'active';
    await app.mail.poll();
    expect((await req<MailAccountStatus>('GET', '/api/system/mail')).body.state).toBe('active');
  });
});
