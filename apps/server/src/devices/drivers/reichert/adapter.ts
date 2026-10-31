import { Socket } from 'node:net';
import type { RadioDevice, RadioState, RadioType } from '@elvis/shared';
import { BaseAdapter, type AdapterContext, type Command } from '../../adapter.js';
import { activity } from '../../radio/activity.js';
import { LineSplitter, MAX_PORTS, PING, loginLines, parseLine, type ZbeEvent, type ZbeStyle } from './protocol.js';

/** Sprecher aus der Aufzeichnungsinfo gilt so lange für das nächste SPEAK */
const SPEAKER_VALID_MS = 10_000;
/** Kommt die Aufzeichnungsinfo kurz nach SPEAK, wird der Sprecher nachgetragen */
const SPEAKER_LATE_MS = 3_000;
/** Lebenszeichen an die ZBE */
const PING_MS = 30_000;

export interface ZbeRadio {
  /** Anschluss an der ZBE wie in deren Einstellungen (1–20); im Telegramm ab 0 gezählt */
  port: number;
  type: RadioType;
  name: string;
  issi: string;
}

export interface ReichertOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  clientNumber: number;
  /** Trennzeichen beim Senden (Anmeldung); empfangen wird beides */
  style: ZbeStyle;
  radios: ZbeRadio[];
  reconnectMs: number;
}

/** Eintrag je Funkgerät: „Anschluss:Typ:Name[:ISSI]“, mehrere durch Semikolon getrennt */
export const RADIOS_PATTERN =
  '^\\s*(\\d{1,3}\\s*:\\s*(MRT|FRT|HRT)\\s*:[^:;]+(:\\s*\\d{1,8}\\s*)?)?(\\s*;\\s*\\d{1,3}\\s*:\\s*(MRT|FRT|HRT)\\s*:[^:;]+(:\\s*\\d{1,8}\\s*)?)*\\s*;?\\s*$';

export function parseRadios(spec: string): ZbeRadio[] {
  const radios: ZbeRadio[] = [];
  for (const part of spec.split(';')) {
    const [port, type, name, issi] = part.split(':').map((s) => s.trim());
    if (!port || !type || !name) continue;
    if (!/^\d+$/.test(port) || !['MRT', 'FRT', 'HRT'].includes(type)) throw new Error(`Funkgerät „${part.trim()}“: erwartet Anschluss:Typ:Name[:ISSI]`);
    if (Number(port) < 1 || Number(port) > MAX_PORTS) throw new Error(`Anschluss ${port}: die ZBE hat die Anschlüsse 1 bis ${MAX_PORTS}`);
    if (radios.some((r) => r.port === Number(port))) throw new Error(`Anschluss ${port} ist doppelt eingetragen`);
    radios.push({
      port: Number(port),
      type: type as RadioType,
      name,
      issi: issi ?? '',
    });
  }
  return radios;
}

const deviceId = (port: number) => `anschluss-${port}`;

function radioDevice(r: ZbeRadio, online: boolean): RadioDevice {
  return {
    id: deviceId(r.port),
    name: r.name,
    type: r.type,
    workplace: `Anschluss ${r.port}`,
    issi: r.issi,
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
  /** Zuletzt gemeldeter Sprecher je Anschluss (Aufzeichnungsinfo), bis zum nächsten SPEAK */
  private readonly speakers = new Map<number, { issi: string | null; at: number }>();
  /** Letztes SPEAK je Anschluss – für einen nachträglich gemeldeten Sprecher */
  private readonly lastSpeak = new Map<number, { activityId: string; at: number }>();
  private stopped = false;
  private readonly seenEvents = new Set<string>();

  constructor(private readonly opts: ReichertOptions) {
    super('radio', 'reichert-zbe', {
      talkgroups: [],
      devices: opts.radios.map((r) => radioDevice(r, false)),
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
    const now = new Date();
    this.update((s) => {
      s.link = { ...s.link!, connected, error };
      for (const d of s.devices) {
        d.online = connected;
        if (!connected) activity.end(s.activity, d.id, now);
      }
    });
  }

  /**
   * Gerät zum Anschluss (Telegramm-Suffix ab 0 → Anschluss ab 1). Nicht eingetragene Anschlüsse werden ergänzt,
   * Ereignisse ohne Anschluss gehen an das erste Gerät.
   */
  private resolveDevice(s: RadioState, portIndex: number | null): RadioDevice {
    if (portIndex === null && s.devices[0]) return s.devices[0];
    const port = (portIndex ?? 0) + 1;
    let d = s.devices.find((x) => x.id === deviceId(port));
    if (!d) {
      d = radioDevice({ port, type: 'FRT', name: `Anschluss ${port}`, issi: '' }, true);
      s.devices.push(d);
    }
    return d;
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
    const key = ev.port ?? -1;
    if (ev.type === 'speaker') {
      // Sprecher merken; kam SPEAK gerade eben ohne Sprecher, dort nachtragen
      const late = this.lastSpeak.get(key);
      if (ev.speaker && late && now.getTime() - late.at < SPEAKER_LATE_MS) {
        this.lastSpeak.delete(key);
        this.update((s) => {
          s.link = { ...s.link!, lastTelegramAt: iso };
          const a = s.activity.find((x) => x.id === late.activityId);
          if (a && !a.peer) a.peer = ev.speaker;
        });
      } else {
        this.speakers.set(key, { issi: ev.speaker, at: now.getTime() });
        this.update((s) => void (s.link = { ...s.link!, lastTelegramAt: iso }));
      }
      return;
    }
    if (ev.type === 'event' && !this.seenEvents.has(ev.name)) {
      this.seenEvents.add(ev.name);
      this.ctx.log.info(`Reichert ZBE: noch nicht ausgewertetes Ereignis ${ev.name}: ${ev.raw}`);
    }
    this.update((s) => {
      s.link = { ...s.link!, lastTelegramAt: iso };
      const d = this.resolveDevice(s, ev.port);
      d.lastActivity = iso;
      switch (ev.type) {
        case 'speak': {
          const sp = this.speakers.get(key);
          this.speakers.delete(key);
          const speaker = sp && now.getTime() - sp.at < SPEAKER_VALID_MS ? sp.issi : null;
          activity.point(s.activity, d.id, 'rx', now, speaker);
          this.lastSpeak.set(key, { activityId: s.activity[s.activity.length - 1]!.id, at: now.getTime() });
          break;
        }
        case 'sds':
          activity.point(s.activity, d.id, 'sds', now, ev.from, ev.flash ? `Flash: ${ev.text}` : ev.text);
          break;
        case 'status':
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
          activity.point(s.activity, d.id, 'gps', now, ev.from, `${ev.lat.toFixed(5)}, ${ev.lon.toFixed(5)}`);
          break;
        case 'event':
          activity.point(s.activity, d.id, 'event', now, ev.from, ev.name);
          break;
      }
      s.activity = activity.prune(s.activity, now);
    });
  }
}
