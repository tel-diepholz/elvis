import WebSocket from 'ws';
import type { MessagingConnection, MessagingSocketServerMessage } from '@elvis/shared';

/** Minimaler WebSocket-Vertrag (für Tests austauschbar) */
export interface SocketLike {
  on(event: 'open', fn: () => void): void;
  on(event: 'message', fn: (data: WebSocket.RawData) => void): void;
  on(event: 'close', fn: (code: number) => void): void;
  on(event: 'error', fn: (e: Error) => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers, handshakeTimeout: 15_000 });

export interface PushSocketOptions {
  /** Adresse und Kopfzeilen (Token, Signatur) – je Verbindungsversuch neu, weil die Signatur nur einmal gilt */
  connect: () => Promise<{ url: string; headers: Record<string, string> }>;
  /** Neue Ereignisse beim Relay: abholen */
  onEvent: () => void;
  onState: (c: MessagingConnection, error: string | null) => void;
  factory?: SocketFactory;
  /** Keepalive; ohne Antwort nach zwei Intervallen gilt die Verbindung als tot */
  pingMs?: number;
  /** Ab so vielen Fehlversuchen in Folge meldet die Verbindung „polling“ (Abruf übernimmt) */
  pollAfterFailures?: number;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Dauerhafte, ausgehende WebSocket-Verbindung zum Relay (Push statt Abruf). Bricht sie ab, verbindet sie sich mit
 * wachsender Pause (1 s … 60 s) neu und stößt danach einen Abruf an, damit nichts aus der Pause verloren geht.
 */
export class PushSocket {
  private ws: SocketLike | null = null;
  private stopped = true;
  private failures = 0;
  private retry: NodeJS.Timeout | null = null;
  private ping: NodeJS.Timeout | null = null;
  private lastPong = 0;

  constructor(private readonly opts: PushSocketOptions) {}

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    this.retry = this.ping = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* schon zu */
    }
    this.opts.onState('disabled', null);
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    this.opts.onState(this.failures >= (this.opts.pollAfterFailures ?? 3) ? 'polling' : 'connecting', null);
    let target: { url: string; headers: Record<string, string> };
    try {
      target = await this.opts.connect();
    } catch (e) {
      this.failed(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.stopped) return;
    const ws = (this.opts.factory ?? defaultSocketFactory)(target.url, target.headers);
    this.ws = ws;
    let opened = false;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      opened = true;
      this.failures = 0;
      this.lastPong = Date.now();
      this.opts.onState('connected', null);
      const every = this.opts.pingMs ?? 30_000;
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (Date.now() - this.lastPong > 2 * every + 5_000) return ws.terminate();
        try {
          ws.send('ping');
        } catch {
          ws.terminate();
        }
      }, every);
      // Was während der Pause angefallen ist
      this.opts.onEvent();
    });
    ws.on('message', (data) => {
      const text = data.toString();
      this.lastPong = Date.now();
      if (text === 'pong') return;
      try {
        const msg = JSON.parse(text) as MessagingSocketServerMessage;
        if (msg.type === 'event') this.opts.onEvent();
      } catch {
        /* unbekannt */
      }
    });
    let lastError: string | null = null;
    ws.on('error', (e) => {
      lastError = e.message;
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      if (this.stopped) return;
      this.failed(lastError ?? (opened ? `Verbindung getrennt (${code})` : `Verbindung abgelehnt (${code})`));
    });
  }

  private failed(error: string): void {
    if (this.stopped) return;
    this.failures++;
    this.opts.onState(this.failures >= (this.opts.pollAfterFailures ?? 3) ? 'polling' : 'connecting', error);
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures - 1, 6));
    this.retry = setTimeout(() => void this.open(), delay);
  }
}
