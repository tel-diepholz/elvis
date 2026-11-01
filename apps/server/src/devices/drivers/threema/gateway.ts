import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import nacl from 'tweetnacl';
import { CHAT_IMAGE_TYPES, phoneKey, type MessengerState, type RelayHookEvent } from '@elvis/shared';
import { BaseAdapter, CommandError, type AdapterContext } from '../../adapter.js';
import type { HookSource, MessengerAdapter, MessengerBus, OutgoingChat, ReachabilityResult, SendResult } from '../../messaging/bus.js';

export interface ThreemaOptions {
  /** Gateway-ID im E2E-Modus, z. B. *ELVIS01 */
  gatewayId: string;
  /** API-Secret der Gateway-ID */
  secret: string;
  /** Privater Schlüssel der Gateway-ID (64 Hex-Zeichen, auch „private:…“) */
  privateKey: string;
  apiUrl: string;
}

/** Schlüssel für den Hash der Rufnummer bei der Suche (Threema Gateway API) */
const PHONE_HASH_KEY = Buffer.from('85adf8226953f3d96cfd5d09bf29555eb955fcd8aa5ec4f9fcd869e258370723', 'hex');
const TYPE = { text: 0x01, location: 0x10, file: 0x17, receipt: 0x80 } as const;
/** Nonces der Blobs (Datei bzw. Vorschaubild) sind fest, der Schlüssel ist je Datei neu */
const FILE_NONCE = new Uint8Array([...new Array(23).fill(0), 1]);
const TIMEOUT_MS = 20_000;

export const phoneHash = (number: string) => createHmac('sha256', PHONE_HASH_KEY).update(phoneKey(number).replace(/^\+/, '')).digest('hex');
export const parsePrivateKey = (k: string) => Buffer.from(k.trim().replace(/^private:/i, ''), 'hex');

/** Klartext: Typ, Inhalt und zufälliges Auffüllen (PKCS#7-artig, zusammen mindestens 32 Byte) */
export function pad(type: number, payload: Uint8Array): Uint8Array {
  let n = 1 + (randomBytes(1)[0]! % 255);
  if (1 + payload.length + n < 32) n = 32 - 1 - payload.length;
  return new Uint8Array([type, ...payload, ...new Array(n).fill(n)]);
}

export function unpad(data: Uint8Array): { type: number; payload: Uint8Array } {
  const n = data[data.length - 1]!;
  if (data.length < 2 || n < 1 || n >= data.length) throw new Error('Auffüllung ungültig');
  return { type: data[0]!, payload: data.subarray(1, data.length - n) };
}

/** MAC eines Rückrufs: HMAC-SHA256(API-Secret, from‖to‖messageId‖date‖nonce‖box) */
export function callbackMac(secret: string, p: URLSearchParams): string {
  return createHmac('sha256', secret)
    .update(['from', 'to', 'messageId', 'date', 'nonce', 'box'].map((k) => p.get(k) ?? '').join(''))
    .digest('hex');
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

/**
 * Threema über das Threema Gateway im E2E-Modus: ELVIS ver- und entschlüsselt selbst (der private Schlüssel bleibt im
 * Fahrzeug), sendet direkt an msgapi.threema.ch und empfängt über das Cloud-Relay (Rückruf-URL der Gateway-ID).
 * Jede Nachricht kostet Credits. Erreichbarkeit über die Suche nach dem Hash der Rufnummer.
 */
export class ThreemaGatewayAdapter extends BaseAdapter<'threema'> implements MessengerAdapter<'threema'> {
  protected readonly commands = {};
  private readonly pubkeys = new Map<string, Uint8Array>();
  private webhook: { url: string; verifyToken: string | null } | null = null;
  private unsubscribe: (() => void) | null = null;
  private retry: NodeJS.Timeout | null = null;
  private readonly key: Uint8Array;

  constructor(
    private readonly opts: ThreemaOptions,
    private readonly bus: MessengerBus,
    private readonly hooks: HookSource,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super('threema', 'gateway-e2e', {
      status: 'connecting',
      account: null,
      link: { connected: false, target: 'Threema Gateway', error: null, lastEventAt: null },
      capabilities: { images: true, location: true, reachability: true },
      setup: null,
    } satisfies MessengerState);
    this.online = false;
    this.key = parsePrivateKey(opts.privateKey);
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    if (!/^\*[A-Z0-9]{7}$/.test(this.opts.gatewayId) || !this.opts.secret || this.key.length !== 32) {
      this.update((s) => {
        s.status = 'setup';
        s.setup = { step: 'info', hint: 'Gateway-ID (E2E, z. B. *ELVIS01), API-Secret und privaten Schlüssel (64 Hex-Zeichen) in den Moduleinstellungen eintragen.' };
      });
      return;
    }
    this.unsubscribe = this.hooks.subscribe('threema', (e) => this.hook(e));
    await this.connect();
  }

  override async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const q = new URLSearchParams({ from: this.opts.gatewayId, secret: this.opts.secret, ...query });
    return `${this.opts.apiUrl.replace(/\/+$/, '')}${path}?${q}`;
  }

  private async request(path: string, init: { method?: string; body?: BodyInit; query?: Record<string, string> } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path, init.query), { method: init.method ?? 'GET', body: init.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new CommandError(`Threema nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`, 503);
    }
    return res;
  }

  private async ok(res: Response, what: string): Promise<Response> {
    if (res.ok) return res;
    const reason: Record<number, string> = { 400: 'ungültige Anfrage', 401: 'Gateway-ID oder Secret falsch', 402: 'keine Credits mehr', 404: 'nicht gefunden', 413: 'zu groß', 429: 'zu viele Anfragen' };
    throw new CommandError(`Threema: ${what} – ${reason[res.status] ?? `HTTP ${res.status}`}`, res.status === 404 ? 404 : 502);
  }

  private async connect(): Promise<void> {
    try {
      const credits = (await (await this.ok(await this.request('/credits'), 'Guthaben')).text()).trim();
      let hint: string | null = null;
      if (this.hooks.enabled) {
        try {
          const h = await this.hooks.register('threema');
          this.webhook = { url: h.url, verifyToken: null };
        } catch (e) {
          hint = `Rückruf beim Relay nicht angelegt: ${e instanceof Error ? e.message : String(e)} – Senden geht, Empfang nicht.`;
        }
      } else hint = 'Ohne Cloud-Relay (app.relayUrl) kommen keine Nachrichten an – Senden geht.';
      this.setOnline(true);
      this.update((s) => {
        s.status = 'connected';
        s.account = this.opts.gatewayId;
        s.link = { connected: true, target: `Threema Gateway · ${credits} Credits`, error: null, lastEventAt: s.link?.lastEventAt ?? null };
        s.setup = hint ? { step: 'info', hint } : null;
      });
    } catch (e) {
      this.setOnline(false);
      this.update((s) => {
        s.status = 'error';
        s.link = { ...s.link!, connected: false, error: e instanceof Error ? e.message : String(e) };
      });
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.connect();
      }, 60_000);
    }
  }

  setupDetails() {
    return { qr: null, webhook: this.webhook };
  }

  private async pubkey(id: string): Promise<Uint8Array> {
    const cached = this.pubkeys.get(id);
    if (cached) return cached;
    const k = unhex((await (await this.ok(await this.request(`/pubkeys/${encodeURIComponent(id)}`), `Schlüssel von ${id}`)).text()).trim());
    if (k.length !== 32) throw new CommandError(`Threema: Schlüssel von ${id} ungültig`, 502);
    this.pubkeys.set(id, k);
    return k;
  }

  /** Rufnummer → Threema-ID (null = nutzt kein Threema bzw. hat die Nummer nicht verknüpft) */
  async lookup(number: string): Promise<string | null> {
    const res = await this.request(`/lookup/phone_hash/${phoneHash(number)}`);
    if (res.status === 404) return null;
    return (await (await this.ok(res, 'Suche')).text()).trim();
  }

  // --- Senden ---

  private async sendBox(to: string, type: number, payload: Uint8Array): Promise<string> {
    const nonce = nacl.randomBytes(24);
    const box = nacl.box(pad(type, payload), nonce, await this.pubkey(to), this.key);
    const body = new URLSearchParams({ from: this.opts.gatewayId, to, nonce: hex(nonce), box: hex(box), secret: this.opts.secret });
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.apiUrl.replace(/\/+$/, '')}/send_e2e`, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new CommandError(`Threema nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`, 503);
    }
    return (await (await this.ok(res, `Senden an ${to}`)).text()).trim().toLowerCase();
  }

  private async resolve(msg: Pick<OutgoingChat, 'peer' | 'number'>): Promise<string> {
    if (/^[A-Z0-9*]{8}$/.test(msg.peer)) return msg.peer;
    const number = msg.number ?? msg.peer;
    const id = await this.lookup(number);
    if (!id) throw new CommandError(`Threema: ${number} ist mit keiner Threema-ID verknüpft`, 404);
    return id;
  }

  async sendMessage(msg: OutgoingChat): Promise<SendResult> {
    const to = await this.resolve(msg);
    let id = '';
    if (msg.attachment) {
      const data = await readFile(msg.attachment.path);
      const key = nacl.randomBytes(32);
      const blob = nacl.secretbox(new Uint8Array(data), FILE_NONCE, key);
      const form = new FormData();
      form.append('blob', new Blob([Buffer.from(blob)]), 'blob');
      const blobId = (await (await this.ok(await this.request('/upload_blob', { method: 'POST', body: form }), 'Bild hochladen')).text()).trim();
      const file = { b: blobId, k: hex(key), m: msg.attachment.mimeType, n: msg.attachment.name, s: data.length, i: 0, j: 1, ...(msg.text && { d: msg.text }) };
      id = await this.sendBox(to, TYPE.file, new TextEncoder().encode(JSON.stringify(file)));
    } else if (msg.text) id = await this.sendBox(to, TYPE.text, new TextEncoder().encode(msg.text));
    if (msg.location) {
      const text = `${msg.location.lat.toFixed(6)},${msg.location.lon.toFixed(6)}${msg.location.label ? `\n${msg.location.label}` : ''}`;
      const loc = await this.sendBox(to, TYPE.location, new TextEncoder().encode(text));
      id ||= loc;
    }
    return { externalId: id || null, info: `Threema an ${to}${msg.number ? ` (${msg.number})` : ''} gesendet` };
  }

  async checkReachable(numbers: string[]): Promise<ReachabilityResult> {
    const out: ReachabilityResult = new Map();
    for (const n of numbers) {
      const id = await this.lookup(n);
      out.set(n, id ? { reachable: true, peer: id } : { reachable: false, peer: null });
    }
    return out;
  }

  // --- Empfang ---

  /** Rückruf über das Relay: MAC prüfen, entschlüsseln, je Typ weitergeben */
  async hook(e: RelayHookEvent): Promise<void> {
    const p = new URLSearchParams(e.body);
    const mac = p.get('mac') ?? '';
    const want = callbackMac(this.opts.secret, p);
    if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) {
      this.ctx.log.warn('Threema: Rückruf mit ungültigem MAC verworfen');
      return;
    }
    if (p.get('to') !== this.opts.gatewayId) return;
    const from = p.get('from')!;
    const plain = nacl.box.open(unhex(p.get('box') ?? ''), unhex(p.get('nonce') ?? ''), await this.pubkey(from), this.key);
    if (!plain) {
      this.ctx.log.warn(`Threema: Nachricht von ${from} nicht entschlüsselbar`);
      return;
    }
    const { type, payload } = unpad(plain);
    const messageId = (p.get('messageId') ?? '').toLowerCase();
    const receivedAt = new Date(Number(p.get('date') ?? 0) * 1000 || Date.now()).toISOString();
    const nickname = p.get('nickname')?.trim() || null;
    const base = { channel: 'threema' as const, peer: from, number: null, peerName: nickname, externalId: messageId || null, receivedAt };
    const text = () => new TextDecoder().decode(payload);
    this.update((s) => {
      s.link = { ...s.link!, lastEventAt: new Date().toISOString() };
    });

    if (type === TYPE.receipt) {
      const status = payload[0] === 1 ? 'delivered' : payload[0] === 2 ? 'read' : null;
      if (!status) return;
      for (let i = 1; i + 8 <= payload.length; i += 8) this.bus.receipt({ channel: 'threema', externalId: hex(payload.subarray(i, i + 8)), status });
      return;
    }
    if (type === TYPE.text) return this.bus.message({ ...base, text: text(), attachment: null, location: null });
    if (type === TYPE.location) {
      const [coords = '', ...rest] = text().split('\n');
      const [lat, lon] = coords.split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      return this.bus.message({ ...base, text: '', attachment: null, location: { lat: lat!, lon: lon!, label: rest.filter(Boolean).join(', ') } });
    }
    if (type === TYPE.file) {
      const f = JSON.parse(text()) as { b: string; k: string; m: string; n?: string; d?: string };
      let attachment: { name: string; mimeType: string; data: Buffer } | null = null;
      if (CHAT_IMAGE_TYPES.includes(f.m)) {
        try {
          const res = await this.ok(await this.request(`/blobs/${encodeURIComponent(f.b)}`), 'Bild laden');
          const opened = nacl.secretbox.open(new Uint8Array(await res.arrayBuffer()), FILE_NONCE, unhex(f.k));
          if (opened) attachment = { name: f.n || `threema-${f.b}`, mimeType: f.m, data: Buffer.from(opened) };
        } catch (err) {
          this.ctx.log.warn(`Threema: Bild nicht geladen: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return this.bus.message({ ...base, text: f.d ?? (attachment ? '' : `[Datei ${f.n ?? ''} (${f.m}) wird nicht unterstützt]`), attachment, location: null });
    }
    // Andere Typen (Umfragen, Gruppen …) werden nicht übernommen
  }
}
