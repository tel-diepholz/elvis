import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_CHANNEL_LABEL,
  MAIL_SIGNATURE_HEADER,
  MESSAGING_LIMITS,
  crewLabel,
  mailSignaturePayload,
  messagingConnectSchema,
  messagingRegisterSchema,
  messagingSendMeldungSchema,
  vehicleLabel,
  type ChatChannelInfo,
  type Conversation,
  type ConversationState,
  type CrewMember,
  type DirectoryEntry,
  type Envelope,
  type MessagingConnection,
  type MessagingConversation,
  type MessagingEvent,
  type MessagingEventBatch,
  type MessagingPeer,
  type MessagingProfileStatus,
  type MessagingStatus,
  type MessagingVehicle,
  type Message,
  type Region,
  type RegionWithPath,
  type Topic,
  type Unit,
  type VehicleInfo,
} from '@elvis/shared';
import type { Db } from '../../db/index.js';
import type { Store } from '../../db/store.js';
import type { Logger } from '../../devices/adapter.js';
import type { IncomingChat, OutgoingChat, SendResult } from '../../devices/messaging/bus.js';
import { HttpError } from '../../errors.js';
import type { MailCrypto } from '../mailcrypto.js';
import { RelayError, type RelayClient } from '../relay.js';
import { decryptFile, encryptFile, openEnvelope, sealEnvelope } from './crypto.js';
import { PushSocket, type SocketFactory } from './socket.js';

/** Anfrage ans Relay (für Tests austauschbar); body roh, Antwort roh */
export type MessagingFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer; timeoutMs: number }) => Promise<{ status: number; body: Buffer }>;

const defaultFetch: MessagingFetch = async (url, { method, headers, body, timeoutMs }) => {
  const res = await fetch(url, { method, headers, body: body && new Uint8Array(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

const STATE_KEY = 'messaging:state';
const TIMEOUT_MS = 30_000;
const EVENT_BATCH = 100;
/** Ohne WebSocket wird so oft abgerufen */
const FALLBACK_POLL_MS = 60_000;
/** So oft prüft ELVIS, ob sich die Besetzung geändert hat (lokal, ohne Netz) */
const CREW_CHECK_MS = 20_000;

interface State {
  registered: boolean;
  regionArs: string;
  listed: boolean;
  /** Letztes abgeholtes Ereignis */
  cursor: number;
  profile: MessagingStatus['profile'];
  /** Zuletzt an die Gegenseiten gemeldete Besetzung */
  crewSent: string;
}

interface PeerRow {
  elw_id: string;
  vehicle: string;
  region_label: string;
  address: string;
  public_key: string;
  fingerprint: string;
}

interface ConversationRow {
  id: string;
  peer_elw: string;
  direction: 'in' | 'out';
  state: ConversationState;
  requested_by: string | null;
  peer_crew: string;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Was der Fahrzeug-Chat von den Nachrichten braucht (ChatService) */
export interface ChatSink {
  ingest(m: IncomingChat): Promise<unknown>;
  recordSent(m: { channel: 'elvis'; peer: string; text: string; externalId: string; createdBy: string }): unknown;
}

/** Meldungen und Kräfte der Lage (MessageService, Store) */
export interface MeldungSink {
  /** Laufende Lage; null = keine */
  incident(): { id: number; label: string } | null;
  units(incidentId: number): Unit[];
  message(id: number): Message;
  receive(incidentId: number, sender: { unitId: number | null; text: string }, body: string, createdBy: string): Message;
}

/** Besetzung, wie sie gespeichert ist (ältere Stände: nur die Liste) */
function parseCrew(raw: string): { crew: CrewMember[]; incident: boolean } {
  const v = JSON.parse(raw) as CrewMember[] | { crew: CrewMember[]; incident: boolean };
  return Array.isArray(v) ? { crew: v, incident: true } : v;
}

export interface MessagingDeps {
  db: Db;
  store: Store;
  notify: (topics: Topic[]) => void;
  relay: RelayClient;
  mail: { activeCrypto(): MailCrypto | null };
  vehicle: () => VehicleInfo;
  /** Angemeldete Benutzer mit Rollen */
  crew: () => CrewMember[];
  meldungen: MeldungSink;
  log: Logger;
  fetch?: MessagingFetch;
  socketFactory?: SocketFactory;
}

const toPeer = (r: PeerRow): MessagingPeer => ({
  elwId: r.elw_id,
  vehicle: JSON.parse(r.vehicle) as MessagingVehicle,
  regionLabel: r.region_label,
  address: r.address,
  fingerprint: r.fingerprint,
});

export const threadKeyOf = (elwId: string) => `elvis:${elwId}`;

const ownVehicle = (v: VehicleInfo): MessagingVehicle => ({ name: v.name, callsign: v.callsign, organization: v.organization, contacts: v.contacts ?? [] });

/**
 * Cloud Messaging: Chat mit anderen ELVIS-Installationen über das Relay. Verzeichnis und Anfragen laufen hier; die
 * Nachrichten selbst landen im Kanal „Fahrzeug-Chat“ der Nachrichten (ChatService). Neue Ereignisse meldet das Relay über
 * einen WebSocket; abgeholt und quittiert wird per Cursor (GET …/events).
 */
export class MessagingService {
  private chat: ChatSink | null = null;
  private readonly socket: PushSocket;
  private connection: { state: MessagingConnection; since: string | null; error: string | null } = { state: 'disabled', since: null, error: null };
  private pulling: Promise<void> | null = null;
  private pullAgain = false;
  private poller: NodeJS.Timeout | null = null;
  private crewTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MessagingDeps) {
    this.socket = new PushSocket({
      connect: async () => {
        const path = '/v1/elws/me/messaging/socket';
        return { url: `${this.relayUrl().replace(/^http/, 'ws')}${path}`, headers: await this.headers('GET', path, Buffer.alloc(0)) };
      },
      onEvent: () => void this.pull(),
      onState: (state, error) => this.setConnection(state, error),
      factory: deps.socketFactory,
    });
  }

  /** Nachrichten-Kanal anbinden (ChatService gibt es erst nach dem Messaging) */
  attachChat(chat: ChatSink): void {
    this.chat = chat;
  }

  get enabled(): boolean {
    return this.deps.relay.enabled;
  }

  // --- Zustand ---

  private state(): State {
    const r = this.deps.db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
    return { registered: false, regionArs: '', listed: true, cursor: 0, profile: null, crewSent: '', ...(r ? (JSON.parse(r.value) as Partial<State>) : {}) };
  }

  private setState(patch: Partial<State>, by = 'system'): State {
    const next = { ...this.state(), ...patch };
    this.deps.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(STATE_KEY, JSON.stringify(next), new Date().toISOString(), by);
    return next;
  }

  private setConnection(state: MessagingConnection, error: string | null): void {
    const changed = state !== this.connection.state;
    this.connection = { state, since: changed ? new Date().toISOString() : this.connection.since, error: error ?? (state === 'connected' ? null : this.connection.error) };
    // Ohne WebSocket übernimmt der Abruf
    if (state === 'polling' && !this.poller) this.poller = setInterval(() => void this.pull(), FALLBACK_POLL_MS);
    if (state !== 'polling' && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    if (changed) this.deps.notify(['messaging']);
  }

  status(): MessagingStatus {
    const s = this.state();
    return {
      enabled: this.enabled,
      mailbox: !!this.deps.mail.activeCrypto(),
      registered: s.registered,
      profile: s.registered ? s.profile : null,
      connection: this.connection.state,
      since: this.connection.since,
      lastError: this.connection.error,
    };
  }

  /** Kanal „Fahrzeug-Chat“ für die Nachrichten */
  channelInfo(): ChatChannelInfo {
    const s = this.state();
    const available = this.enabled && s.registered && !!this.deps.mail.activeCrypto();
    return {
      channel: 'elvis',
      label: CHAT_CHANNEL_LABEL.elvis,
      available,
      account: s.profile ? vehicleLabel(s.profile.vehicle) : null,
      status: !available ? 'setup' : this.connection.state === 'connected' ? 'connected' : this.connection.state === 'polling' ? 'error' : 'connecting',
      images: true,
      files: true,
      location: true,
      reachability: false,
      window24h: false,
    };
  }

  // --- Relay ---

  private relayUrl(): string {
    if (!this.deps.relay.url) throw new HttpError(503, 'Cloud-Anbindung ist nicht eingerichtet (app.relayUrl in config/elvis.json)');
    return this.deps.relay.url.replace(/\/$/, '');
  }

  private crypto(): MailCrypto {
    const c = this.deps.mail.activeCrypto();
    if (!c) throw new HttpError(409, 'Cloud Messaging braucht ein aktives ELVIS-Postfach (Einstellungen › E-Mail)');
    return c;
  }

  private async headers(method: string, path: string, body: Buffer): Promise<Record<string, string>> {
    const { token } = await this.deps.relay.ensureCredentials();
    const t = Date.now();
    const n = randomBytes(16).toString('base64url');
    const payload = mailSignaturePayload(method, path, createHash('sha256').update(body).digest('hex'), t, n);
    return { authorization: `Bearer ${token}`, [MAIL_SIGNATURE_HEADER]: `t=${t},n=${n},s=${await this.crypto().signRequest(payload)}` };
  }

  /** Signierter Aufruf; body als JSON-Wert oder roh (Anhang) */
  private async call(method: string, path: string, body?: unknown): Promise<Buffer> {
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const headers = { ...(await this.headers(method, path, raw)), accept: 'application/json', ...(raw.length && { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }) };
    let res: { status: number; body: Buffer };
    try {
      res = await (this.deps.fetch ?? defaultFetch)(`${this.relayUrl()}${path}`, { method, headers, body: raw.length ? raw : undefined, timeoutMs: TIMEOUT_MS });
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
    return res.body;
  }

  private async callJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body);
    return (res.length ? JSON.parse(res.toString('utf8')) : null) as T;
  }

  /** Kommunen-Katalog (öffentlich beim Relay): Kinder einer Region, Suche oder eine Region mit Pfad */
  async regions(q: { parent?: string; q?: string; ars?: string }): Promise<Region[] | RegionWithPath[] | RegionWithPath> {
    const path = q.ars ? `/v1/regions/${encodeURIComponent(q.ars)}` : q.q !== undefined ? `/v1/regions?q=${encodeURIComponent(q.q)}` : `/v1/regions?parent=${encodeURIComponent(q.parent ?? '')}`;
    let res: { status: number; body: Buffer };
    try {
      res = await (this.deps.fetch ?? defaultFetch)(`${this.relayUrl()}${path}`, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      throw new HttpError(502, `Cloud-Anbindung nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) throw new HttpError(404, 'Region unbekannt');
    if (res.status >= 400) throw new HttpError(502, `Cloud: HTTP ${res.status}`);
    return JSON.parse(res.body.toString('utf8')) as Region[];
  }

  // --- Verzeichnis (Admins) ---

  async register(input: unknown, operator: string): Promise<MessagingStatus> {
    const { regionArs, listed } = messagingRegisterSchema.parse(input);
    this.crypto();
    let r: MessagingProfileStatus;
    try {
      r = await this.callJson<MessagingProfileStatus>('PUT', '/v1/elws/me/messaging/profile', { regionArs, listed, vehicle: ownVehicle(this.deps.vehicle()) });
    } catch (e) {
      this.audit(operator, 'register', regionArs, false, e instanceof Error ? e.message : String(e));
      throw e;
    }
    const wasRegistered = this.state().registered;
    this.setState({ registered: true, regionArs, listed, profile: profileOf(r) }, operator);
    this.audit(operator, wasRegistered ? 'update' : 'register', regionArs, true, `${r.profile?.regionLabel ?? regionArs}${listed ? '' : ', nicht im Verzeichnis sichtbar'}`);
    this.deps.notify(['messaging', 'chat', 'audit']);
    this.start();
    return this.status();
  }

  async unregister(operator: string): Promise<MessagingStatus> {
    const s = this.state();
    if (!s.registered) return this.status();
    await this.call('DELETE', '/v1/elws/me/messaging/profile');
    this.deps.db.prepare("UPDATE messaging_conversations SET state = 'closed', decided_by = ?, updated_at = ? WHERE state IN ('requested', 'accepted')").run(operator, new Date().toISOString());
    this.setState({ registered: false, profile: null, cursor: 0 }, operator);
    this.stop();
    this.audit(operator, 'unregister', '', true, 'Aus dem Verzeichnis abgemeldet, offene Chats beendet');
    this.deps.notify(['messaging', 'chat', 'audit']);
    return this.status();
  }

  /** Nach Änderungen an „Fahrzeug & Einheit“ den Eintrag im Verzeichnis nachziehen */
  async syncProfile(): Promise<void> {
    const s = this.state();
    if (!s.registered || !this.deps.mail.activeCrypto()) return;
    try {
      const r = await this.callJson<MessagingProfileStatus>('PUT', '/v1/elws/me/messaging/profile', { regionArs: s.regionArs, listed: s.listed, vehicle: ownVehicle(this.deps.vehicle()) });
      this.setState({ profile: profileOf(r) });
      this.deps.notify(['messaging']);
    } catch (e) {
      this.deps.log.warn(`Cloud Messaging: Verzeichniseintrag nicht aktualisiert: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async directory(q: string, region: string): Promise<MessagingPeer[]> {
    this.requireRegistered();
    const params = new URLSearchParams({ q, region });
    const entries = await this.callJson<DirectoryEntry[]>('GET', `/v1/elws/me/messaging/directory?${params}`);
    return entries.map((e) => ({ elwId: e.elwId, vehicle: e.vehicle, regionLabel: e.regionLabel, address: e.address, fingerprint: e.fingerprint }));
  }

  private requireRegistered(): void {
    if (!this.state().registered) throw new HttpError(409, 'Erst in den Einstellungen für Cloud Messaging registrieren');
    this.crypto();
  }

  // --- Gegenstellen und Chats ---

  private peerRow(elwId: string): PeerRow | null {
    return (this.deps.db.prepare('SELECT * FROM messaging_peers WHERE elw_id = ?').get(elwId) as PeerRow | undefined) ?? null;
  }

  /** Eintrag der Gegenseite holen und merken; ändert sich ihr Schlüssel, steht das im Bedienprotokoll */
  private async fetchPeer(elwId: string): Promise<PeerRow> {
    const e = await this.callJson<DirectoryEntry>('GET', `/v1/elws/me/messaging/directory/${elwId}`);
    const known = this.peerRow(elwId);
    if (known && known.fingerprint !== e.fingerprint) {
      this.audit('System', 'key-changed', e.address, true, `Neuer Schlüssel für ${vehicleLabel(e.vehicle)}: ${e.fingerprint} (bisher ${known.fingerprint})`);
    }
    this.deps.db
      .prepare(
        `INSERT INTO messaging_peers (elw_id, vehicle, region_label, address, public_key, fingerprint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(elw_id) DO UPDATE SET vehicle = excluded.vehicle, region_label = excluded.region_label, address = excluded.address,
           public_key = excluded.public_key, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
      )
      .run(e.elwId, JSON.stringify(e.vehicle), e.regionLabel, e.address, e.publicKey, e.fingerprint, new Date().toISOString());
    return this.peerRow(elwId)!;
  }

  private conversationRow(id: string): ConversationRow {
    const r = this.deps.db.prepare('SELECT * FROM messaging_conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (!r) throw new HttpError(404, 'Chat nicht gefunden');
    return r;
  }

  private toConversation(r: ConversationRow): MessagingConversation {
    const peer = this.peerRow(r.peer_elw)!;
    return {
      id: r.id,
      peer: toPeer(peer),
      direction: r.direction,
      state: r.state,
      requestedBy: r.requested_by ? (JSON.parse(r.requested_by) as CrewMember) : null,
      peerCrew: parseCrew(r.peer_crew).crew,
      peerIncident: parseCrew(r.peer_crew).incident,
      decidedBy: r.decided_by,
      threadKey: threadKeyOf(r.peer_elw),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  conversations(): MessagingConversation[] {
    const rows = this.deps.db.prepare('SELECT * FROM messaging_conversations ORDER BY updated_at DESC LIMIT 200').all() as ConversationRow[];
    return rows.map((r) => this.toConversation(r));
  }

  conversation(id: string): MessagingConversation {
    return this.toConversation(this.conversationRow(id));
  }

  /** Wer gerade bedient, mit seinen Rollen (aus der Besetzung) */
  private member(name: string): CrewMember {
    return this.deps.crew().find((m) => m.name === name) ?? { name, roles: [] };
  }

  private envelope<K extends Envelope['kind']>(operator: string, body: Omit<Extract<Envelope, { kind: K }>, 'v' | 'id' | 'sentAt' | 'sender'>): Extract<Envelope, { kind: K }> {
    return { v: 1, id: randomUUID(), sentAt: new Date().toISOString(), sender: this.member(operator), ...body } as unknown as Extract<Envelope, { kind: K }>;
  }

  /** Chat-Anfrage an eine andere Installation */
  async request(input: unknown, operator: string): Promise<MessagingConversation> {
    const { elwId } = messagingConnectSchema.parse(input);
    this.requireRegistered();
    const open = this.deps.db.prepare("SELECT id FROM messaging_conversations WHERE peer_elw = ? AND state IN ('requested', 'accepted')").get(elwId) as { id: string } | undefined;
    if (open) return this.conversation(open.id);
    const peer = await this.fetchPeer(elwId);
    const vehicle = ownVehicle(this.deps.vehicle());
    const env = this.envelope<'request'>(operator, { kind: 'request', vehicle, crew: this.deps.crew().map(({ name, roles }) => ({ name, roles })) });
    const ciphertext = await sealEnvelope(this.crypto(), env, peer.public_key);
    const c = await this.callJson<Conversation>('POST', '/v1/elws/me/messaging/conversations', { to: elwId, ciphertext });
    this.deps.db
      .prepare("INSERT INTO messaging_conversations (id, peer_elw, direction, state, requested_by, created_at, updated_at) VALUES (?, ?, 'out', 'requested', ?, ?, ?)")
      .run(c.id, elwId, JSON.stringify(env.sender), c.createdAt, c.updatedAt);
    this.audit(operator, 'request', peer.address, true, `Chat-Anfrage an ${vehicleLabel(JSON.parse(peer.vehicle) as MessagingVehicle)}`);
    this.deps.notify(['messaging', 'audit']);
    return this.conversation(c.id);
  }

  async decide(id: string, action: 'accept' | 'decline' | 'close', operator: string): Promise<MessagingConversation> {
    this.requireRegistered();
    const row = this.conversationRow(id);
    const c = await this.callJson<Conversation>('POST', `/v1/elws/me/messaging/conversations/${id}/${action}`);
    this.deps.db.prepare('UPDATE messaging_conversations SET state = ?, decided_by = ?, updated_at = ? WHERE id = ?').run(c.state, operator, c.updatedAt, id);
    const peer = toPeer(this.peerRow(row.peer_elw)!);
    const verb = { accept: 'angenommen', decline: 'abgelehnt', close: 'beendet' }[action];
    this.audit(operator, action, peer.address, true, `Chat mit ${vehicleLabel(peer.vehicle)} ${verb}`);
    this.deps.notify(['messaging', 'chat', 'audit']);
    if (c.state === 'accepted') await this.sendCrew(id).catch((e) => this.deps.log.warn(`Cloud Messaging: Besetzung nicht gesendet: ${String(e)}`));
    return this.conversation(id);
  }

  /** Besetzung wird nur während einer Lage geteilt; ohne Lage geht eine leere Liste hinaus */
  private crewJson(): string {
    const incident = this.deps.meldungen.incident() !== null;
    return JSON.stringify({ crew: incident ? this.deps.crew().map(({ name, roles }) => ({ name, roles })) : [], incident });
  }

  private async sendCrew(conversationId: string): Promise<void> {
    const { crew, incident } = JSON.parse(this.crewJson()) as { crew: CrewMember[]; incident: boolean };
    await this.post(conversationId, this.envelope<'crew'>('System', { kind: 'crew', crew, incident }), null);
  }

  /** Besetzung oder Lage hat sich geändert (An-/Abmeldung, Rollenwechsel, Lage auf/zu): allen verbundenen Gegenseiten melden */
  async checkCrew(): Promise<void> {
    const s = this.state();
    if (!s.registered || !this.deps.mail.activeCrypto()) return;
    const crew = this.crewJson();
    if (crew === s.crewSent) return;
    this.setState({ crewSent: crew });
    const open = this.deps.db.prepare("SELECT id FROM messaging_conversations WHERE state = 'accepted'").all() as { id: string }[];
    for (const { id } of open) await this.sendCrew(id).catch((e) => this.deps.log.warn(`Cloud Messaging: Besetzung nicht gesendet: ${String(e)}`));
  }

  private async post(conversationId: string, env: Envelope, attachmentId: string | null): Promise<void> {
    const row = this.conversationRow(conversationId);
    const peer = this.peerRow(row.peer_elw)!;
    const ciphertext = await sealEnvelope(this.crypto(), env, peer.public_key);
    if (Buffer.byteLength(ciphertext) > MESSAGING_LIMITS.maxMessageBytes) throw new HttpError(413, 'Nachricht zu groß');
    await this.call('POST', '/v1/elws/me/messaging/messages', { conversationId, ciphertext, attachmentId });
  }

  /** Senden im Kanal „Fahrzeug-Chat“ (vom ChatService; peer = ELW-ID der Gegenseite) */
  async sendMessage(msg: OutgoingChat): Promise<SendResult> {
    this.requireRegistered();
    const conv = this.deps.db.prepare("SELECT * FROM messaging_conversations WHERE peer_elw = ? AND state = 'accepted' ORDER BY updated_at DESC").get(msg.peer) as ConversationRow | undefined;
    if (!conv) throw new HttpError(409, 'Kein verbundener Fahrzeug-Chat mit dieser Installation – erst anfragen');
    const operator = msg.operator ?? 'System';
    let env: Envelope;
    let attachmentId: string | null = null;
    if (msg.attachment) {
      const data = await readFile(msg.attachment.path);
      if (data.length > Math.min(CHAT_ATTACHMENT_MAX_BYTES, MESSAGING_LIMITS.maxAttachmentBytes - 28)) throw new HttpError(413, 'Anhang zu groß');
      const enc = encryptFile(data);
      attachmentId = (await this.callJson<{ id: string }>('POST', '/v1/elws/me/messaging/attachments', enc.blob)).id;
      env = this.envelope<'file'>(operator, { kind: 'file', text: msg.text, name: msg.attachment.name, mimeType: msg.attachment.mimeType, size: data.length, sha256: enc.sha256, key: enc.key });
    } else if (msg.location) {
      env = this.envelope<'location'>(operator, { kind: 'location', text: msg.text, ...msg.location });
    } else {
      env = this.envelope<'text'>(operator, { kind: 'text', text: msg.text });
    }
    await this.post(conv.id, env, attachmentId);
    this.deps.db.prepare('UPDATE messaging_conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), conv.id);
    const peer = toPeer(this.peerRow(conv.peer_elw)!);
    return { externalId: `${conv.id}:${env.id}`, info: `an ${vehicleLabel(peer.vehicle)} übermittelt (Ende-zu-Ende verschlüsselt)` };
  }

  // --- Eingang ---

  /** Neue Ereignisse abholen; läuft nie doppelt (ein Anstoß während des Abrufs führt zu einem weiteren Durchlauf) */
  pull(): Promise<void> {
    if (this.pulling) {
      this.pullAgain = true;
      return this.pulling;
    }
    this.pulling = (async () => {
      do {
        this.pullAgain = false;
        await this.pullOnce();
      } while (this.pullAgain);
    })()
      .catch((e) => {
        this.connection.error = e instanceof Error ? e.message : String(e);
        this.deps.log.warn(`Cloud Messaging: Abruf fehlgeschlagen: ${this.connection.error}`);
      })
      .finally(() => {
        this.pulling = null;
      });
    return this.pulling;
  }

  private async pullOnce(): Promise<void> {
    if (!this.state().registered || !this.deps.mail.activeCrypto()) return;
    for (;;) {
      const cursor = this.state().cursor;
      // Der Cursor quittiert alles bis dahin – erst danach löscht das Relay
      const batch = await this.callJson<MessagingEventBatch>('GET', `/v1/elws/me/messaging/events?after=${cursor}`);
      if (batch.items.length === 0) return;
      for (const e of batch.items) {
        try {
          await this.handle(e);
        } catch (err) {
          // Ein kaputtes Ereignis darf den Eingang nicht blockieren
          this.audit('System', 'receive', e.from, false, `Ereignis ${e.type} nicht verarbeitet: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.setState({ cursor: e.seq });
      }
      if (batch.items.length < EVENT_BATCH) {
        // Letzte Quittung, damit das Relay sofort aufräumt
        await this.callJson<MessagingEventBatch>('GET', `/v1/elws/me/messaging/events?after=${this.state().cursor}`).catch(() => undefined);
        return;
      }
    }
  }

  private async handle(e: MessagingEvent): Promise<void> {
    const crypto = this.crypto();
    if (e.type === 'request') {
      const peer = await this.fetchPeer(e.from);
      const opened = await openEnvelope(crypto, e.ciphertext ?? '', peer.public_key);
      if (!opened.ok || opened.envelope.kind !== 'request') throw new Error(opened.ok ? 'Anfrage erwartet' : `Anfrage ungültig (${opened.reason})`);
      const env = opened.envelope;
      this.deps.db
        .prepare(
          `INSERT INTO messaging_conversations (id, peer_elw, direction, state, requested_by, created_at, updated_at) VALUES (?, ?, 'in', 'requested', ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(e.conversationId, e.from, JSON.stringify(env.sender), e.at, e.at);
      this.audit('System', 'incoming', peer.address, true, `Chat-Anfrage von ${crewLabel(env.sender)}, ${vehicleLabel(env.vehicle)}`);
      this.deps.notify(['messaging', 'audit']);
      return;
    }

    const row = this.deps.db.prepare('SELECT * FROM messaging_conversations WHERE id = ?').get(e.conversationId) as ConversationRow | undefined;
    if (!row || row.peer_elw !== e.from) throw new Error('Unbekannter Chat');

    if (e.type === 'state') {
      this.deps.db.prepare('UPDATE messaging_conversations SET state = ?, updated_at = ? WHERE id = ?').run(e.state, e.at, row.id);
      const peer = toPeer(this.peerRow(row.peer_elw)!);
      const verb = { requested: 'angefragt', accepted: 'angenommen', declined: 'abgelehnt', closed: 'beendet' }[e.state];
      this.audit('System', `peer-${e.state}`, peer.address, true, `${vehicleLabel(peer.vehicle)} hat den Chat ${verb}`);
      this.deps.notify(['messaging', 'chat', 'audit']);
      if (e.state === 'accepted') await this.sendCrew(row.id);
      return;
    }

    const peerRow = this.peerRow(row.peer_elw)!;
    const opened = await openEnvelope(crypto, e.ciphertext ?? '', peerRow.public_key);
    if (!opened.ok) {
      if (opened.reason === 'unknown-kind') {
        // Neuere Gegenseite (z. B. Lagekarte): nicht unterstützt, aber kein Fehler
        this.audit('System', 'unsupported', peerRow.address, true, `Nachricht der Art „${opened.kind}“ wird von dieser ELVIS-Version nicht unterstützt`);
        this.deps.notify(['audit']);
        return;
      }
      throw new Error(opened.reason === 'signature' ? 'Signatur der Gegenseite ungültig – Nachricht verworfen' : 'Nachricht unlesbar');
    }
    const env = opened.envelope;
    const peer = toPeer(peerRow);
    const base: Omit<IncomingChat, 'text' | 'attachment' | 'location'> = {
      channel: 'elvis',
      peer: row.peer_elw,
      number: null,
      // Thread-Name ist das Fahrzeug (aus dem Chat); je Nachricht steht hier, wer geschrieben hat
      peerName: crewLabel(env.sender),
      externalId: `${row.id}:${env.id}`,
      receivedAt: e.at,
    };
    switch (env.kind) {
      case 'crew':
        this.deps.db.prepare('UPDATE messaging_conversations SET peer_crew = ? WHERE id = ?').run(JSON.stringify({ crew: env.crew, incident: env.incident }), row.id);
        this.deps.notify(['messaging']);
        return;
      case 'request':
        return;
      case 'meldung':
        await this.receiveMeldung(env, row.peer_elw, peer, base);
        return;
      case 'text':
        await this.ingest({ ...base, text: env.text, attachment: null, location: null });
        return;
      case 'location':
        await this.ingest({ ...base, text: env.text, attachment: null, location: { lat: env.lat, lon: env.lon, label: env.label } });
        return;
      case 'file': {
        if (!e.attachment) throw new Error('Anhang fehlt');
        const blob = await this.call('GET', `/v1/elws/me/messaging/attachments/${e.attachment.id}`);
        const data = decryptFile(blob, env.key, env.sha256);
        await this.ingest({ ...base, text: env.text, attachment: { name: env.name, mimeType: env.mimeType, data }, location: null });
        return;
      }
    }
  }

  /** Ausgangsmeldung an eine Kraft, die per Fahrzeug-Chat erreichbar ist, an deren ELVIS-Installation übermitteln */
  async sendMeldung(input: unknown, operator: string): Promise<{ info: string }> {
    const { messageId } = messagingSendMeldungSchema.parse(input);
    this.requireRegistered();
    const m = this.deps.meldungen.message(messageId);
    if (m.direction !== 'out') throw new HttpError(400, 'Nur Ausgangsmeldungen werden übermittelt');
    if (m.doneAt) throw new HttpError(409, 'Meldung ist bereits erledigt');
    const unit = m.recipientUnitId !== null ? this.deps.meldungen.units(m.incidentId).find((u) => u.id === m.recipientUnitId) : undefined;
    if (!unit?.messagingPeer) throw new HttpError(409, 'Die Empfänger-Kraft ist keiner ELVIS-Installation zugeordnet (Nachrichten › Kraft zuordnen)');
    const conv = this.deps.db.prepare("SELECT * FROM messaging_conversations WHERE peer_elw = ? AND state = 'accepted' ORDER BY updated_at DESC").get(unit.messagingPeer) as ConversationRow | undefined;
    if (!conv) throw new HttpError(409, `Kein verbundener Fahrzeug-Chat mit ${unit.name} – erst anfragen`);
    const incident = this.deps.meldungen.incident();
    const env = this.envelope<'meldung'>(operator, {
      kind: 'meldung',
      number: m.id,
      from: m.sender,
      to: m.recipient ?? unit.name,
      lage: incident?.id === m.incidentId ? incident.label : '',
      body: m.body,
      createdAt: m.createdAt,
    });
    await this.post(conv.id, env, null);
    this.deps.db.prepare('UPDATE messaging_conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), conv.id);
    this.chat?.recordSent({ channel: 'elvis', peer: unit.messagingPeer, text: meldungText(env), externalId: `${conv.id}:${env.id}`, createdBy: operator });
    const peer = toPeer(this.peerRow(unit.messagingPeer)!);
    const info = `Meldung #${m.id} an ${vehicleLabel(peer.vehicle)} übermittelt`;
    this.audit(operator, 'meldung', peer.address, true, info);
    this.deps.notify(['audit']);
    return { info };
  }

  /** Meldung einer anderen Installation: mit laufender Lage als Eingangsmeldung, immer auch im Chat */
  private async receiveMeldung(env: Extract<Envelope, { kind: 'meldung' }>, elwId: string, peer: MessagingPeer, base: Omit<IncomingChat, 'text' | 'attachment' | 'location'>): Promise<void> {
    await this.ingest({ ...base, text: meldungText(env), attachment: null, location: null });
    const incident = this.deps.meldungen.incident();
    if (!incident) {
      this.audit('System', 'meldung-in', peer.address, true, `Meldung #${env.number} von ${vehicleLabel(peer.vehicle)} ohne laufende Lage – nur im Fahrzeug-Chat`);
      this.deps.notify(['audit']);
      return;
    }
    const unit = this.deps.meldungen.units(incident.id).find((u) => u.messagingPeer === elwId && u.status !== 'entlassen');
    const text = unit ? unit.name : `${peer.vehicle.callsign || peer.vehicle.name} (${env.from})`;
    const created = this.deps.meldungen.receive(incident.id, { unitId: unit?.id ?? null, text }, meldungBody(env, peer), `Fahrzeug-Chat: ${crewLabel(env.sender)}`);
    this.audit('System', 'meldung-in', peer.address, true, `Meldung #${env.number} von ${vehicleLabel(peer.vehicle)} als Eingangsmeldung #${created.id}`);
    this.deps.notify(['audit']);
  }

  private async ingest(m: IncomingChat): Promise<void> {
    if (!this.chat) throw new Error('Nachrichten nicht verfügbar');
    await this.chat.ingest(m);
  }

  // --- Betrieb ---

  start(): void {
    if (!this.enabled) return;
    this.crewTimer ??= setInterval(() => void this.checkCrew(), CREW_CHECK_MS);
    if (!this.state().registered) return;
    if (!this.deps.mail.activeCrypto()) {
      this.setConnection('disabled', 'Kein aktives ELVIS-Postfach');
      return;
    }
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
    if (this.crewTimer) clearInterval(this.crewTimer);
    if (this.poller) clearInterval(this.poller);
    this.crewTimer = this.poller = null;
  }

  /** Postfach wurde aktiv bzw. ist weg: Verbindung entsprechend auf- oder abbauen */
  mailChanged(): void {
    if (!this.state().registered) return;
    if (this.deps.mail.activeCrypto()) {
      if (!this.socket.running) this.start();
    } else if (this.socket.running) {
      this.socket.stop();
      this.setConnection('disabled', 'Kein aktives ELVIS-Postfach');
    }
  }

  private audit(operator: string, action: string, params: string, success: boolean, message: string): void {
    this.deps.store.addAudit({ operator, target: 'messaging', action, params, success, message });
  }
}

/** Meldung im Chatverlauf */
function meldungText(env: Extract<Envelope, { kind: 'meldung' }>): string {
  return `Meldung #${env.number} von ${env.from} an ${env.to}${env.lage ? ` (${env.lage})` : ''}:\n${env.body}`;
}

/** Text der Eingangsmeldung: Herkunft vorn, damit sie beim Verteilen klar ist */
function meldungBody(env: Extract<Envelope, { kind: 'meldung' }>, peer: MessagingPeer): string {
  return `${env.body}\n\n_Per Fahrzeug-Chat von ${vehicleLabel(peer.vehicle)}: Meldung #${env.number} von ${env.from} an ${env.to}${env.lage ? `, Lage „${env.lage}“` : ''}._`;
}

function profileOf(r: MessagingProfileStatus): MessagingStatus['profile'] {
  const p = r.profile;
  return p ? { regionArs: p.regionArs, regionLabel: p.regionLabel, listed: p.listed, address: p.address, fingerprint: p.fingerprint, vehicle: p.vehicle } : null;
}
