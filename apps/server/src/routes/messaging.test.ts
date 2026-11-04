import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import * as openpgp from 'openpgp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAIL_SIGNATURE_HEADER,
  mailSignaturePayload,
  type ChatAvailability,
  type ChatMessage,
  type Conversation,
  type ConversationState,
  type Incident,
  type Message,
  type Role,
  type Unit,
  type MessagingConversation,
  type MessagingEvent,
  type MessagingPeer,
  type MessagingStatus,
  type User,
} from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { generateMailKeys, MailVault, MailCrypto } from '../services/mailcrypto.js';
import type { MessagingFetch } from '../services/messaging/index.js';
import { openEnvelope, sealEnvelope } from '../services/messaging/crypto.js';
import type { SocketFactory, SocketLike } from '../services/messaging/socket.js';
import type { RelayFetch } from '../services/relay.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

const RELAY = 'https://relay.test';

interface Install {
  elwId: string;
  token: string;
  address: string;
  publicKey: string;
  fingerprint: string;
  sigPublicKey: string;
  profile: { regionArs: string; listed: boolean; vehicle: { name: string; callsign: string; organization: string; contacts: unknown[] } } | null;
}

/** Cloud-Relay im Speicher: prüft Token und Signatur, Verzeichnis, Anfragen, Ereignisse, Anhänge und WebSocket-Anstoß */
class FakeRelay {
  installs = new Map<string, Install>();
  conversations = new Map<string, { id: string; from: string; to: string; state: ConversationState }>();
  events: (MessagingEvent & { to: string })[] = [];
  attachments = new Map<string, { from: string; to: string | null; blob: Buffer }>();
  sockets = new Map<string, EventEmitter & SocketLike>();
  nonces = new Set<string>();
  seq = 0;
  /** Anmeldung beim Relay legt install() direkt an */
  relayFetch: RelayFetch = async () => ({ status: 404, body: null });

  private byElw = (elwId: string) => [...this.installs.values()].find((i) => i.elwId === elwId);
  private entry = (i: Install) => ({
    elwId: i.elwId,
    vehicle: i.profile!.vehicle,
    regionArs: i.profile!.regionArs,
    regionLabel: i.profile!.regionArs === '032510037037' ? 'Niedersachsen › Landkreis Diepholz › Stuhr' : 'Niedersachsen',
    address: i.address,
    publicKey: i.publicKey,
    fingerprint: i.fingerprint,
    updatedAt: '2026-11-04T10:00:00.000Z',
  });

  private async signed(i: Install, path: string, method: string, headers: Record<string, string>, body: Buffer): Promise<boolean> {
    const parts = Object.fromEntries((headers[MAIL_SIGNATURE_HEADER] ?? '').split(',').map((p) => p.split('=', 2) as [string, string]));
    if (!parts.s || this.nonces.has(parts.n!)) return false;
    this.nonces.add(parts.n!);
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(i.sigPublicKey, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
    const payload = mailSignaturePayload(method, path, createHash('sha256').update(body).digest('hex'), Number(parts.t), parts.n!);
    return webcrypto.subtle.verify({ name: 'Ed25519' }, key, Buffer.from(parts.s, 'base64url'), new TextEncoder().encode(payload));
  }

  private push(to: string, e: Omit<MessagingEvent, 'seq' | 'at'>) {
    const event = { ...e, seq: ++this.seq, at: new Date().toISOString(), to };
    this.events.push(event);
    this.sockets.get(to)?.emit('message', Buffer.from(JSON.stringify({ type: 'event', event })));
  }

  socketFactory: SocketFactory = (url, headers) => {
    const ws = Object.assign(new EventEmitter(), { send: () => undefined, close: () => ws.emit('close', 1000), terminate: () => ws.emit('close', 1006) }) as EventEmitter & SocketLike;
    const i = [...this.installs.values()].find((x) => headers.authorization === `Bearer ${x.token}`);
    setImmediate(async () => {
      if (!i || !(await this.signed(i, new URL(url).pathname, 'GET', headers, Buffer.alloc(0)))) return ws.emit('close', 1008);
      this.sockets.set(i.elwId, ws);
      ws.emit('open');
    });
    return ws;
  };

  fetch: MessagingFetch = async (url, { method, headers, body = Buffer.alloc(0) }) => {
    const path = url.slice(RELAY.length);
    const json = (status: number, b: unknown) => ({ status, body: Buffer.from(b === null ? '' : JSON.stringify(b)) });
    if (path.startsWith('/v1/regions')) return json(200, [{ ars: '03', name: 'Niedersachsen', kind: 'land', hasChildren: true }]);
    const i = [...this.installs.values()].find((x) => headers.authorization === `Bearer ${x.token}`);
    if (!i) return json(401, { error: 'ELW nicht angemeldet' });
    if (!(await this.signed(i, path, method, headers, body))) return json(401, { error: 'Signatur ungültig' });
    const b = () => JSON.parse(body.toString('utf8'));

    if (path === '/v1/elws/me/messaging/profile') {
      if (method === 'PUT') i.profile = b();
      if (method === 'DELETE') i.profile = null;
      return json(200, i.profile ? { status: 'registered', profile: { ...this.entry(i), listed: i.profile.listed } } : { status: 'none', profile: null });
    }
    if (method === 'GET' && path.startsWith('/v1/elws/me/messaging/directory?')) {
      const q = new URL(url).searchParams.get('q')!.toLowerCase();
      return json(200, [...this.installs.values()].filter((x) => x !== i && x.profile?.listed && x.profile.vehicle.name.toLowerCase().includes(q)).map(this.entry));
    }
    const dir = /^\/v1\/elws\/me\/messaging\/directory\/(.+)$/.exec(path);
    if (method === 'GET' && dir) {
      const x = this.byElw(dir[1]!);
      return x?.profile ? json(200, this.entry(x)) : json(404, { error: 'Installation nicht im Verzeichnis' });
    }
    if (method === 'POST' && path === '/v1/elws/me/messaging/conversations') {
      const { to, ciphertext } = b();
      const c = { id: randomUUID(), from: i.elwId, to, state: 'requested' as const };
      this.conversations.set(c.id, c);
      this.push(to, { type: 'request', conversationId: c.id, from: i.elwId, state: 'requested', ciphertext, attachment: null });
      return json(201, { id: c.id, peer: to, direction: 'out', state: 'requested', createdAt: 'a', updatedAt: 'a' } satisfies Conversation);
    }
    const t = /^\/v1\/elws\/me\/messaging\/conversations\/(.+)\/(accept|decline|close)$/.exec(path);
    if (method === 'POST' && t) {
      const c = this.conversations.get(t[1]!)!;
      c.state = t[2] === 'accept' ? 'accepted' : t[2] === 'decline' ? 'declined' : 'closed';
      const peer = c.from === i.elwId ? c.to : c.from;
      this.push(peer, { type: 'state', conversationId: c.id, from: i.elwId, state: c.state, ciphertext: null, attachment: null });
      return json(200, { id: c.id, peer, direction: c.from === i.elwId ? 'out' : 'in', state: c.state, createdAt: 'a', updatedAt: 'b' } satisfies Conversation);
    }
    if (method === 'POST' && path === '/v1/elws/me/messaging/attachments') {
      const id = randomUUID();
      this.attachments.set(id, { from: i.elwId, to: null, blob: body });
      return json(201, { id });
    }
    const att = /^\/v1\/elws\/me\/messaging\/attachments\/(.+)$/.exec(path);
    if (method === 'GET' && att) {
      const a = this.attachments.get(att[1]!);
      return a?.to === i.elwId ? { status: 200, body: a.blob } : json(404, { error: 'Anhang nicht gefunden' });
    }
    if (method === 'POST' && path === '/v1/elws/me/messaging/messages') {
      const { conversationId, ciphertext, attachmentId } = b();
      const c = this.conversations.get(conversationId)!;
      if (c.state !== 'accepted') return json(409, { error: 'Chat ist nicht aktiv' });
      const peer = c.from === i.elwId ? c.to : c.from;
      if (attachmentId) this.attachments.get(attachmentId)!.to = peer;
      this.push(peer, { type: 'message', conversationId, from: i.elwId, state: 'accepted', ciphertext, attachment: attachmentId ? { id: attachmentId, size: this.attachments.get(attachmentId)!.blob.length } : null });
      return json(201, { ok: true });
    }
    const ev = /^\/v1\/elws\/me\/messaging\/events\?after=(\d+)$/.exec(path);
    if (method === 'GET' && ev) {
      const after = Number(ev[1]);
      this.events = this.events.filter((e) => !(e.to === i.elwId && e.seq <= after));
      const items = this.events.filter((e) => e.to === i.elwId).map(({ to: _to, ...e }) => e);
      return json(200, { items, next: items.at(-1)?.seq ?? after });
    }
    return json(404, { error: 'Nicht gefunden' });
  };
}

interface Node {
  app: App;
  dir: string;
  db: Database.Database;
  admin: string;
  token: string;
  req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, cookie?: string): Promise<{ status: number; body: T }>;
}

let relay: FakeRelay;
let nodes: Node[];

/** ELVIS-Installation mit aktivem Postfach (Schlüssel direkt hinterlegt; der Mail-Ablauf ist in mail.test.ts geprüft) */
async function install(name: string, localpart: string): Promise<Node> {
  const dir = mkdtempSync(join(tmpdir(), 'elvis-msg-'));
  const token = `token-${localpart}`;
  const app = await buildApp(parseConfig({ dataDir: dir, app: { relayUrl: RELAY }, vehicle: { name, callsign: `Florian ${name}`, organization: 'FF Test' } }), {
    logger: false,
    relayFetch: relay.relayFetch,
    messagingFetch: relay.fetch,
    messagingSocket: relay.socketFactory,
    mailFetch: async () => ({ status: 503, body: Buffer.from('{}') }),
  });
  const elwId = randomUUID();
  const address = `${localpart}@einsatzleitwagen.app`;
  const { keys } = await generateMailKeys(address, name, new MailVault(dir));
  const now = new Date().toISOString();
  const db = new Database(join(dir, 'elvis.sqlite'));
  const put = db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'test') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  put.run('mail:keys', JSON.stringify(keys), now);
  put.run('mail:state', JSON.stringify({ status: 'active', address, adminEmail: 'a@b.de', fingerprint: keys.fingerprint, requestedAt: now, activatedAt: now, keysMailedAt: null, lastFetchAt: null, lastFetchCountry: null, cursor: 0 }), now);
  put.run('app:relay', JSON.stringify({ elwId, token, cursor: 0, sheetCursor: 0 }), now);
  relay.installs.set(token, { elwId, token, address, publicKey: keys.publicKey, fingerprint: keys.fingerprint, sigPublicKey: keys.sigPublicKey, profile: null });
  const admin = await adminCookie(app, { firstName: 'Max', lastName: name.replace(/\s/g, '') });
  const node: Node = {
    app,
    dir,
    db,
    admin,
    token,
    async req(method, url, payload, cookie = admin) {
      const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
      return { status: res.statusCode, body: (res.body ? res.json() : undefined) as never };
    },
  };
  nodes.push(node);
  return node;
}

/** Bis alle Sendungen (Hintergrund) und Abrufe (vom WebSocket angestoßen) gelaufen sind */
async function settle() {
  for (let k = 0; k < 40; k++) {
    await new Promise((r) => setTimeout(r, 10));
    await Promise.all(nodes.map((n) => n.app.messaging?.pull()));
    const sending = nodes.some((n) => n.db && (n.db.prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE status = 'sending'").get() as { c: number }).c > 0);
    if (!sending && k > 3) return;
  }
}

beforeEach(() => {
  relay = new FakeRelay();
  nodes = [];
});

afterEach(async () => {
  for (const n of nodes) {
    await n.app.close();
    n.db?.close();
    rmSync(n.dir, { recursive: true, force: true });
  }
});

describe('Cloud Messaging', () => {
  it('braucht ein aktives Postfach', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-msg-'));
    const app = await buildApp(parseConfig({ dataDir: dir, app: { relayUrl: RELAY } }), { logger: false, relayFetch: relay.relayFetch, messagingFetch: relay.fetch, messagingSocket: relay.socketFactory });
    nodes.push({ app, dir } as Node);
    const admin = await adminCookie(app);
    const status = (await app.server.inject({ method: 'GET', url: '/api/messaging/status', headers: { cookie: admin } })).json() as MessagingStatus;
    expect(status).toMatchObject({ enabled: true, mailbox: false, registered: false });
    const res = await app.server.inject({ method: 'PUT', url: '/api/system/messaging', payload: { regionArs: '03' }, headers: { cookie: admin } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Postfach/);
  });

  it('registrieren, finden, anfragen, annehmen, Besetzung sehen, Text und Dokument austauschen', async () => {
    const a = await install('ELW 1 Stuhr', 'elw1-stuhr');
    const b = await install('ELW 2 Weyhe', 'elw2-weyhe');

    // Kontaktdaten unter „Fahrzeug & Einheit“ gehen mit ins Verzeichnis
    const settings = (await b.req<{ vehicle: object; mapSign: object }>('GET', '/api/settings')).body;
    await b.req('PUT', '/api/settings', { ...settings, vehicle: { ...settings.vehicle, contacts: [{ kind: 'phone', value: '+881 1234', label: 'Satellitentelefon' }] } });

    // Registrieren nur für Admins
    const anna = (await a.req<User>('POST', '/api/users', { firstName: 'Anna', lastName: 'Funk', pin: '1111' })).body;
    const annaCookie = sessionCookie((await a.app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: anna.id, pin: '1111' } })).headers['set-cookie']);
    expect((await a.req('PUT', '/api/system/messaging', { regionArs: '032510037037' }, annaCookie)).status).toBe(403);

    const reg = await a.req<MessagingStatus>('PUT', '/api/system/messaging', { regionArs: '032510037037' });
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ registered: true, profile: { regionLabel: 'Niedersachsen › Landkreis Diepholz › Stuhr', listed: true } });
    await b.req('PUT', '/api/system/messaging', { regionArs: '03' });
    await settle();
    expect((await a.req<MessagingStatus>('GET', '/api/messaging/status')).body.connection).toBe('connected');
    expect(relay.installs.get(b.token)!.profile!.vehicle.contacts).toEqual([{ kind: 'phone', value: '+881 1234', label: 'Satellitentelefon' }]);

    // Suchen und anfragen (Anna, ohne Admin-Rechte)
    const found = (await a.req<MessagingPeer[]>('GET', '/api/messaging/directory?q=weyhe', undefined, annaCookie)).body;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ vehicle: { name: 'ELW 2 Weyhe', contacts: [{ label: 'Satellitentelefon' }] } });
    const conv = (await a.req<MessagingConversation>('POST', '/api/messaging/conversations', { elwId: found[0]!.elwId }, annaCookie)).body;
    expect(conv).toMatchObject({ direction: 'out', state: 'requested', requestedBy: { name: 'Anna Funk' } });

    // Bei b erscheint die Anfrage: wer, von welchem Fahrzeug
    await settle();
    const incoming = (await b.req<MessagingConversation[]>('GET', '/api/messaging/conversations')).body;
    expect(incoming).toEqual([expect.objectContaining({ id: conv.id, direction: 'in', state: 'requested', requestedBy: { name: 'Anna Funk', roles: [] }, peer: expect.objectContaining({ vehicle: expect.objectContaining({ name: 'ELW 1 Stuhr' }) }) })]);
    // Vor dem Annehmen geht nichts durch
    expect((await b.req('POST', '/api/chat/send', { to: [{ channel: 'elvis', to: incoming[0]!.peer.elwId }], text: 'zu früh' })).status).toBe(202);
    await settle();
    expect(((await b.req<{ items: ChatMessage[] }>('GET', '/api/chat/messages?folder=sent')).body.items[0])).toMatchObject({ status: 'failed', error: expect.stringMatching(/erst anfragen/) });

    // Besatzung wird nur während einer Lage geteilt
    await a.req('POST', '/api/incidents', { title: 'Hochwasser', keyword: 'TH' });
    await b.req('POST', '/api/incidents', { title: 'Hochwasser', keyword: 'TH' });

    // b nimmt an → beide sehen die Besatzung der Gegenseite
    const accepted = await b.req<MessagingConversation>('POST', `/api/messaging/conversations/${conv.id}/accept`);
    expect(accepted.body).toMatchObject({ state: 'accepted', decidedBy: 'Max ELW2Weyhe' });
    await settle();
    const atA = (await a.req<MessagingConversation[]>('GET', '/api/messaging/conversations')).body[0]!;
    expect(atA.state).toBe('accepted');
    expect(atA.peerCrew).toEqual([{ name: 'Max ELW2Weyhe', roles: [] }]);
    expect(atA.peerIncident).toBe(true);
    const atB = (await b.req<MessagingConversation[]>('GET', '/api/messaging/conversations')).body[0]!;
    expect(atB.peerCrew.map((m) => m.name).sort()).toEqual(['Anna Funk', 'Max ELW1Stuhr']);

    // Kanal „Fahrzeug-Chat“ ist verfügbar
    const avail = (await a.req<ChatAvailability>('GET', '/api/chat/available')).body;
    expect(avail.channels.find((c) => c.channel === 'elvis')).toMatchObject({ available: true, files: true });

    // Text von a nach b
    const sent = await a.req('POST', '/api/chat/send', { to: [{ channel: 'elvis', to: atA.peer.elwId }], text: 'Lagemeldung: Wasser steigt' }, annaCookie);
    expect(sent.status).toBe(202);
    await settle();
    const inboxB = (await b.req<{ items: ChatMessage[] }>('GET', '/api/chat/messages?folder=inbox')).body.items;
    expect(inboxB[0]).toMatchObject({ channel: 'elvis', text: 'Lagemeldung: Wasser steigt', peer: atB.peer.elwId, name: 'Anna Funk', thread: `elvis:${atB.peer.elwId}` });
    // Beim Relay liegt nichts im Klartext
    expect(JSON.stringify(relay.events)).not.toContain('Wasser');

    // Dokument von b nach a (Anhang verschlüsselt beim Relay)
    const pdf = Buffer.from('%PDF-1.4 Einsatzplan');
    const fileId = await b.app.chat['storeFile']('Einsatzplan.pdf', 'application/pdf', pdf, 'Test');
    expect((await b.req('POST', '/api/chat/send', { to: [{ channel: 'elvis', to: atB.peer.elwId }], text: 'Plan anbei', attachmentId: fileId })).status).toBe(202);
    await settle();
    const blob = [...relay.attachments.values()][0]!.blob;
    expect(blob.includes(pdf)).toBe(false);
    const inboxA = (await a.req<{ items: ChatMessage[] }>('GET', '/api/chat/messages?folder=inbox')).body.items;
    expect(inboxA[0]).toMatchObject({ channel: 'elvis', text: 'Plan anbei', attachment: { name: 'Einsatzplan.pdf', mimeType: 'application/pdf', size: pdf.length } });
    const file = await a.app.server.inject({ method: 'GET', url: `/api/chat/files/${inboxA[0]!.attachment!.id}`, headers: { cookie: a.admin } });
    expect(file.rawPayload.equals(pdf)).toBe(true);

    // Lage bei b zu: a sieht keine Besatzung mehr, der Chat bleibt verbunden
    const lageB = (await b.req<Incident>('GET', '/api/incidents/active')).body;
    await b.req('POST', `/api/incidents/${lageB.id}/close`);
    await b.app.messaging.checkCrew();
    await settle();
    expect((await a.req<MessagingConversation[]>('GET', '/api/messaging/conversations')).body[0]).toMatchObject({ state: 'accepted', peerCrew: [], peerIncident: false });

    // Beenden (z. B. Anfrage zurückziehen, Abmelden): danach keine Nachrichten mehr
    await a.req('POST', `/api/messaging/conversations/${conv.id}/close`);
    await settle();
    expect((await b.req<MessagingConversation[]>('GET', '/api/messaging/conversations')).body[0]!.state).toBe('closed');
    expect(relay.events.filter((e) => e.to === relay.installs.get(a.token)!.elwId || e.to === relay.installs.get(b.token)!.elwId)).toEqual([]);
  });

  it('Meldung an eine zugeordnete Kraft kommt bei der anderen Installation als Eingangsmeldung an', async () => {
    const a = await install('ELW 1 Stuhr', 'elw1-stuhr');
    const b = await install('ELW 2 Weyhe', 'elw2-weyhe');
    await a.req('PUT', '/api/system/messaging', { regionArs: '03' });
    await b.req('PUT', '/api/system/messaging', { regionArs: '03' });
    const aId = relay.installs.get(a.token)!.elwId;
    const bId = relay.installs.get(b.token)!.elwId;
    const conv = (await a.req<MessagingConversation>('POST', '/api/messaging/conversations', { elwId: bId })).body;
    await settle();
    await b.req('POST', `/api/messaging/conversations/${conv.id}/accept`);
    await settle();

    // a: Lage, Kraft „ELW 2 Weyhe“ dem Fahrzeug-Chat mit b zugeordnet, Rolle Einsatzleiter
    const lageA = (await a.req<Incident>('POST', '/api/incidents', { title: 'Hochwasser Stuhr', keyword: 'TH 2' })).body;
    const unit = (await a.req<Unit>('POST', `/api/incidents/${lageA.id}/units`, { name: 'ELW 2 Weyhe' })).body;
    expect((await a.req<Unit>('PATCH', `/api/units/${unit.id}`, { messagingPeer: bId })).body.messagingPeer).toBe(bId);
    const el = (await a.req<Role>('POST', '/api/system/roles', { name: 'Einsatzleiter' })).body;
    await a.req('PUT', '/api/auth/role', { roleIds: [el.id] });
    const out = (await a.req<Message>('POST', `/api/incidents/${lageA.id}/messages`, { direction: 'out', senderRoleId: el.id, recipient: { unitId: unit.id, text: 'ELW 2 Weyhe' }, body: 'Abschnitt Nord übernehmen' })).body;

    // b ohne Lage: nur im Chat
    expect((await a.req<{ info: string }>('POST', '/api/messaging/meldungen', { messageId: out.id })).body.info).toMatch(/übermittelt/);
    await settle();
    const chatB = (await b.req<{ items: ChatMessage[] }>('GET', '/api/chat/messages?folder=inbox')).body.items;
    expect(chatB[0]!.text).toBe(`Meldung #${out.id} von Einsatzleiter an ELW 2 Weyhe (TH 2 Hochwasser Stuhr):\nAbschnitt Nord übernehmen`);
    // Beim Absender im Verlauf
    expect((await a.req<{ items: ChatMessage[] }>('GET', '/api/chat/messages?folder=sent')).body.items[0]).toMatchObject({ channel: 'elvis', peer: bId, status: 'sent' });

    // b mit Lage und zugeordneter Kraft „ELW 1 Stuhr“: Eingangsmeldung mit der Kraft als Absender, wartet auf Verteilung
    const lageB = (await b.req<Incident>('POST', '/api/incidents', { title: 'Hochwasser', keyword: 'TH' })).body;
    const back = (await b.req<Unit>('POST', `/api/incidents/${lageB.id}/units`, { name: 'ELW 1 Stuhr' })).body;
    await b.req('PATCH', `/api/units/${back.id}`, { messagingPeer: aId });
    const out2 = (await a.req<Message>('POST', `/api/incidents/${lageA.id}/messages`, { direction: 'out', senderRoleId: el.id, recipient: { unitId: unit.id, text: 'ELW 2 Weyhe' }, body: 'Lage um 14 Uhr' })).body;
    await a.req('POST', '/api/messaging/meldungen', { messageId: out2.id });
    await settle();
    const inB = (await b.req<Message[]>('GET', `/api/incidents/${lageB.id}/messages`)).body;
    expect(inB).toHaveLength(1);
    expect(inB[0]).toMatchObject({ direction: 'in', sender: 'ELW 1 Stuhr', senderUnitId: back.id, recipient: null });
    expect(inB[0]!.body).toContain('Lage um 14 Uhr');
    expect(inB[0]!.body).toContain(`Meldung #${out2.id} von Einsatzleiter`);

    // Ohne Zuordnung der Kraft geht es nicht
    const other = (await a.req<Unit>('POST', `/api/incidents/${lageA.id}/units`, { name: 'RTW' })).body;
    const out3 = (await a.req<Message>('POST', `/api/incidents/${lageA.id}/messages`, { direction: 'out', senderRoleId: el.id, recipient: { unitId: other.id, text: 'RTW' }, body: 'x' })).body;
    expect((await a.req('POST', '/api/messaging/meldungen', { messageId: out3.id })).status).toBe(409);
  });

  it('verwirft Nachrichten mit falscher Signatur und ignoriert unbekannte Arten', async () => {
    const a = await install('ELW A', 'elw-a');
    const b = await install('ELW B', 'elw-b');
    await a.req('PUT', '/api/system/messaging', { regionArs: '03' });
    await b.req('PUT', '/api/system/messaging', { regionArs: '03' });
    const bId = relay.installs.get(b.token)!.elwId;
    const conv = (await a.req<MessagingConversation>('POST', '/api/messaging/conversations', { elwId: bId })).body;
    await settle();
    await b.req('POST', `/api/messaging/conversations/${conv.id}/accept`);
    await settle();

    // Fremder Schlüssel unterschreibt eine Nachricht „von a“
    const bKeys = relay.installs.get(b.token)!;
    const forger = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: 'boese@example.org' }], format: 'armored' });
    const forged = (await openpgp.encrypt({
      message: await openpgp.createMessage({ text: JSON.stringify({ v: 1, id: 'x', sentAt: 'now', sender: { name: 'Mallory', roles: [] }, kind: 'text', text: 'Rückzug!' }) }),
      encryptionKeys: await openpgp.readKey({ armoredKey: bKeys.publicKey }),
      signingKeys: await openpgp.readPrivateKey({ armoredKey: forger.privateKey }),
    })) as string;
    // Neue Art von einer neueren ELVIS-Version, korrekt signiert von a
    const aCrypto = new MailCrypto(JSON.parse((a.db.prepare("SELECT value FROM settings WHERE key = 'mail:keys'").get() as { value: string }).value), new MailVault(a.dir));
    const future = await aCrypto.encryptAndSign(JSON.stringify({ v: 1, id: 'y', sentAt: 'now', sender: { name: 'Max', roles: [] }, kind: 'map-sync', objects: [] }), [bKeys.publicKey]);
    const aId = relay.installs.get(a.token)!.elwId;
    for (const ciphertext of [forged, future]) relay['push'](bId, { type: 'message', conversationId: conv.id, from: aId, state: 'accepted', ciphertext, attachment: null });
    await settle();

    expect((await b.req<{ items: ChatMessage[] }>('GET', '/api/chat/messages?folder=inbox')).body.items).toEqual([]);
    const audit = (await b.req<{ target: string; message: string; success: boolean }[]>('GET', '/api/audit')).body.filter((e) => e.target === 'messaging');
    expect(audit.some((e) => !e.success && /Signatur der Gegenseite ungültig/.test(e.message))).toBe(true);
    expect(audit.some((e) => /„map-sync“ wird von dieser ELVIS-Version nicht unterstützt/.test(e.message))).toBe(true);
  });

  it('Umschlag: verschlüsselt und signiert, nur mit passendem Schlüssel lesbar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-env-'));
    try {
      const vault = new MailVault(dir);
      const a = new MailCrypto((await generateMailKeys('a@einsatzleitwagen.app', 'A', vault)).keys, vault);
      const b = new MailCrypto((await generateMailKeys('b@einsatzleitwagen.app', 'B', vault)).keys, vault);
      const env = { v: 1 as const, id: '1', sentAt: 'now', sender: { name: 'Anna Funk', roles: ['Funker'] }, kind: 'text' as const, text: 'Grüße aus Stuhr 🚒' };
      const sealed = await sealEnvelope(a, env, b.keys.publicKey);
      expect(await openEnvelope(b, sealed, a.keys.publicKey)).toEqual({ ok: true, envelope: env });
      // Mit falschem Absenderschlüssel geprüft: Signatur unbekannt
      expect(await openEnvelope(b, sealed, b.keys.publicKey)).toMatchObject({ ok: false, reason: 'signature' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
