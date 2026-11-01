import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  CHAT_CHANNEL_LABEL,
  CHAT_CHANNELS,
  CHAT_IMAGE_TYPES,
  DEFAULT_CHANNEL_ORDER,
  MESSENGER_IDS,
  SMS_MAX_LENGTH,
  chatDraftSchema,
  chatPeer,
  chatSettingsSchema,
  isMessenger,
  locationLink,
  looksLikePhone,
  phoneKey,
  type ChatAttachment,
  type ChatAvailability,
  type ChatChannel,
  type ChatChannelInfo,
  type ChatDraft,
  type ChatFolder,
  type ChatList,
  type ChatMessage,
  type ChatSettings,
  type ChatStatus,
  type MessengerId,
  type MessengerSetupInfo,
  type MessengerSetupInput,
  type PhoneMatch,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import type { DeviceManager } from '../devices/manager.js';
import { isMessengerAdapter, type ChatReceipt, type IncomingChat, type MessengerAdapter, type MessengerBus } from '../devices/messaging/bus.js';
import type { IncomingSms, TelephonyBus } from '../devices/telephony/bus.js';
import { HttpError } from '../errors.js';
import { writeStream } from './files.js';

export interface ChatDeps {
  store: Store;
  devices: Pick<DeviceManager, 'adapter' | 'execute' | 'module'>;
  telephony: TelephonyBus;
  messenger: MessengerBus;
  numbers: () => Map<string, PhoneMatch>;
  notify: (topics: Topic[]) => void;
  dataDir: string;
}

interface Row {
  id: number;
  channel: ChatChannel;
  folder: ChatFolder;
  peer: string;
  number: string | null;
  peer_name: string | null;
  text: string;
  attachment_id: string | null;
  lat: number | null;
  lon: number | null;
  location_label: string | null;
  port: number | null;
  status: ChatStatus;
  error: string | null;
  seen: number;
  date: string;
  created_by: string;
  external_id: string | null;
  a_name: string | null;
  a_mime_type: string | null;
  a_size: number | null;
}

const SELECT = 'SELECT m.*, f.name AS a_name, f.mime_type AS a_mime_type, f.size AS a_size FROM chat_messages m LEFT JOIN chat_files f ON f.id = m.attachment_id';

/** Rangfolge der Zustände gesendeter Nachrichten – eine späte „zugestellt“-Meldung überschreibt kein „gelesen“ */
const STATUS_RANK: Record<ChatStatus, number> = { received: 0, sending: 1, failed: 2, sent: 3, delivered: 4, read: 5 };

/**
 * Nachrichten: SMS (GSM-Gateway) und Messenger in einem Postfach mit Eingang und Gesendet. Gesendet wird im Hintergrund;
 * jede gesendete Nachricht steht im Bedienprotokoll.
 */
export class ChatService {
  private readonly fileDir: string;

  constructor(
    private readonly db: Db,
    private readonly deps: ChatDeps,
  ) {
    this.fileDir = join(deps.dataDir, 'chat');
    mkdirSync(this.fileDir, { recursive: true });
    deps.telephony.onSms((s) => this.ingestSms(s));
    deps.messenger.onMessage((m) => {
      this.ingest(m).catch(() => undefined);
    });
    deps.messenger.onReceipt((r) => this.receipt(r));
    // Beim Start noch „wird gesendet“: das Ergebnis ist verloren
    db.prepare("UPDATE chat_messages SET status = 'failed', error = 'Abgebrochen (ELVIS neu gestartet)' WHERE status = 'sending'").run();
  }

  // --- Einstellungen ---

  settings(): ChatSettings {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = 'chat:order'").get() as { value: string } | undefined;
    const parsed = r ? chatSettingsSchema.safeParse({ order: JSON.parse(r.value) }) : null;
    return { order: parsed?.success ? parsed.data.order : [...DEFAULT_CHANNEL_ORDER] };
  }

  updateSettings(input: unknown, operator: string): ChatSettings {
    const s = chatSettingsSchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('chat:order', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      )
      .run(JSON.stringify(s.order), new Date().toISOString(), operator);
    this.deps.notify(['chat']);
    return this.settings();
  }

  // --- Kanäle ---

  private messenger(channel: MessengerId): MessengerAdapter | null {
    const a = this.deps.devices.adapter(channel);
    return isMessengerAdapter(a) ? a : null;
  }

  private smsInfo(): { info: ChatChannelInfo; ports: ChatAvailability['ports']; defaultPort: number | null } {
    const adapter = this.deps.devices.adapter('telephony');
    const state = adapter?.getState();
    const available = !!adapter && !!state?.capabilities.sms;
    const ports = available ? state!.trunks.map((t) => ({ port: t.port, name: t.name, status: t.status })) : [];
    const smsPort = available ? Number(this.deps.devices.module('telephony').config.options.smsPort ?? 1) : 0;
    const defaultPort = ports.some((p) => p.port === smsPort) ? smsPort : (ports.find((p) => p.status === 'up')?.port ?? ports[0]?.port ?? null);
    const up = ports.some((p) => p.status === 'up');
    return {
      info: { channel: 'sms', label: 'SMS', available, account: null, status: !available ? 'offline' : up ? 'connected' : 'error', images: false, location: false, reachability: true, window24h: false },
      ports,
      defaultPort,
    };
  }

  private channelInfo(channel: MessengerId): ChatChannelInfo {
    const adapter = this.messenger(channel);
    const state = adapter?.getState();
    return {
      channel,
      label: CHAT_CHANNEL_LABEL[channel],
      // Eingerichtet = eigenes Konto bekannt; eine kurze Störung blendet den Kanal nicht aus
      available: !!state && state.account !== null,
      account: state?.account ?? null,
      status: state?.status ?? 'offline',
      images: !!state?.capabilities.images,
      location: !!state?.capabilities.location,
      reachability: !!state?.capabilities.reachability,
      window24h: channel === 'whatsapp' && adapter?.driver === 'cloud-api',
    };
  }

  available(): ChatAvailability {
    const sms = this.smsInfo();
    const order = this.settings().order;
    const channels = [sms.info, ...MESSENGER_IDS.map((c) => this.channelInfo(c))].sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel));
    return { available: channels.some((c) => c.available), channels, order, ports: sms.ports, defaultPort: sms.defaultPort };
  }

  // --- Einrichtung der Messenger (nur Admins) ---

  setupInfo(channel: MessengerId): MessengerSetupInfo {
    const a = this.messenger(channel);
    if (!a) throw new HttpError(409, `${CHAT_CHANNEL_LABEL[channel]} ist nicht aktiv`);
    const details = a.setupDetails?.();
    return { channel, driver: a.driver, setup: a.getState().setup, qr: details?.qr ?? null, webhook: details?.webhook ?? null };
  }

  /** Einrichtungsschritt; ins Bedienprotokoll nur die Aktion (Codes und Passwörter nicht) */
  async setup(channel: MessengerId, input: MessengerSetupInput, operator: string): Promise<{ message: string | null }> {
    const a = this.messenger(channel);
    if (!a) throw new HttpError(409, `${CHAT_CHANNEL_LABEL[channel]} ist nicht aktiv`);
    if (!a.setup) throw new HttpError(400, `Der Treiber „${a.driver}“ braucht keine Einrichtung`);
    const entry = { operator, target: channel, action: `setup.${input.action}`, params: input.action === 'register' && input.number ? phoneKey(input.number) : '' };
    try {
      const message = (await a.setup(input)) ?? null;
      this.deps.store.addAudit({ ...entry, success: true, message: message ?? '' });
      return { message };
    } catch (e) {
      this.deps.store.addAudit({ ...entry, success: false, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      this.deps.notify(['audit']);
    }
  }

  // --- Eingang ---

  ingestSms(s: IncomingSms): ChatMessage {
    const number = phoneKey(s.number);
    const info = this.db
      .prepare("INSERT INTO chat_messages (channel, folder, peer, number, text, port, status, seen, date, created_by) VALUES ('sms', 'inbox', ?, ?, ?, ?, 'received', 0, ?, 'Gateway')")
      .run(number, number, s.text, s.port, s.receivedAt);
    this.deps.notify(['chat']);
    return this.message(Number(info.lastInsertRowid));
  }

  async ingest(m: IncomingChat): Promise<ChatMessage | null> {
    if (m.externalId && this.db.prepare('SELECT 1 FROM chat_messages WHERE channel = ? AND external_id = ?').get(m.channel, m.externalId)) return null;
    // Rufnummer aus einer früheren Erreichbarkeitsprüfung (z. B. Threema-ID → Rufnummer)
    const known = this.db.prepare('SELECT number FROM chat_reachability WHERE channel = ? AND peer = ? AND reachable = 1').get(m.channel, m.peer) as { number: string } | undefined;
    const number = m.number ? phoneKey(m.number) : (known?.number ?? null);
    const fileId = m.attachment ? await this.storeFile(m.attachment.name, m.attachment.mimeType, m.attachment.data, 'Messenger') : null;
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO chat_messages (channel, folder, peer, number, peer_name, text, attachment_id, lat, lon, location_label, status, seen, date, created_by, external_id)
         VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, ?, ?, ?)`,
      )
      .run(m.channel, m.peer, number, m.peerName, m.text, fileId, m.location?.lat ?? null, m.location?.lon ?? null, m.location?.label ?? null, m.receivedAt, CHAT_CHANNEL_LABEL[m.channel], m.externalId);
    if (info.changes === 0) return null;
    // Wer schreibt, ist über diesen Messenger erreichbar
    if (number) {
      this.db
        .prepare('INSERT INTO chat_reachability (channel, number, reachable, peer, checked_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(channel, number) DO UPDATE SET reachable = 1, peer = excluded.peer, checked_at = excluded.checked_at')
        .run(m.channel, number, m.peer, new Date().toISOString());
    }
    this.deps.notify(['chat']);
    return this.message(Number(info.lastInsertRowid));
  }

  private receipt(r: ChatReceipt): void {
    const row = this.db.prepare("SELECT id, status FROM chat_messages WHERE channel = ? AND external_id = ? AND folder = 'sent'").get(r.channel, r.externalId) as
      | { id: number; status: ChatStatus }
      | undefined;
    if (!row || (r.status !== 'failed' && STATUS_RANK[r.status] <= STATUS_RANK[row.status])) return;
    this.db.prepare('UPDATE chat_messages SET status = ?, error = ? WHERE id = ?').run(r.status, r.status === 'failed' ? (r.error ?? 'Zustellung fehlgeschlagen') : null, row.id);
    this.deps.notify(['chat']);
  }

  // --- Lesen ---

  list(folder: ChatFolder): ChatList {
    const rows = this.db.prepare(`${SELECT} WHERE m.folder = ? ORDER BY m.date DESC, m.id DESC LIMIT 500`).all(folder) as Row[];
    const numbers = this.deps.numbers();
    return { items: rows.map((r) => toMessage(r, numbers)), unread: this.unread() };
  }

  /** Verlauf mit einer Rufnummer über alle Kanäle bzw. mit einer Gegenstelle ohne Rufnummer („kanal:kennung“), älteste zuerst */
  thread(key: string): ChatMessage[] {
    const k = key.trim();
    const sep = k.indexOf(':');
    const byPeer = sep > 0 && (CHAT_CHANNELS as readonly string[]).includes(k.slice(0, sep));
    const rows = (
      byPeer
        ? this.db.prepare(`SELECT * FROM (${SELECT} WHERE m.channel = ? AND m.peer = ? ORDER BY m.date DESC, m.id DESC LIMIT 200) ORDER BY date, id`).all(k.slice(0, sep), k.slice(sep + 1))
        : this.db.prepare(`SELECT * FROM (${SELECT} WHERE m.number = ? ORDER BY m.date DESC, m.id DESC LIMIT 200) ORDER BY date, id`).all(phoneKey(k))
    ) as Row[];
    const numbers = this.deps.numbers();
    return rows.map((r) => toMessage(r, numbers));
  }

  unread(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE folder = 'inbox' AND seen = 0").get() as { n: number }).n;
  }

  private row(id: number): Row {
    const r = this.db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'Nachricht nicht gefunden');
    return r;
  }

  message(id: number): ChatMessage {
    return toMessage(this.row(id), this.deps.numbers());
  }

  setSeen(id: number, seen: boolean): void {
    this.row(id);
    this.db.prepare('UPDATE chat_messages SET seen = ? WHERE id = ?').run(seen ? 1 : 0, id);
    this.deps.notify(['chat']);
  }

  remove(id: number, operator: string): void {
    const r = this.row(id);
    this.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(id);
    if (r.attachment_id) this.dropFileIfUnused(r.attachment_id);
    this.audit(operator, 'delete', r.number ?? r.peer, true, `${CHAT_CHANNEL_LABEL[r.channel]} ${r.folder === 'inbox' ? 'von' : 'an'} ${r.number ?? r.peer}`);
    this.deps.notify(['chat', 'audit']);
  }

  // --- Bilder ---

  async upload(file: { filename: string; mimeType: string; stream: Readable }, operator: string, maxBytes: number): Promise<ChatAttachment> {
    if (!CHAT_IMAGE_TYPES.includes(file.mimeType)) {
      file.stream.resume();
      throw new HttpError(415, 'Nur Bilder (JPEG, PNG, WebP, GIF)');
    }
    const id = randomBytes(16).toString('hex');
    const size = await writeStream(join(this.fileDir, id), file.stream, maxBytes);
    const name = file.filename.slice(0, 200) || 'bild';
    this.db.prepare('INSERT INTO chat_files (id, name, mime_type, size, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, file.mimeType, size, new Date().toISOString(), operator);
    return { id, name, mimeType: file.mimeType, size };
  }

  private async storeFile(name: string, mimeType: string, data: Buffer, by: string): Promise<string> {
    const id = randomBytes(16).toString('hex');
    await writeFile(join(this.fileDir, id), data);
    this.db.prepare('INSERT INTO chat_files (id, name, mime_type, size, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, name.slice(0, 200) || 'datei', mimeType, data.length, new Date().toISOString(), by);
    return id;
  }

  file(id: string): ChatAttachment & { path: string } {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(404, 'Datei nicht gefunden');
    const f = this.db.prepare('SELECT id, name, mime_type, size FROM chat_files WHERE id = ?').get(id) as { id: string; name: string; mime_type: string; size: number } | undefined;
    if (!f) throw new HttpError(404, 'Datei nicht gefunden');
    return { id: f.id, name: f.name, mimeType: f.mime_type, size: f.size, path: join(this.fileDir, f.id) };
  }

  private dropFileIfUnused(id: string): void {
    if (this.db.prepare('SELECT 1 FROM chat_messages WHERE attachment_id = ?').get(id)) return;
    this.db.prepare('DELETE FROM chat_files WHERE id = ?').run(id);
    unlink(join(this.fileDir, id)).catch(() => undefined);
  }

  /** Hochgeladene, aber nie gesendete Bilder nach einem Tag entfernen */
  cleanup(): void {
    const before = new Date(Date.now() - 86_400_000).toISOString();
    const orphans = this.db.prepare('SELECT id FROM chat_files f WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.attachment_id = f.id)').all(before) as { id: string }[];
    for (const o of orphans) this.dropFileIfUnused(o.id);
  }

  // --- Senden ---

  /** WhatsApp: Rufnummern, die in den letzten 24 h geschrieben haben (freie Antwort erlaubt) → letzte Nachricht */
  whatsappWindow(): Map<string, string> {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const rows = this.db.prepare("SELECT peer, MAX(date) AS last FROM chat_messages WHERE channel = 'whatsapp' AND folder = 'inbox' AND date > ? GROUP BY peer").all(since) as { peer: string; last: string }[];
    return new Map(rows.map((r) => [r.peer, r.last]));
  }

  /** Legt je Empfänger eine Nachricht an und sendet im Hintergrund; done() ist für Tests */
  send(input: ChatDraft, operator: string): { messages: ChatMessage[]; done: Promise<void> } {
    const draft = chatDraftSchema.parse(input);
    const avail = this.available();
    const attachment = draft.attachmentId ? this.file(draft.attachmentId) : null;
    const port = draft.port ?? avail.defaultPort;
    const seen = new Set<string>();
    const rows: { channel: ChatChannel; peer: string; number: string | null }[] = [];
    for (const r of draft.to) {
      const info = avail.channels.find((c) => c.channel === r.channel)!;
      const label = info.label;
      if (!info.available) throw new HttpError(409, r.channel === 'sms' ? 'Kein GSM-Gateway mit SMS aktiv' : `${label} ist nicht eingerichtet`);
      const { peer, number } = chatPeer(r.channel, r.to);
      if ((r.channel === 'sms' || r.channel === 'whatsapp') && !looksLikePhone(r.to)) throw new HttpError(400, `${label}: „${r.to}“ ist keine Rufnummer`);
      if (attachment && !info.images) throw new HttpError(400, `${label} kann keine Bilder übertragen`);
      if (r.channel === 'sms') {
        if (draft.port !== undefined && !avail.ports.some((p) => p.port === draft.port)) throw new HttpError(400, `Port ${draft.port} gibt es am Gateway nicht`);
        if (smsText(draft.text, draft.location).length > SMS_MAX_LENGTH) throw new HttpError(400, `SMS: höchstens ${SMS_MAX_LENGTH} Zeichen`);
        if (!smsText(draft.text, draft.location)) throw new HttpError(400, 'SMS: Text fehlt');
      }
      const key = `${r.channel}:${peer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ channel: r.channel, peer, number });
    }
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO chat_messages (channel, folder, peer, number, text, attachment_id, lat, lon, location_label, port, status, seen, date, created_by)
       VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?)`,
    );
    const loc = draft.location;
    const ids = this.db.transaction(() =>
      rows.map((r) => Number(insert.run(r.channel, r.peer, r.number, draft.text, attachment?.id ?? null, loc?.lat ?? null, loc?.lon ?? null, loc?.label ?? null, r.channel === 'sms' ? port : null, now, operator).lastInsertRowid)),
    )();
    this.deps.notify(['chat']);
    const done = (async () => {
      for (const id of ids) await this.deliver(id, operator).catch(() => undefined);
    })();
    return { messages: ids.map((id) => this.message(id)), done };
  }

  private async deliver(id: number, operator: string): Promise<void> {
    const r = this.row(id);
    let error: string | null = null;
    let result = '';
    let externalId: string | null = null;
    const location = r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon, label: r.location_label ?? '' } : null;
    try {
      if (r.channel === 'sms') {
        const text = smsText(r.text, location);
        result = String((await this.deps.devices.execute('telephony', 'sendSms', { number: r.peer, text, ...(r.port !== null && { port: r.port }) })) ?? 'gesendet');
      } else if (isMessenger(r.channel)) {
        const adapter = this.messenger(r.channel);
        if (!adapter) throw new HttpError(409, `${CHAT_CHANNEL_LABEL[r.channel]} ist nicht aktiv`);
        const state = adapter.getState();
        const known = r.number ? (this.db.prepare('SELECT peer FROM chat_reachability WHERE channel = ? AND number = ? AND reachable = 1').get(r.channel, r.number) as { peer: string | null } | undefined) : undefined;
        const out = await adapter.sendMessage({
          ...(r.channel === 'whatsapp' && { windowOpen: this.whatsappWindow().has(r.number ?? r.peer) }),
          peer: known?.peer ?? r.peer,
          number: r.number,
          // Ohne Standort-Fähigkeit geht der Standort als Kartenlink im Text
          text: location && !state.capabilities.location ? smsText(r.text, location) : r.text,
          attachment: r.attachment_id ? { name: r.a_name ?? 'bild', mimeType: r.a_mime_type ?? 'application/octet-stream', path: join(this.fileDir, r.attachment_id) } : null,
          location: state.capabilities.location ? location : null,
        });
        externalId = out.externalId;
        result = out.info;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // Eine Zustellbestätigung kann schon vor dem Speichern der Kennung eingetroffen sein – dann gilt der bessere Zustand
    this.db.prepare("UPDATE chat_messages SET status = CASE WHEN status IN ('delivered', 'read') THEN status ELSE ? END, error = ?, external_id = ? WHERE id = ?").run(error ? 'failed' : 'sent', error, externalId, id);
    this.audit(operator, 'send', r.number ?? r.peer, !error, error ? `${CHAT_CHANNEL_LABEL[r.channel]}: ${error}` : result);
    this.deps.notify(['chat', 'audit']);
  }

  private audit(operator: string, action: string, params: string, success: boolean, message: string): void {
    this.deps.store.addAudit({ operator, target: 'chat', action, params, success, message });
  }
}

/** Text einer SMS bzw. eines Messengers ohne Standort: Standort als Kartenlink anhängen */
export function smsText(text: string, location: { lat: number; lon: number; label: string } | null): string {
  if (!location) return text;
  const link = `${location.label ? `${location.label}: ` : ''}${locationLink(location)}`;
  return text ? `${text}\n${link}` : link;
}

function toMessage(r: Row, numbers: Map<string, PhoneMatch>): ChatMessage {
  return {
    id: r.id,
    channel: r.channel,
    folder: r.folder,
    peer: r.peer,
    number: r.number,
    name: (r.number ? numbers.get(r.number)?.name : null) ?? r.peer_name ?? null,
    text: r.text,
    attachment: r.attachment_id ? { id: r.attachment_id, name: r.a_name ?? 'bild', mimeType: r.a_mime_type ?? 'application/octet-stream', size: r.a_size ?? 0 } : null,
    location: r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon, label: r.location_label ?? '' } : null,
    port: r.port,
    status: r.status,
    error: r.error,
    seen: r.seen !== 0,
    date: r.date,
    createdBy: r.created_by,
  };
}
