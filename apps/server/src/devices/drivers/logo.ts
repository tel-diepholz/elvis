import { EMPTY_LOGO_CONFIG, decodeLogoRange, logoBitAddress, logoReadRanges, parseLogoSignalId, type LogoConfig, type LogoState } from '@elvis/shared';
import { z } from 'zod';
import { BaseAdapter, CommandError, command, noParams, type AdapterContext } from '../adapter.js';
import type { LogoClient, LogoClientFactory, LogoConnection } from '../logo/client.js';

/** Bezeichnungen, Regeln und Verknüpfungen aus der Datenbank */
export interface LogoSource {
  get(): LogoConfig;
  onChange(listener: () => void): () => void;
}

export interface LogoOptions extends Omit<LogoConnection, 'timeoutMs'> {
  pollMs: number;
  /** Dauer des Taster-Impulses auf dem Netzwerk-Eingang */
  pulseMs: number;
}

/** Erst nach so vielen Fehlversuchen in Folge gilt die LOGO als nicht erreichbar */
const FAILURES_UNTIL_DOWN = 2;

const pulseParams = z.object({ signal: z.string() });

/**
 * Siemens LOGO! 8 per S7: liest den Speicher der LOGO und stellt Ein-/Ausgänge, Merker und Netzwerksignale mit den
 * vergebenen Bezeichnungen bereit. Die Meldungen aus den Regeln entstehen in alerts.ts. Über „pulse“ drückt ELVIS einen
 * verknüpften Taster: das Netzwerk-Eingang-Bit geht kurz auf 1 und wieder auf 0.
 */
export class LogoAdapter extends BaseAdapter<'logo'> {
  private client: LogoClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private polling = false;
  private again = false;
  private stopped = false;
  private failures = 0;
  private readonly pulsing = new Set<string>();

  protected readonly commands = {
    refresh: command(noParams, async () => {
      await this.poll();
    }),
    pulse: command(pulseParams, async ({ signal }) => {
      await this.pulse(signal);
      return 'Taster ausgelöst';
    }),
  };

  constructor(
    driver: string,
    private readonly source: LogoSource,
    private readonly factory: LogoClientFactory,
    private readonly opts: LogoOptions,
  ) {
    super('logo', driver, { ...EMPTY_LOGO_CONFIG, connected: false, error: null, updatedAt: null, values: {} } satisfies LogoState);
  }

  isQuiet(action: string): boolean {
    return action === 'refresh';
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    this.state = { ...this.state, ...this.source.get() };
    this.unsubscribe = this.source.onChange(() => this.update((s) => void Object.assign(s, this.source.get())));
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
    this.timer.unref();
    // Erste Abfrage im Hintergrund: eine nicht erreichbare LOGO soll den Start nicht aufhalten
    void this.poll();
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    await this.disconnect();
  }

  private async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => {});
  }

  private async connected(): Promise<LogoClient> {
    if (!this.client) {
      const c = this.factory({ host: this.opts.host, port: this.opts.port, localTsap: this.opts.localTsap, remoteTsap: this.opts.remoteTsap, timeoutMs: 5000 });
      await c.connect();
      this.client = c;
    }
    return this.client;
  }

  /** Alle Bereiche lesen; kommt während eines Laufs eine Anforderung, folgt direkt danach ein weiterer Lauf */
  async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.polling) {
      this.again = true;
      return;
    }
    this.polling = true;
    try {
      do {
        this.again = false;
        await this.pollOnce();
      } while (this.again && !this.stopped);
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const ranges = logoReadRanges();
    try {
      const client = await this.connected();
      const chunks = await client.readBytes(ranges);
      if (this.stopped) return;
      const values: Record<string, number> = {};
      ranges.forEach((r, i) => Object.assign(values, decodeLogoRange(r.kind, chunks[i]!)));
      this.failures = 0;
      this.setOnline(true);
      const changed = JSON.stringify(values) !== JSON.stringify(this.state.values) || !this.state.connected || this.state.error;
      if (changed) this.update((s) => void Object.assign(s, { connected: true, error: null, values, updatedAt: new Date().toISOString() }));
      else this.state = { ...this.state, updatedAt: new Date().toISOString() };
    } catch (err) {
      if (this.stopped) return;
      await this.disconnect();
      this.failures++;
      const message = (err as Error).message;
      if (this.failures >= FAILURES_UNTIL_DOWN) {
        this.setOnline(false);
        // Veraltete Werte würden Regeln weiter auslösen: bei Ausfall zurücksetzen
        this.update((s) => void Object.assign(s, { connected: false, error: message, values: {} }));
      }
    }
  }

  /** Taster drücken: Netzwerk-Eingang einer Verknüpfung kurz auf 1, dann wieder auf 0 */
  private async pulse(signal: string): Promise<void> {
    const p = parseLogoSignalId(signal);
    if (!p || p.kind !== 'NI') throw new CommandError('Ein Taster muss ein Netzwerk-Eingang (NI) sein', 400);
    if (!this.source.get().links.some((l) => l.button === signal)) throw new CommandError(`${signal} gehört zu keiner Verknüpfung`, 400);
    if (!this.state.connected) throw new CommandError('LOGO nicht erreichbar');
    if (this.pulsing.has(signal)) throw new CommandError(`${signal} wird gerade geschaltet`);
    this.pulsing.add(signal);
    const { byte, bit } = logoBitAddress(p.kind, p.n);
    try {
      const client = await this.connected();
      await client.writeBit(byte, bit, true);
      await new Promise((r) => setTimeout(r, this.opts.pulseMs));
    } catch (err) {
      throw new CommandError(`Schalten fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      // Der Taster darf nie auf 1 hängen bleiben, auch wenn das Warten abbricht
      try {
        await (await this.connected()).writeBit(byte, bit, false);
      } catch (err) {
        this.ctx?.log.error(`LOGO: ${signal} konnte nicht zurückgesetzt werden: ${(err as Error).message}`);
      }
      this.pulsing.delete(signal);
    }
    void this.poll();
  }
}
