import { Socket } from 'node:net';
import type { RadioDevice, RadioState } from '@elvis/shared';
import { BaseAdapter, type AdapterContext, type Command } from '../../adapter.js';
import { activity } from '../../radio/activity.js';
import { LineSplitter, PING, loginLines, parseLine, stripCaller, type ZbeEvent, type ZbeStyle } from './protocol.js';

/** Lebenszeichen an die ZBE */
const PING_MS = 30_000;
/** Drückt jemand die Sprechtaste kurz vor Beginn der Sprache, ist es eigenes Senden */
const PTT_BEFORE_PEAK_MS = 2_000;
const MAX_CALLERS = 200;

export interface ReichertOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  clientNumber: number;
  /** Trennzeichen beim Senden (Anmeldung); empfangen wird beides */
  style: ZbeStyle;
  reconnectMs: number;
}

/**
 * Funkgeräte stehen in der Konfiguration der ZBE (TETRA- und Analogfunk). ELA, DAB und Intercom sind keine Funkgeräte.
 */
export function isRadioLine(kind: string, short: string): boolean {
  return /^(TETRA|ANALOG|DMR)/i.test(kind) && short.toUpperCase() !== 'IC';
}

const deviceId = (port: number) => `anschluss-${port}`;

function radioDevice(port: number, name: string, online: boolean): RadioDevice {
  return {
    id: deviceId(port),
    name,
    type: 'FRT',
    workplace: `Anschluss ${port}`,
    issi: '',
    mode: 'TMO',
    talkgroupId: '',
    rssiDbm: null,
    fmsStatus: null,
    transmitting: false,
    receiving: false,
    online,
    lastActivity: null,
  };
}

/**
 * Funkgeräte an einer Reichert ZBE. ELVIS meldet sich als Client an und wertet die Ereignisse aus
 * (Sprache mit Sprecher, SDS, Status, Positionen). Unbekannte Ereignisse erscheinen als „Ereignis“ in der Timeline und einmalig im Log,
 * damit sich weitere Telegramme an der echten Anlage erkennen lassen. Nur lesend.
 */
export class ReichertZbeAdapter extends BaseAdapter<'radio'> {
  protected readonly commands: Record<string, Command<any>> = {};
  private socket: Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  /** Sprechtaste zuletzt gedrückt je Anschluss (Suffix ab 0) */
  private readonly lastPtt = new Map<number, number>();
  /** Anschlüsse, die laufende Sprache haben (Suffix ab 0) */
  private readonly speaking = new Set<number>();
  /** Anschlüsse, die keine Funkgeräte sind (ELA, DAB, Intercom) */
  private readonly ignoredPorts = new Set<number>();
  /** Beim Lesen der Konfiguration gesehene Anschlüsse */
  private configPorts: Set<number> | null = null;
  /** Funkrufnamen aus den Aufzeichnungsinfos – im SDS-Text stehen sie vor dem eigentlichen Text */
  private readonly callers = new Set<string>();
  private stopped = false;
  private readonly seenEvents = new Set<string>();

  constructor(private readonly opts: ReichertOptions) {
    super('radio', 'reichert-zbe', {
      talkgroups: [],
      devices: [],
      activity: [],
      capabilities: { talkgroupSwitch: false, statusSet: false },
      link: {
        connected: false,
        target: `${opts.host}:${opts.port}`,
        error: null,
        lastTelegramAt: null,
      },
    } satisfies RadioState);
    this.online = false;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    this.connect();
    this.pruneTimer = setInterval(() => {
      const before = this.state.activity.length;
      const pruned = activity.prune(this.state.activity, new Date());
      if (pruned.length !== before) this.update((s) => void (s.activity = pruned));
    }, 30_000);
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = this.pruneTimer = this.pingTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): void {
    const { host, port } = this.opts;
    const socket = new Socket();
    this.socket = socket;
    const lines = new LineSplitter();
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 10_000);
    socket.setNoDelay(true);
    socket.setTimeout(10_000, () => socket.destroy(new Error('Zeitüberschreitung beim Verbindungsaufbau')));
    socket.once('connect', () => {
      socket.setTimeout(0);
      this.ctx.log.info(`Reichert ZBE: verbunden mit ${host}:${port}`);
      for (const l of [...loginLines(this.opts.username, this.opts.password, this.opts.clientNumber, this.opts.style), PING]) socket.write(`${l}\r\n`);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => socket.writable && socket.write(`${PING}\r\n`), PING_MS);
      this.setLink(true, null);
    });
    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) this.handle(line);
    });
    let error: string | null = null;
    socket.on('error', (err) => {
      error = err.message;
    });
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      const msg = error ?? 'Verbindung getrennt';
      this.ctx.log.warn(`Reichert ZBE ${host}:${port}: ${msg} – neuer Versuch in ${Math.round(this.opts.reconnectMs / 1000)} s`);
      this.setLink(false, msg);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.stopped) this.connect();
      }, this.opts.reconnectMs);
    });
    socket.connect(port, host);
  }

  private setLink(connected: boolean, error: string | null): void {
    this.online = connected;
    if (!connected) this.speaking.clear();
    const now = new Date();
    this.update((s) => {
      s.link = { ...s.link!, connected, error };
      for (const d of s.devices) {
        d.online = connected;
        if (!connected) {
          activity.end(s.activity, d.id, now);
          d.transmitting = d.receiving = false;
        }
      }
    });
  }

  /**
   * Gerät zum Anschluss (Telegramm-Suffix ab 0 → Anschluss ab 1). Anschlüsse, die die Konfiguration noch nicht
   * gemeldet hat, werden ergänzt; null für Anschlüsse ohne Funkgerät. Ereignisse ohne Anschluss gehen an das erste Gerät.
   */
  private resolveDevice(s: RadioState, portIndex: number | null): RadioDevice | null {
    if (portIndex === null) return s.devices[0] ?? null;
    if (this.ignoredPorts.has(portIndex)) return null;
    const port = portIndex + 1;
    let d = s.devices.find((x) => x.id === deviceId(port));
    if (!d) {
      d = radioDevice(port, `Anschluss ${port}`, true);
      s.devices.push(d);
      s.devices.sort((x, y) => x.id.localeCompare(y.id, 'de', { numeric: true }));
    }
    return d;
  }

  private applyConfig(ev: Extract<ZbeEvent, { type: 'config' | 'line' }>, iso: string): void {
    if (ev.type === 'config') {
      if (ev.active) this.configPorts = new Set();
      else if (this.configPorts?.size) {
        const keep = this.configPorts;
        this.update((s) => void (s.devices = s.devices.filter((d) => keep.has(Number(d.id.slice('anschluss-'.length)) - 1))));
        this.configPorts = null;
      }
      return;
    }
    this.configPorts?.add(ev.port);
    this.update((s) => {
      s.link = { ...s.link!, lastTelegramAt: iso };
      if (!isRadioLine(ev.kind, ev.short)) {
        this.ignoredPorts.add(ev.port);
        s.devices = s.devices.filter((d) => d.id !== deviceId(ev.port + 1));
        return;
      }
      this.ignoredPorts.delete(ev.port);
      const d = this.resolveDevice(s, ev.port)!;
      d.name = ev.name;
    });
  }

  handle(line: string): void {
    let ev: ZbeEvent | null;
    try {
      ev = parseLine(line);
    } catch (err) {
      this.ctx.log.warn(`Reichert ZBE: Telegramm nicht lesbar (${(err as Error).message}): ${line}`);
      return;
    }
    const now = new Date();
    const iso = now.toISOString();
    if (!ev) {
      this.update((s) => void (s.link = { ...s.link!, lastTelegramAt: iso }));
      return;
    }
    if (ev.type === 'config' || ev.type === 'line') return this.applyConfig(ev, iso);
    if (ev.type === 'rec' && ev.name) {
      this.callers.add(ev.name);
      if (this.callers.size > MAX_CALLERS) this.callers.delete(this.callers.values().next().value!);
    }
    if (ev.type === 'event' && !this.seenEvents.has(ev.name)) {
      this.seenEvents.add(ev.name);
      this.ctx.log.info(`Reichert ZBE: noch nicht ausgewertetes Ereignis ${ev.name}: ${ev.raw}`);
    }
    const key = ev.port ?? -1;
    this.update((s) => {
      s.link = { ...s.link!, lastTelegramAt: iso };
      const d = this.resolveDevice(s, ev.port);
      if (!d) return;
      switch (ev.type) {
        case 'speak':
          // Sprechtaste: läuft die Sprache schon, war es eigenes Senden
          if (!ev.active) break;
          this.lastPtt.set(key, now.getTime());
          if (this.speaking.has(key)) {
            const open = s.activity.find((a) => a.deviceId === d.id && a.end === null && a.kind === 'rx');
            if (open) open.kind = 'tx';
            d.transmitting = true;
            d.receiving = false;
          }
          break;
        case 'peak': {
          if (ev.active) {
            if (this.speaking.has(key)) break;
            this.speaking.add(key);
            const tx = now.getTime() - (this.lastPtt.get(key) ?? 0) < PTT_BEFORE_PEAK_MS;
            activity.begin(s.activity, d.id, tx ? 'tx' : 'rx', now);
            d.transmitting = tx;
            d.receiving = !tx;
            d.lastActivity = iso;
          } else {
            this.speaking.delete(key);
            activity.end(s.activity, d.id, now);
            d.transmitting = d.receiving = false;
          }
          break;
        }
        case 'rec': {
          // Funkrufname des Sprechers, solange gesprochen wird
          const open = ev.name ? s.activity.find((a) => a.deviceId === d.id && a.end === null && a.kind === 'rx') : undefined;
          if (open) open.text = ev.name;
          break;
        }
        case 'sds':
          d.lastActivity = iso;
          activity.point(s.activity, d.id, 'sds', now, ev.from, ev.flash ? `Flash: ${stripCaller(ev.text, this.callers)}` : stripCaller(ev.text, this.callers));
          break;
        case 'status':
          d.lastActivity = iso;
          activity.point(
            s.activity,
            d.id,
            'status',
            now,
            ev.from,
            ev.status !== null ? `Status ${ev.status}` : `Status 0x${ev.code.toString(16).toUpperCase()}`,
          );
          break;
        case 'gps':
          d.lastActivity = iso;
          activity.point(s.activity, d.id, 'gps', now, ev.from, `${ev.lat.toFixed(5)}, ${ev.lon.toFixed(5)}`);
          break;
        case 'event':
          d.lastActivity = iso;
          activity.point(s.activity, d.id, 'event', now, ev.from, ev.name);
          break;
      }
      s.activity = activity.prune(s.activity, now);
    });
  }
}
