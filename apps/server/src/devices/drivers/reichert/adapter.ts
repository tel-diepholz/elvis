import { Socket } from 'node:net';
import type { RadioDevice, RadioState, RadioType } from '@elvis/shared';
import { BaseAdapter, type AdapterContext, type Command } from '../../adapter.js';
import { activity } from '../../radio/activity.js';
import { LineSplitter, loginLines, parseLine, type ZbeEvent } from './protocol.js';

export interface ZbeRadio {
  fug: number;
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
  radios: ZbeRadio[];
  reconnectMs: number;
}

/** Eintrag je Funkgerät: „Nummer:Typ:Name[:ISSI]“, mehrere durch Semikolon getrennt */
export const RADIOS_PATTERN =
  '^\\s*(\\d{1,3}\\s*:\\s*(MRT|FRT|HRT)\\s*:[^:;]+(:\\s*\\d{1,8}\\s*)?)?(\\s*;\\s*\\d{1,3}\\s*:\\s*(MRT|FRT|HRT)\\s*:[^:;]+(:\\s*\\d{1,8}\\s*)?)*\\s*;?\\s*$';

export function parseRadios(spec: string): ZbeRadio[] {
  const radios: ZbeRadio[] = [];
  for (const part of spec.split(';')) {
    const [fug, type, name, issi] = part.split(':').map((s) => s.trim());
    if (!fug || !type || !name) continue;
    if (!/^\d+$/.test(fug) || !['MRT', 'FRT', 'HRT'].includes(type)) throw new Error(`Funkgerät „${part.trim()}“: erwartet Nummer:Typ:Name[:ISSI]`);
    if (radios.some((r) => r.fug === Number(fug))) throw new Error(`Funkgerät ${fug} ist doppelt eingetragen`);
    radios.push({
      fug: Number(fug),
      type: type as RadioType,
      name,
      issi: issi ?? '',
    });
  }
  return radios;
}

const deviceId = (fug: number) => `fug-${fug}`;

function radioDevice(r: ZbeRadio, online: boolean): RadioDevice {
  return {
    id: deviceId(r.fug),
    name: r.name,
    type: r.type,
    workplace: `FuG ${r.fug}`,
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
 * (SDS, Status, Positionen). Unbekannte Ereignisse erscheinen als „Ereignis“ in der Timeline und einmalig im Log,
 * damit sich weitere Telegramme an der echten Anlage erkennen lassen. Nur lesend.
 */
export class ReichertZbeAdapter extends BaseAdapter<'radio'> {
  protected readonly commands: Record<string, Command<any>> = {};
  private socket: Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
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
    this.reconnectTimer = this.pruneTimer = null;
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
      for (const l of loginLines(this.opts.username, this.opts.password, this.opts.clientNumber)) socket.write(`${l}\r\n`);
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

  /** Gerät zur FuG-Nummer; unbekannte Nummern werden ergänzt, Ereignisse ohne Nummer gehen an das erste Gerät. */
  private resolveDevice(s: RadioState, fug: number | null): RadioDevice {
    if (fug === null) {
      if (s.devices[0]) return s.devices[0];
      fug = 0;
    }
    let d = s.devices.find((x) => x.id === deviceId(fug));
    if (!d) {
      d = radioDevice({ fug, type: 'FRT', name: `FuG ${fug}`, issi: '' }, true);
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
    if (ev.type === 'event' && !this.seenEvents.has(ev.name)) {
      this.seenEvents.add(ev.name);
      this.ctx.log.info(`Reichert ZBE: noch nicht ausgewertetes Ereignis ${ev.name}: ${ev.raw}`);
    }
    this.update((s) => {
      s.link = { ...s.link!, lastTelegramAt: iso };
      const d = this.resolveDevice(s, ev.fug);
      d.lastActivity = iso;
      switch (ev.type) {
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
