import { readFile } from 'node:fs/promises';
import { CHAT_IMAGE_TYPES, parseLocationLink, phoneKey, type MessengerSetupInput, type MessengerState } from '@elvis/shared';
import { BaseAdapter, CommandError, type AdapterContext } from '../../adapter.js';
import type { MessengerAdapter, MessengerBus, OutgoingChat, ReachabilityResult, SendResult } from '../../messaging/bus.js';

export interface SignalOptions {
  /**
   * Adresse und Token von signal-cli aus dem Addon „Signal (signal-cli)“; null = Addon läuft nicht. Wird bei jedem
   * Verbindungsversuch neu gelesen (das Addon kann später starten).
   */
  endpoint: () => { url: string; token: string | null } | null;
  /** Eigene Rufnummer; leer = erstes Konto im Daemon */
  account: string | null;
  /** Name als verknüpftes Gerät in der Signal-App */
  deviceName: string;
  /** Profilname für Empfänger; null = Profil nicht ändern (bei gekoppeltem Handy gehört das Profil dem Handy) */
  profileName?: string | null;
  /** Info-Text im Profil (nur zusammen mit profileName) */
  profileAbout?: string | null;
  reconnectMs: number;
}

interface RpcError {
  code: number;
  message: string;
}

/** Ausschnitt einer Nachricht, wie signal-cli sie meldet (method „receive“) */
export interface SignalEnvelope {
  source?: string;
  sourceNumber?: string | null;
  sourceUuid?: string;
  sourceName?: string;
  timestamp: number;
  dataMessage?: {
    timestamp?: number;
    message?: string | null;
    attachments?: { contentType: string; filename?: string | null; id: string; size?: number }[];
    groupInfo?: unknown;
  };
  receiptMessage?: { isDelivery?: boolean; isRead?: boolean; isViewed?: boolean; timestamps?: number[] };
}

const RPC_TIMEOUT_MS = 30_000;
/** finishLink wartet, bis das Handy den QR-Code gescannt hat */
const LINK_TIMEOUT_MS = 10 * 60_000;

const ERROR_TEXT: Record<string, string> = {
  UNREGISTERED_FAILURE: 'nutzt kein Signal',
  NETWORK_FAILURE: 'Netzwerkfehler',
  IDENTITY_FAILURE: 'Sicherheitsnummer hat sich geändert',
  RATE_LIMIT_FAILURE: 'zu viele Nachrichten (Signal drosselt)',
  CAPTCHA_REQUIRED_FAILURE: 'Signal verlangt ein Captcha',
};

/**
 * Signal über den Daemon von signal-cli (`signal-cli daemon --http=127.0.0.1:8080`, auch im Docker-Container):
 * JSON-RPC unter /api/v1/rpc, eingehende Nachrichten und Empfangsbestätigungen als Server-Sent Events unter
 * /api/v1/events. Einrichten als verknüpftes Gerät (QR-Code in der Signal-App scannen) oder mit eigener Nummer
 * (Registrierung mit Captcha und Bestätigungscode per SMS).
 */
export class SignalCliAdapter extends BaseAdapter<'signal'> implements MessengerAdapter<'signal'> {
  protected readonly commands = {};
  private stopped = false;
  private events: AbortController | null = null;
  private retry: NodeJS.Timeout | null = null;
  private qr: string | null = null;
  /** Nummer einer laufenden Registrierung */
  private registering: string | null = null;
  private seq = 0;

  constructor(
    private readonly opts: SignalOptions,
    private readonly bus: MessengerBus,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super('signal', 'signal-cli', {
      status: 'connecting',
      account: null,
      link: { connected: false, target: opts.endpoint()?.url ?? 'signal-cli', error: null, lastEventAt: null },
      capabilities: { images: true, files: true, location: false, reachability: true },
      setup: null,
    } satisfies MessengerState);
    this.online = false;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    void this.connect();
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    this.events?.abort();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  /** Kennung des Kontos für die Aufrufe (Rufnummer, ohne Nummer die ACI) und die ACI zum Zuordnen der Ereignisse */
  private accountId: string | null = null;
  private aci: string | null = null;
  /** Letztes Ereignis im Strom: nach einem Abbruch liefert signal-cli ab hier nach (Last-Event-ID) */
  private lastEventId: string | null = null;

  private endpoint(): { url: string; token: string | null } {
    const e = this.opts.endpoint();
    if (!e) throw new CommandError('Kein signal-cli: Addon „Signal (signal-cli)“ installieren und starten', 503);
    return { url: e.url.replace(/\/+$/, ''), token: e.token };
  }

  private base(): string {
    return this.endpoint().url;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const { token } = this.endpoint();
    return { ...extra, ...(token && { authorization: `Bearer ${token}` }) };
  }

  async rpc<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    let res: Response;
    const base = this.base();
    try {
      res = await this.fetchFn(`${base}/api/v1/rpc`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new CommandError(`signal-cli nicht erreichbar (${base}): ${e instanceof Error ? e.message : String(e)}`, 503);
    }
    if (res.status === 401) throw new CommandError('signal-cli lehnt das Token ab – Addon „Signal (signal-cli)“ neu starten', 502);
    const body = (await res.json().catch(() => null)) as { result?: T; error?: RpcError } | null;
    if (!res.ok && !body?.error) throw new CommandError(`signal-cli antwortet mit HTTP ${res.status}`, 502);
    if (body?.error) throw new CommandError(`Signal: ${body.error.message}`, 502);
    return body?.result as T;
  }

  /** RPC für das eigene Konto */
  private call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.accountId) throw new CommandError('Signal ist noch nicht eingerichtet', 409);
    return this.rpc<T>(method, { account: this.accountId, ...params }, timeoutMs);
  }

  private later(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, this.opts.reconnectMs);
  }

  /** Konto ermitteln und den Ereignisstrom öffnen; bei Fehlern später erneut */
  async connect(): Promise<void> {
    if (this.stopped) return;
    let account: { number: string | null; aci?: string | null } | null;
    try {
      const target = this.base();
      this.update((s) => {
        s.link = { ...s.link!, target };
      });
      const accounts = (await this.rpc<{ number: string | null; aci?: string | null }[]>('listAccounts')) ?? [];
      const wanted = this.opts.account ? phoneKey(this.opts.account) : null;
      account = wanted ? (accounts.find((a) => a.number && phoneKey(a.number) === wanted) ?? null) : (accounts[0] ?? null);
      if (wanted && !account && accounts.length) throw new Error(`Konto ${wanted} gibt es in signal-cli nicht (vorhanden: ${accounts.map((a) => a.number ?? a.aci).join(', ')})`);
    } catch (e) {
      this.setOnline(false);
      this.update((s) => {
        s.status = 'error';
        s.link = { ...s.link!, connected: false, error: e instanceof Error ? e.message.replace(/^Signal: /, '') : String(e) };
      });
      return this.later();
    }
    this.setOnline(true);
    if (!account) {
      // Daemon läuft, aber ohne Konto: Einrichtung in den Einstellungen
      this.update((s) => {
        s.status = 'setup';
        s.account = null;
        s.link = { ...s.link!, connected: true, error: null };
        if (!s.setup || s.setup.step === 'info') s.setup = { step: 'start', hint: 'Noch kein Signal-Konto: als verknüpftes Gerät koppeln (QR-Code) oder eine eigene Nummer registrieren.' };
      });
      return;
    }
    this.qr = null;
    this.registering = null;
    this.accountId = account.number ?? account.aci ?? null;
    this.aci = account.aci ?? null;
    this.update((s) => {
      s.status = 'connected';
      s.account = account!.number ? phoneKey(account!.number) : `ACI ${account!.aci}`;
      s.setup = null;
      s.link = { ...s.link!, connected: true, error: null };
    });
    void this.listen();
    void this.syncProfile();
  }

  /** Zuletzt gesetztes Profil (Konto + Werte), damit Wiederverbindungen es nicht jedes Mal neu schreiben */
  private profileKey: string | null = null;

  /** Profilname aus den Moduleinstellungen in Signal setzen; Fehler nur protokollieren */
  private async syncProfile(): Promise<void> {
    const name = this.opts.profileName;
    if (!name || !this.accountId) return;
    const about = this.opts.profileAbout ?? '';
    const key = JSON.stringify([this.accountId, name, about]);
    if (this.profileKey === key) return;
    try {
      await this.call('updateProfile', { givenName: name, familyName: '', about });
      this.profileKey = key;
      this.ctx.log.info(`Signal: Profilname „${name}“ gesetzt`);
    } catch (e) {
      this.ctx.log.warn(`Signal: Profil nicht gesetzt: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Ereignisstrom lesen (Server-Sent Events, je Ereignis eine JSON-RPC-Benachrichtigung) */
  private async listen(): Promise<void> {
    this.events?.abort();
    const ctrl = new AbortController();
    this.events = ctrl;
    try {
      // Alle Konten des Daemons; die Ereignisse tragen das Konto (Rufnummer oder ACI) und werden in handle() gefiltert
      const headers = this.headers({ accept: 'text/event-stream', ...(this.lastEventId && { 'last-event-id': this.lastEventId }) });
      const res = await this.fetchFn(`${this.base()}/api/v1/events`, { headers, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`Ereignisstrom: HTTP ${res.status}`);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = event.split('\n');
          const id = lines.find((l) => l.startsWith('id:'))?.slice(3).trim();
          if (id) this.lastEventId = id;
          const name = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? null;
          const data = lines
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (data) await this.handle(data, name).catch((e) => this.ctx.log.warn(`Signal: Ereignis nicht verarbeitet: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      throw new Error('Ereignisstrom beendet');
    } catch (e) {
      if (ctrl.signal.aborted || this.stopped) return;
      this.update((s) => {
        s.status = 'error';
        s.link = { ...s.link!, connected: false, error: e instanceof Error ? e.message : String(e) };
      });
      this.later();
    }
  }

  /**
   * Ein Ereignis aus /api/v1/events. signal-cli schickt dort keine JSON-RPC-Benachrichtigung, sondern
   * `event:receive` mit `{"account": …, "envelope": …}` (SseEventBuffer/JsonReceiveMessageHandler). Die JSON-RPC-Form
   * (`method: receive`, ggf. in params.result) wird ebenfalls angenommen.
   */
  async handle(data: string, event: string | null = null): Promise<void> {
    type Received = { envelope?: SignalEnvelope; account?: string };
    const msg = JSON.parse(data) as Received & { method?: string; params?: Received & { result?: Received } };
    const p = msg.method === 'receive' ? (msg.params?.result?.envelope ? msg.params.result : msg.params) : event === null || event === 'receive' ? msg : null;
    if (!p?.envelope) return;
    // Konto als Rufnummer oder (Multi-Account-Modus) als ACI
    if (p.account && this.accountId && p.account !== this.accountId && p.account !== this.aci && !(p.account.startsWith('+') && phoneKey(p.account) === this.state.account)) return;
    const env = p.envelope;
    this.update((s) => {
      s.link = { ...s.link!, lastEventAt: new Date().toISOString() };
    });
    await this.envelope(env);
  }

  /** Nachricht bzw. Empfangsbestätigung an die Nachrichten weitergeben (nur Einzelchats, keine Gruppen) */
  async envelope(env: SignalEnvelope): Promise<void> {
    const r = env.receiptMessage;
    if (r?.timestamps?.length) {
      const status = r.isRead || r.isViewed ? 'read' : r.isDelivery ? 'delivered' : null;
      if (status) for (const ts of r.timestamps) this.bus.receipt({ channel: 'signal', externalId: String(ts), status });
      return;
    }
    const dm = env.dataMessage;
    if (!dm || dm.groupInfo) return;
    const text = dm.message ?? '';
    const image = dm.attachments?.find((a) => CHAT_IMAGE_TYPES.includes(a.contentType));
    if (!text && !image) return;
    const number = env.sourceNumber ? phoneKey(env.sourceNumber) : env.source?.startsWith('+') ? phoneKey(env.source) : null;
    // Kennung ist die UUID (ACI): Bei verborgener Rufnummer ist sie das Einzige, was ankommt; ist die Nummer dabei, lernt
    // ELVIS so die Zuordnung UUID → Rufnummer für spätere Nachrichten ohne Nummer
    const peer = env.sourceUuid ?? number ?? env.source ?? 'unbekannt';
    let attachment: { name: string; mimeType: string; data: Buffer } | null = null;
    if (image) {
      try {
        const res = await this.call<{ data: string }>('getAttachment', { id: image.id, recipient: env.sourceUuid ?? peer });
        attachment = { name: image.filename || image.id, mimeType: image.contentType, data: Buffer.from(res.data, 'base64') };
      } catch (e) {
        this.ctx.log.warn(`Signal: Bild nicht geladen: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const where = parseLocationLink(text);
    this.bus.message({
      channel: 'signal',
      peer,
      number,
      peerName: env.sourceName || null,
      text: text || (image && !attachment ? '[Bild konnte nicht geladen werden]' : ''),
      attachment,
      location: where ? { ...where, label: '' } : null,
      externalId: `${env.sourceUuid ?? peer}:${env.timestamp}`,
      receivedAt: new Date(env.timestamp).toISOString(),
    });
  }

  async sendMessage(msg: OutgoingChat): Promise<SendResult> {
    const params: Record<string, unknown> = { recipient: [msg.number ?? msg.peer], message: msg.text };
    if (msg.attachment) {
      const data = await readFile(msg.attachment.path);
      // Daten-URL statt Pfad: signal-cli läuft ggf. in einem anderen Container
      params.attachments = [`data:${msg.attachment.mimeType};filename=${msg.attachment.name.replace(/[;,]/g, '_')};base64,${data.toString('base64')}`];
    }
    const res = await this.call<{ timestamp: number; results?: { type: string }[] }>('send', params);
    const failed = res.results?.find((r) => r.type !== 'SUCCESS');
    if (failed) throw new CommandError(`Signal: ${msg.number ?? msg.peer} ${ERROR_TEXT[failed.type] ?? failed.type}`, 502);
    return { externalId: String(res.timestamp), info: `Signal an ${msg.number ?? msg.peer} gesendet` };
  }

  async checkReachable(numbers: string[]): Promise<ReachabilityResult> {
    const res = await this.call<{ recipient: string; number?: string | null; uuid?: string | null; isRegistered: boolean }[]>('getUserStatus', { recipient: numbers });
    const out: ReachabilityResult = new Map();
    for (const r of res ?? []) {
      const n = phoneKey(r.number ?? r.recipient);
      // UUID merken: Nachrichten ohne Rufnummer (Nummer verborgen) lassen sich darüber der Nummer zuordnen
      out.set(n, { reachable: r.isRegistered, peer: r.isRegistered ? (r.uuid ?? n) : null });
    }
    return out;
  }

  setupDetails() {
    return { qr: this.qr, webhook: null };
  }

  async setup(input: MessengerSetupInput): Promise<string | void> {
    switch (input.action) {
      case 'link': {
        const { deviceLinkUri } = await this.rpc<{ deviceLinkUri: string }>('startLink');
        this.qr = deviceLinkUri;
        this.update((s) => {
          s.setup = { step: 'qr', hint: 'In der Signal-App unter Einstellungen → Verknüpfte Geräte → „Gerät hinzufügen“ den QR-Code scannen.', error: null };
        });
        // Wartet, bis das Handy gescannt hat
        this.rpc<unknown>('finishLink', { deviceLinkUri, deviceName: this.opts.deviceName }, LINK_TIMEOUT_MS)
          .then(() => this.connect())
          .catch((e) => {
            if (this.qr !== deviceLinkUri) return;
            this.qr = null;
            this.update((s) => {
              s.setup = { step: 'start', hint: 'Koppeln abgebrochen – erneut versuchen.', error: e instanceof Error ? e.message : String(e) };
            });
          });
        return 'QR-Code zum Koppeln erzeugt';
      }
      case 'register': {
        if (!input.number) throw new CommandError('Rufnummer fehlt', 400);
        const number = phoneKey(input.number);
        await this.rpc('register', { account: number, ...(input.captcha && { captcha: input.captcha.replace(/^signalcaptcha:\/\//, '') }), ...(input.voice && { voice: true }) });
        this.registering = number;
        this.update((s) => {
          s.setup = { step: 'code', hint: `Signal schickt einen Bestätigungscode an ${number}${input.voice ? ' per Anruf.' : ' per SMS. Steckt die SIM im GSM-Gateway, steht er unter Nachrichten.'}`, error: null };
        });
        return `Registrierung für ${number} gestartet`;
      }
      case 'code': {
        if (!this.registering) throw new CommandError('Keine Registrierung offen', 409);
        if (!input.code) throw new CommandError('Code fehlt', 400);
        try {
          await this.rpc('verify', { account: this.registering, verificationCode: input.code.replace(/\D/g, ''), ...(input.password && { pin: input.password }) });
        } catch (e) {
          this.update((s) => {
            s.setup = { ...s.setup!, error: e instanceof Error ? e.message : String(e) };
          });
          throw e;
        }
        await this.connect();
        return 'Signal-Konto eingerichtet';
      }
      case 'cancel':
        this.qr = null;
        this.registering = null;
        this.update((s) => {
          s.setup = s.account ? null : { step: 'start', hint: 'Noch kein Signal-Konto: als verknüpftes Gerät koppeln (QR-Code) oder eine eigene Nummer registrieren.' };
        });
        return;
      default:
        throw new CommandError(`Signal kennt die Aktion „${input.action}“ nicht`, 400);
    }
  }
}
