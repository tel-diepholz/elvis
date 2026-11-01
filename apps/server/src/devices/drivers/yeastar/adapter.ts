import { Socket } from 'node:net';
import { z } from 'zod';
import { formatPhone, phoneKey, type ActiveCall, type GsmTrunk, type TelephonyState } from '@elvis/shared';
import { BaseAdapter, CommandError, command, type AdapterContext, type Command } from '../../adapter.js';
import type { TelephonyBus } from '../../telephony/bus.js';
import {
  AmiParser,
  action,
  channelSpan,
  parseReceivedSms,
  parseSmsUpdate,
  parseSpanDetail,
  parseSpans,
  portToSpan,
  rssiDbm,
  sendSmsCommand,
  signalPercent,
  spanToPort,
  trunkStatus,
  type AmiMessage,
  type ReceivedSms,
} from './protocol.js';
import { sipOptions } from './sip.js';

export interface YeastarOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Namen der Trunks je Port */
  trunks: Map<number, string>;
  /** Standard-Port für ausgehende SMS; null = erster verbundener Trunk */
  smsPort: number | null;
  /** SIP-Dienst des Gateways per OPTIONS prüfen; null = nicht prüfen */
  sipPort: number | null;
  pollMs: number;
  reconnectMs: number;
  /** Zeitüberschreitung für Antworten und Sendebestätigungen (Tests kürzer) */
  responseMs?: number;
  smsConfirmMs?: number;
}

/** Je Port „Nummer:Name“, mehrere durch Semikolon getrennt */
export const TRUNKS_PATTERN = '^\\s*(\\d{1,2}\\s*:[^:;]+)?(\\s*;\\s*\\d{1,2}\\s*:[^:;]+)*\\s*;?\\s*$';

export function parseTrunks(spec: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const part of spec.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const port = Number(part.slice(0, i).trim());
    const name = part.slice(i + 1).trim();
    if (!Number.isInteger(port) || port < 1 || !name) throw new Error(`Trunk „${part.trim()}“: erwartet Port:Name`);
    if (out.has(port)) throw new Error(`Port ${port} ist doppelt eingetragen`);
    out.set(port, name);
  }
  return out;
}

const sendSmsParams = z.object({
  number: z.string().trim().min(3).max(30),
  text: z.string().min(1).max(1000),
  port: z.number().int().min(1).max(32).optional(),
});

interface Pending {
  resolve: (m: AmiMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Channel {
  uniqueId: string;
  call: ActiveCall;
}

export function emptyTrunk(port: number, name: string): GsmTrunk {
  return {
    port,
    name,
    status: 'unknown',
    statusText: null,
    operator: null,
    registration: null,
    roaming: false,
    csq: null,
    signalPercent: null,
    rssiDbm: null,
    ber: null,
    model: null,
    imei: null,
    smsc: null,
    busy: false,
  };
}

/**
 * Yeastar NeoGate TG (GSM-Gateway) über die TG-API: Zustand der GSM-Trunks (Abfrage), SMS senden und empfangen,
 * Gespräche aus den Kanal-Ereignissen. Den SIP-Zustand meldet die API nicht – ELVIS prüft stattdessen, ob der
 * SIP-Dienst des Gateways antwortet. Unbekannte Ereignisse stehen einmalig im Log.
 */
export class YeastarTgAdapter extends BaseAdapter<'telephony'> {
  protected readonly commands: Record<string, Command<any>> = {
    sendSms: command(sendSmsParams, (p) => this.sendSms(p.number, p.text, p.port)),
  };
  private socket: Socket | null = null;
  private queue: Pending[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private loggedIn = false;
  private polling = false;
  private seq = 0;
  private readonly smsWaiters = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  private readonly parts = new Map<string, { parts: Map<number, string>; total: number; span: number; sender: string; timer: NodeJS.Timeout }>();
  private readonly channels = new Map<string, Channel>();
  private readonly seenEvents = new Set<string>();
  private readonly responseMs: number;
  private readonly smsConfirmMs: number;

  constructor(
    private readonly opts: YeastarOptions,
    private readonly bus: TelephonyBus,
  ) {
    super('telephony', 'yeastar-tg', {
      link: { connected: false, target: `${opts.host}:${opts.port}`, error: null, lastEventAt: null },
      trunks: [...opts.trunks].sort(([a], [b]) => a - b).map(([port, name]) => emptyTrunk(port, name)),
      sip: { reachable: null, registration: null, checkedAt: null, target: opts.sipPort ? `${opts.host}:${opts.sipPort}` : null },
      calls: [],
      capabilities: { sms: true },
    } satisfies TelephonyState);
    this.online = false;
    this.responseMs = opts.responseMs ?? 10_000;
    this.smsConfirmMs = opts.smsConfirmMs ?? 90_000;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    this.connect();
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.reconnectTimer = this.pollTimer = null;
    for (const p of this.parts.values()) clearTimeout(p.timer);
    this.parts.clear();
    this.socket?.destroy();
    this.socket = null;
    this.failPending(new Error('Treiber gestoppt'));
  }

  // --- Verbindung ---

  private connect(): void {
    const { host, port } = this.opts;
    const socket = new Socket();
    this.socket = socket;
    this.loggedIn = false;
    const parser = new AmiParser();
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 10_000);
    socket.setTimeout(10_000, () => socket.destroy(new Error('Zeitüberschreitung beim Verbindungsaufbau')));
    let error: string | null = null;
    socket.once('connect', () => {
      socket.setTimeout(0);
      void this.login(socket).catch((err: Error) => {
        error = err.message;
        socket.destroy();
      });
    });
    socket.on('data', (chunk: string) => {
      for (const m of parser.push(chunk)) this.handle(m);
    });
    socket.on('error', (err) => {
      error = err.message;
    });
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.loggedIn = false;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.failPending(new Error(error ?? 'Verbindung getrennt'));
      this.endAllCalls();
      if (this.stopped) return;
      const msg = error ?? 'Verbindung getrennt';
      this.ctx.log.warn(`Yeastar TG ${host}:${port}: ${msg} – neuer Versuch in ${Math.round(this.opts.reconnectMs / 1000)} s`);
      this.setLink(false, msg);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.stopped) this.connect();
      }, this.opts.reconnectMs);
    });
    socket.connect(port, host);
  }

  private async login(socket: Socket): Promise<void> {
    const res = await this.request(socket, action('Login', { Username: this.opts.username, Secret: this.opts.password, Events: 'on' }));
    if (!/^success$/i.test(res.fields.response ?? '')) throw new Error(`Anmeldung abgelehnt: ${res.fields.message ?? 'unbekannter Fehler'} (API-Benutzer im Gateway prüfen)`);
    this.loggedIn = true;
    this.ctx.log.info(`Yeastar TG: angemeldet an ${this.opts.host}:${this.opts.port}`);
    this.setLink(true, null);
    void this.pollLoop();
  }

  private setLink(connected: boolean, error: string | null): void {
    this.online = connected;
    this.update((s) => {
      s.link = { ...s.link!, connected, error };
      if (!connected) for (const t of s.trunks) Object.assign(t, { status: 'unknown', busy: false });
    });
  }

  private request(socket: Socket, text: string): Promise<AmiMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.queue.findIndex((p) => p.timer === timer);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error('Gateway antwortet nicht'));
        socket.destroy(new Error('Gateway antwortet nicht'));
      }, this.responseMs);
      this.queue.push({ resolve, reject, timer });
      socket.write(text);
    });
  }

  private command(cmd: string): Promise<AmiMessage> {
    if (!this.socket || !this.loggedIn) return Promise.reject(new CommandError('Gateway nicht verbunden', 503));
    return this.request(this.socket, action('SMSCommand', { Command: cmd }));
  }

  private failPending(err: Error): void {
    for (const p of this.queue.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    for (const [id, w] of this.smsWaiters) {
      clearTimeout(w.timer);
      w.resolve(false);
      this.smsWaiters.delete(id);
    }
  }

  // --- Abfrage ---

  private async pollLoop(): Promise<void> {
    if (this.stopped || !this.loggedIn || this.polling) return;
    this.polling = true;
    try {
      await this.poll();
    } catch (err) {
      this.ctx.log.warn(`Yeastar TG: Abfrage fehlgeschlagen (${(err as Error).message})`);
    } finally {
      this.polling = false;
    }
    if (!this.stopped && this.loggedIn) this.pollTimer = setTimeout(() => void this.pollLoop(), this.opts.pollMs);
  }

  async poll(): Promise<void> {
    const spans = parseSpans((await this.command('gsm show spans')).output);
    const details = new Map<number, ReturnType<typeof parseSpanDetail>>();
    for (const s of spans) details.set(s.span, parseSpanDetail((await this.command(`gsm show span ${s.span}`)).output));
    const sip = this.opts.sipPort ? await sipOptions(this.opts.host, this.opts.sipPort) : undefined;
    const now = new Date().toISOString();
    this.update((s) => {
      for (const { span, statusText } of spans) {
        const port = spanToPort(span);
        let t = s.trunks.find((x) => x.port === port);
        if (!t) {
          t = emptyTrunk(port, this.opts.trunks.get(port) ?? `GSM ${port}`);
          s.trunks.push(t);
          s.trunks.sort((a, b) => a.port - b.port);
        }
        const d = details.get(span)!;
        Object.assign(t, {
          status: trunkStatus(statusText, d.registration),
          statusText,
          operator: d.operator,
          registration: d.registration,
          roaming: /roaming/i.test(d.registration ?? ''),
          csq: d.csq,
          signalPercent: signalPercent(d.csq),
          rssiDbm: rssiDbm(d.csq),
          ber: d.ber,
          model: d.model,
          imei: d.imei,
          smsc: d.smsc,
        });
      }
      // Ports, die das Gateway nicht mehr meldet
      for (const t of s.trunks) if (!spans.some((x) => spanToPort(x.span) === t.port)) Object.assign(t, { status: 'unknown', statusText: null });
      if (sip !== undefined) s.sip = { ...s.sip, reachable: sip !== null, checkedAt: now };
    });
  }

  // --- Ereignisse ---

  handle(m: AmiMessage): void {
    const f = m.fields;
    if (f.event) {
      this.event(f.event, f);
      return;
    }
    if (f.response !== undefined) {
      const p = this.queue.shift();
      if (p) {
        clearTimeout(p.timer);
        p.resolve(m);
      }
    }
  }

  private event(name: string, f: Record<string, string>): void {
    const now = new Date();
    this.update((s) => void (s.link = { ...s.link!, lastEventAt: now.toISOString() }));
    switch (name.toLowerCase()) {
      case 'receivedsms': {
        const sms = parseReceivedSms(f);
        if (sms) this.receivedSms(sms, now);
        return;
      }
      case 'updatesms':
      case 'updatesmssend': {
        const u = parseSmsUpdate(f);
        const w = u && this.smsWaiters.get(u.id);
        if (u && w) {
          clearTimeout(w.timer);
          this.smsWaiters.delete(u.id);
          w.resolve(u.ok);
        }
        return;
      }
      case 'newchannel':
        this.newChannel(f, now);
        return;
      case 'newstate':
        this.newState(f, now);
        return;
      case 'newcallerid':
        this.updateNumber(f.uniqueid, f.calleridnum);
        return;
      case 'dial':
        if (f.destuniqueid && f.dialstring) this.updateNumber(f.destuniqueid, f.dialstring.split('/').pop());
        return;
      case 'hangup':
        this.hangup(f.uniqueid, now);
        return;
      case 'registry':
        this.update((s) => void (s.sip = { ...s.sip, registration: [f.domain ?? f.username, f.status].filter(Boolean).join(': ') || null }));
        return;
      default:
        if (!this.seenEvents.has(name)) {
          this.seenEvents.add(name);
          this.ctx.log.info(`Yeastar TG: noch nicht ausgewertetes Ereignis ${name}: ${JSON.stringify(f)}`);
        }
    }
  }

  // --- SMS ---

  private receivedSms(sms: ReceivedSms, now: Date): void {
    if (sms.total <= 1) {
      this.bus.sms({ port: spanToPort(sms.span), number: phoneKey(sms.sender), text: sms.text, receivedAt: now.toISOString() });
      return;
    }
    // Mehrteilige SMS: Teile sammeln, nach einer Minute auch unvollständig weitergeben
    const key = `${sms.span}|${sms.sender}|${sms.total}`;
    let entry = this.parts.get(key);
    if (!entry) {
      entry = { parts: new Map(), total: sms.total, span: sms.span, sender: sms.sender, timer: setTimeout(() => this.flushParts(key), 60_000) };
      this.parts.set(key, entry);
    }
    entry.parts.set(sms.index, sms.text);
    if (entry.parts.size >= entry.total) this.flushParts(key);
  }

  private flushParts(key: string): void {
    const e = this.parts.get(key);
    if (!e) return;
    clearTimeout(e.timer);
    this.parts.delete(key);
    const text = [...e.parts].sort(([a], [b]) => a - b).map(([, t]) => t).join('');
    this.bus.sms({ port: spanToPort(e.span), number: phoneKey(e.sender), text, receivedAt: new Date().toISOString() });
  }

  private smsPort(port: number | undefined): number {
    if (port !== undefined) return port;
    if (this.opts.smsPort !== null) return this.opts.smsPort;
    const up = this.state.trunks.find((t) => t.status === 'up');
    if (!up) throw new CommandError('Kein GSM-Trunk verbunden', 503);
    return up.port;
  }

  async sendSms(number: string, text: string, port?: number): Promise<string> {
    const p = this.smsPort(port);
    const id = `elvis${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    const confirmed = new Promise<boolean>((resolve) => {
      this.smsWaiters.set(id, { resolve, timer: setTimeout(() => (this.smsWaiters.delete(id), resolve(false)), this.smsConfirmMs) });
    });
    let res: AmiMessage;
    try {
      res = await this.command(sendSmsCommand(portToSpan(p), number, text, id));
    } catch (err) {
      this.smsWaiters.get(id) && clearTimeout(this.smsWaiters.get(id)!.timer);
      this.smsWaiters.delete(id);
      throw err instanceof CommandError ? err : new CommandError((err as Error).message, 502);
    }
    if (/^error$/i.test(res.fields.response ?? '')) {
      clearTimeout(this.smsWaiters.get(id)?.timer);
      this.smsWaiters.delete(id);
      throw new CommandError(`Gateway lehnt ab: ${res.fields.message ?? 'unbekannter Fehler'}`, 502);
    }
    if (!(await confirmed)) throw new CommandError(`SMS an ${formatPhone(number)} nicht bestätigt`, 502);
    return `SMS an ${formatPhone(number)} über ${this.trunkName(p)} gesendet`;
  }

  private trunkName(port: number | null): string {
    return port === null ? 'Gateway' : (this.state.trunks.find((t) => t.port === port)?.name ?? `GSM ${port}`);
  }

  // --- Gespräche ---

  private newChannel(f: Record<string, string>, now: Date): void {
    const span = channelSpan(f.channel ?? '');
    if (span === null || !f.uniqueid) return;
    // Eingehend: das Gateway legt den GSM-Kanal klingelnd an (Ring = 4); ausgehend entsteht er per Dial (Down = 0)
    const incoming = f.channelstate === '4' || /^ring$/i.test(f.channelstatedesc ?? '');
    const number = incoming ? (f.calleridnum ?? '') : f.exten && f.exten !== 's' ? f.exten : '';
    const call: ActiveCall = {
      id: f.uniqueid,
      direction: incoming ? 'in' : 'out',
      port: spanToPort(span),
      number: cleanNumber(number),
      name: null,
      startedAt: now.toISOString(),
      answeredAt: null,
    };
    this.channels.set(f.uniqueid, { uniqueId: f.uniqueid, call });
    this.syncCalls();
  }

  private newState(f: Record<string, string>, now: Date): void {
    const c = f.uniqueid ? this.channels.get(f.uniqueid) : undefined;
    if (!c) return;
    if (f.channelstate === '6' || /^up$/i.test(f.channelstatedesc ?? '')) c.call.answeredAt ??= now.toISOString();
    if (!c.call.number) c.call.number = cleanNumber(c.call.direction === 'out' ? (f.connectedlinenum ?? '') : (f.calleridnum ?? ''));
    this.syncCalls();
  }

  private updateNumber(uniqueId: string | undefined, number: string | undefined): void {
    const c = uniqueId ? this.channels.get(uniqueId) : undefined;
    const n = cleanNumber(number ?? '');
    if (!c || !n || c.call.number) return;
    c.call.number = n;
    this.syncCalls();
  }

  private hangup(uniqueId: string | undefined, now: Date): void {
    const c = uniqueId ? this.channels.get(uniqueId) : undefined;
    if (!c) return;
    this.channels.delete(c.uniqueId);
    this.bus.call({ ...c.call, number: c.call.number || 'unbekannt', endedAt: now.toISOString() });
    this.syncCalls();
  }

  private endAllCalls(): void {
    const now = new Date().toISOString();
    for (const c of this.channels.values()) this.bus.call({ ...c.call, number: c.call.number || 'unbekannt', endedAt: now });
    this.channels.clear();
    this.syncCalls();
  }

  private syncCalls(): void {
    this.update((s) => {
      s.calls = [...this.channels.values()].map((c) => ({ ...c.call }));
      for (const t of s.trunks) t.busy = s.calls.some((c) => c.port === t.port);
    });
  }
}

/** Rufnummer aus einem Ereignis; „<unknown>“, „anonymous“ usw. ergeben leer */
function cleanNumber(v: string): string {
  const n = v.trim();
  return /^[+\d*#]{2,}$/.test(n) ? phoneKey(n) : '';
}
