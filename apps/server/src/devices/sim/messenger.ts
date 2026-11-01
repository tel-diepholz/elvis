import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { z } from 'zod';
import { CHAT_CHANNEL_LABEL, phoneKey, type MessengerId, type MessengerState } from '@elvis/shared';
import { CommandError, command } from '../adapter.js';
import type { MessengerAdapter, MessengerBus, OutgoingChat, ReachabilityResult, SendResult } from '../messaging/bus.js';
import { SimAdapter } from './sim-adapter.js';

const SIM_PEERS = [
  { number: '+491701234567', name: 'Gruppenführer HLF' },
  { number: '+491609876543', name: 'Bürgermeister' },
  { number: '+491515551234', name: 'Verpflegung' },
];
const SIM_TEXTS = ['Sind gleich da.', 'Bitte kurz zurückrufen.', 'Foto von der Lage kommt.', 'Zufahrt über die Hauptstraße ist frei.'];
const SIM_PLACES = [
  { lat: 52.6087, lon: 8.3712, label: 'Diepholz, Marktplatz' },
  { lat: 52.6015, lon: 8.3504, label: 'Bereitstellungsraum Sportplatz' },
];
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!;

const hash = (s: string) => createHash('sha256').update(s).digest();

/** Kennung im Dienst zur Rufnummer (Simulation): Threema-ID, Telegram-ID, sonst die Rufnummer */
export function simPeer(channel: MessengerId, number: string): string {
  const h = hash(`${channel}:${number}`);
  if (channel === 'threema') return [...h.subarray(0, 8)].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  if (channel === 'telegram') return String(100000000 + (h.readUInt32BE(0) % 900000000));
  // Signal kennt Absender über die UUID (ACI) – die Rufnummer kann verborgen sein
  if (channel === 'signal') {
    const x = h.toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
  }
  return number;
}

/** Nutzt die Rufnummer den Messenger? (Simulation: rund zwei Drittel, die Beispielnummern immer) */
export const simReachable = (channel: MessengerId, number: string) => SIM_PEERS.some((p) => p.number === number) || hash(`${channel}:${number}`)[0]! % 3 !== 0;

/**
 * Messenger zum Testen und Vorführen: Senden klappt nach einer Sekunde, danach „zugestellt“ und „gelesen“; gelegentlich
 * kommt eine Nachricht (Text, Standort). Eine Nachricht mit „#fehler“ im Text schlägt fehl.
 */
export class MessengerSim<K extends MessengerId> extends SimAdapter<K> implements MessengerAdapter<K> {
  protected readonly commands = {
    /** Zum Vorführen: eine Nachricht empfangen */
    simulate: command(
      z.object({ kind: z.enum(['text', 'location', 'image']), number: z.string().optional(), text: z.string().optional() }),
      ({ kind, number, text }) => this.receive(kind ?? 'text', number ? phoneKey(number) : undefined, text),
    ),
  };
  private seq = 0;
  private readonly createdAt = Date.now();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    id: K,
    private readonly bus: MessengerBus,
    private readonly opts: { sendDelayMs?: number; rate?: number } = {},
  ) {
    super(id, {
      status: 'connected',
      account: id === 'threema' ? '*ELVIS01' : '+491700000000',
      link: null,
      // Die WhatsApp Cloud API kann nicht prüfen, ob eine Rufnummer WhatsApp nutzt
      capabilities: { images: true, files: true, location: true, reachability: id !== 'whatsapp' },
      setup: null,
    } satisfies MessengerState);
  }

  override async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await super.stop();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  async sendMessage(msg: OutgoingChat): Promise<SendResult> {
    await new Promise((r) => setTimeout(r, this.opts.sendDelayMs ?? 1000));
    if (msg.text.includes('#fehler')) throw new CommandError(`${CHAT_CHANNEL_LABEL[this.id]} lehnt ab (Simulation)`, 502);
    const externalId = `sim-${this.id}-${Date.now()}-${++this.seq}`;
    this.later(1500, () => this.bus.receipt({ channel: this.id, externalId, status: 'delivered' }));
    this.later(4000, () => this.bus.receipt({ channel: this.id, externalId, status: 'read' }));
    return { externalId, info: `${CHAT_CHANNEL_LABEL[this.id]} an ${msg.number ?? msg.peer} gesendet` };
  }

  async checkReachable(numbers: string[]): Promise<ReachabilityResult> {
    if (this.id === 'whatsapp') throw new CommandError('Nicht möglich', 501);
    return new Map(numbers.map((n) => [n, simReachable(this.id, n) ? { reachable: true, peer: simPeer(this.id, n) } : { reachable: false, peer: null }]));
  }

  private receive(kind: 'text' | 'location' | 'image', number?: string, text?: string): void {
    const who = number ? { number, name: null } : pick(SIM_PEERS);
    const place = pick(SIM_PLACES);
    this.bus.message({
      channel: this.id,
      peer: simPeer(this.id, who.number),
      // Threema und Telegram verraten die Rufnummer nicht immer
      number: this.id === 'threema' ? null : who.number,
      peerName: who.name,
      text: text ?? (kind === 'location' ? '' : kind === 'image' ? 'Lagebild' : pick(SIM_TEXTS)),
      attachment: kind === 'image' ? { name: 'lagebild.png', mimeType: 'image/png', data: simImage() } : null,
      location: kind === 'location' ? place : null,
      externalId: `sim-in-${this.id}-${Date.now()}-${++this.seq}`,
      receivedAt: new Date().toISOString(),
    });
  }

  protected tick(): void {
    // Im Schnitt etwa alle 40 Minuten eine Nachricht – erst nach drei Minuten, damit kurze Läufe (Tests) ruhig bleiben
    if (Date.now() - this.createdAt < 180_000) return;
    if (Math.random() < (this.opts.rate ?? 1) / 2400) this.receive(Math.random() < 0.2 ? 'location' : 'text');
  }
}

/** Kleines Testbild (PNG mit Farbverlauf) */
export function simImage(width = 96, height = 64): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = 200 - Math.round((y / height) * 120);
      raw[row + 2 + x * 3] = 40 + Math.round((x / width) * 60);
      raw[row + 3 + x * 3] = 40;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
