import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CHAT_IMAGE_TYPES, phoneKey, type MessengerState, type RelayHookEvent } from '@elvis/shared';
import { BaseAdapter, CommandError, type AdapterContext } from '../../adapter.js';
import type { HookSource, MessengerAdapter, MessengerBus, OutgoingChat, SendResult } from '../../messaging/bus.js';

export interface WhatsAppOptions {
  /** Phone-Number-ID aus dem Meta-Entwicklerportal (WhatsApp → API-Setup) */
  phoneNumberId: string;
  /** Dauerhaftes Zugriffstoken eines Systembenutzers */
  accessToken: string;
  /** App-Geheimnis: prüft die Signatur der Webhooks */
  appSecret: string;
  /** Freigegebene Vorlage für Nachrichten außerhalb des 24-h-Fensters; leer = dann nicht senden */
  templateName: string;
  templateLanguage: string;
  /** Die Vorlage hat einen Textbaustein {{1}} für den Nachrichtentext */
  templateHasText: boolean;
  graphUrl: string;
}

/** Ausschnitt eines Webhook-Aufrufs von Meta */
interface WaWebhook {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: {
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body: string };
          image?: { id: string; mime_type?: string; caption?: string };
          location?: { latitude: number; longitude: number; name?: string; address?: string };
        }[];
        statuses?: { id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; errors?: { code?: number; title?: string; message?: string }[] }[];
      };
    }[];
  }[];
}

const TIMEOUT_MS = 20_000;
/** Bekannte Fehlercodes der Cloud API */
const ERROR_TEXT: Record<number, string> = {
  131047: 'mehr als 24 h seit der letzten Nachricht – nur mit Vorlage',
  131026: 'Empfänger nutzt kein WhatsApp oder kann die Nachricht nicht empfangen',
  131056: 'zu viele Nachrichten an diese Nummer',
  130429: 'Durchsatzgrenze erreicht',
  190: 'Zugriffstoken ungültig oder abgelaufen',
  133010: 'Nummer ist für die Cloud API nicht registriert (Anleitung: „Fehler beheben“)',
};

/** Signatur X-Hub-Signature-256 = sha256=HMAC(App-Geheimnis, Rohdaten) */
export function validSignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(body, 'utf8').digest('hex'));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * WhatsApp über die offizielle Cloud API von Meta: Senden direkt über die Graph API, Empfang und Zustellbestätigungen
 * als Webhook über das Cloud-Relay. Ob eine Rufnummer WhatsApp nutzt, verrät die Cloud API nicht. Freie Nachrichten
 * gehen nur bis 24 h nach der letzten Nachricht der Gegenstelle, sonst nur eine freigegebene Vorlage.
 */
export class WhatsAppCloudAdapter extends BaseAdapter<'whatsapp'> implements MessengerAdapter<'whatsapp'> {
  protected readonly commands = {};
  private webhook: { url: string; verifyToken: string } | null = null;
  private unsubscribe: (() => void) | null = null;
  private retry: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: WhatsAppOptions,
    private readonly bus: MessengerBus,
    private readonly hooks: HookSource,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super('whatsapp', 'cloud-api', {
      status: 'connecting',
      account: null,
      link: { connected: false, target: 'WhatsApp Cloud API', error: null, lastEventAt: null },
      capabilities: { images: true, location: true, reachability: false },
      setup: null,
    } satisfies MessengerState);
    this.online = false;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    if (!this.opts.phoneNumberId || !this.opts.accessToken || !this.opts.appSecret) {
      this.update((s) => {
        s.status = 'setup';
        s.setup = { step: 'info', hint: 'Phone-Number-ID, Zugriffstoken und App-Geheimnis aus dem Meta-Entwicklerportal in den Moduleinstellungen eintragen.' };
      });
      return;
    }
    this.unsubscribe = this.hooks.subscribe('whatsapp', (e) => this.hook(e));
    await this.connect();
  }

  override async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private graph(path: string): string {
    return `${this.opts.graphUrl.replace(/\/+$/, '')}/${path.replace(/^\//, '')}`;
  }

  private async api<T>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.graph(path), {
        method: init.method ?? (init.json || init.form ? 'POST' : 'GET'),
        headers: { authorization: `Bearer ${this.opts.accessToken}`, ...(init.json !== undefined && { 'content-type': 'application/json' }) },
        body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new CommandError(`WhatsApp nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`, 503);
    }
    const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number; error_data?: { details?: string } } }) | null;
    if (!res.ok || body?.error) {
      const err = body?.error;
      const text = (err?.code !== undefined && ERROR_TEXT[err.code]) || err?.error_data?.details || err?.message || `HTTP ${res.status}`;
      throw new CommandError(`WhatsApp: ${text}`, res.status === 401 ? 502 : 502);
    }
    return body as T;
  }

  private async connect(): Promise<void> {
    try {
      const info = await this.api<{ display_phone_number?: string; verified_name?: string }>(`${this.opts.phoneNumberId}?fields=display_phone_number,verified_name`);
      let hint: string | null = null;
      if (this.hooks.enabled) {
        try {
          this.webhook = await this.hooks.register('whatsapp');
        } catch (e) {
          hint = `Webhook beim Relay nicht angelegt: ${e instanceof Error ? e.message : String(e)} – Senden geht, Empfang nicht.`;
        }
      } else hint = 'Ohne Cloud-Relay (app.relayUrl) kommen keine Nachrichten an – Senden geht.';
      this.setOnline(true);
      this.update((s) => {
        s.status = 'connected';
        s.account = info.display_phone_number ? phoneKey(info.display_phone_number) : this.opts.phoneNumberId;
        s.link = { ...s.link!, connected: true, error: null };
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

  /** Webhook-Aufruf vom Relay: Signatur prüfen, Nachrichten und Zustellbestätigungen weitergeben */
  async hook(e: RelayHookEvent): Promise<void> {
    if (!validSignature(this.opts.appSecret, e.body, e.signature)) {
      this.ctx.log.warn('WhatsApp: Webhook mit ungültiger Signatur verworfen');
      return;
    }
    const data = JSON.parse(e.body) as WaWebhook;
    for (const entry of data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value;
        if (!v || (v.metadata?.phone_number_id && v.metadata.phone_number_id !== this.opts.phoneNumberId)) continue;
        for (const st of v.statuses ?? []) {
          const err = st.errors?.[0];
          this.bus.receipt({ channel: 'whatsapp', externalId: st.id, status: st.status, error: err ? ((err.code !== undefined && ERROR_TEXT[err.code]) || err.message || err.title) : null });
        }
        for (const m of v.messages ?? []) await this.incoming(m, v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null);
      }
    }
    this.update((s) => {
      s.link = { ...s.link!, lastEventAt: new Date().toISOString() };
    });
  }

  private async incoming(m: NonNullable<NonNullable<NonNullable<NonNullable<WaWebhook['entry']>[number]['changes']>[number]['value']>['messages']>[number], name: string | null): Promise<void> {
    const number = phoneKey(`+${m.from}`);
    let text = '';
    let attachment: { name: string; mimeType: string; data: Buffer } | null = null;
    let location: { lat: number; lon: number; label: string } | null = null;
    if (m.type === 'text') text = m.text?.body ?? '';
    else if (m.type === 'image' && m.image) {
      text = m.image.caption ?? '';
      attachment = await this.download(m.image.id, m.image.mime_type ?? 'image/jpeg').catch((err) => {
        this.ctx.log.warn(`WhatsApp: Bild nicht geladen: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (!attachment) text = text || '[Bild konnte nicht geladen werden]';
    } else if (m.type === 'location' && m.location) {
      location = { lat: m.location.latitude, lon: m.location.longitude, label: [m.location.name, m.location.address].filter(Boolean).join(', ') };
    } else text = `[${m.type} wird nicht unterstützt]`;
    this.bus.message({ channel: 'whatsapp', peer: number, number, peerName: name, text, attachment, location, externalId: m.id, receivedAt: new Date(Number(m.timestamp) * 1000).toISOString() });
  }

  /** Medien: erst die Adresse abfragen, dann mit dem Token laden */
  private async download(mediaId: string, mimeType: string): Promise<{ name: string; mimeType: string; data: Buffer }> {
    const meta = await this.api<{ url: string; mime_type?: string }>(mediaId);
    const res = await this.fetchFn(meta.url, { headers: { authorization: `Bearer ${this.opts.accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (meta.mime_type ?? mimeType).split(';')[0]!;
    return { name: `whatsapp-${mediaId}.${type.split('/')[1] ?? 'jpg'}`, mimeType: CHAT_IMAGE_TYPES.includes(type) ? type : 'image/jpeg', data: Buffer.from(await res.arrayBuffer()) };
  }

  private async post(to: string, payload: Record<string, unknown>): Promise<string> {
    const res = await this.api<{ messages?: { id: string }[] }>(`${this.opts.phoneNumberId}/messages`, { json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload } });
    return res.messages?.[0]?.id ?? '';
  }

  async sendMessage(msg: OutgoingChat): Promise<SendResult> {
    const number = msg.number ?? msg.peer;
    const to = phoneKey(number).replace(/^\+/, '');
    if (!/^\d{6,}$/.test(to)) throw new CommandError(`WhatsApp: „${number}“ ist keine Rufnummer`, 400);
    if (msg.windowOpen === false) {
      if (!this.opts.templateName) throw new CommandError('WhatsApp: mehr als 24 h seit der letzten Nachricht dieser Nummer – freie Nachrichten gehen nicht. Eine freigegebene Vorlage in den Moduleinstellungen eintragen.', 409);
      const text = [msg.text, msg.location ? `https://www.openstreetmap.org/?mlat=${msg.location.lat}&mlon=${msg.location.lon}` : ''].filter(Boolean).join('\n');
      const id = await this.post(to, {
        type: 'template',
        template: {
          name: this.opts.templateName,
          language: { code: this.opts.templateLanguage || 'de' },
          ...(this.opts.templateHasText && { components: [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\s*\n\s*/g, ' · ').slice(0, 1000) || '–' }] }] }),
        },
      });
      return { externalId: id || null, info: `WhatsApp-Vorlage „${this.opts.templateName}“ an ${number} gesendet (außerhalb des 24-h-Fensters)` };
    }
    let id = '';
    if (msg.attachment) {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', msg.attachment.mimeType);
      form.append('file', new Blob([await readFile(msg.attachment.path)], { type: msg.attachment.mimeType }), msg.attachment.name);
      const media = await this.api<{ id: string }>(`${this.opts.phoneNumberId}/media`, { form });
      id = await this.post(to, { type: 'image', image: { id: media.id, ...(msg.text && { caption: msg.text.slice(0, 1024) }) } });
    } else if (msg.text) id = await this.post(to, { type: 'text', text: { body: msg.text, preview_url: true } });
    if (msg.location) {
      const loc = await this.post(to, { type: 'location', location: { latitude: msg.location.lat, longitude: msg.location.lon, ...(msg.location.label && { name: msg.location.label }) } });
      id ||= loc;
    }
    return { externalId: id || null, info: `WhatsApp an ${number} gesendet` };
  }
}
