import { Socket } from 'node:net';
import { z } from 'zod';
import { INVERTER_MODE_LABELS, type InverterBusDevice, type InverterMode, type InverterPhase, type InverterState } from '@elvis/shared';
import { BaseAdapter, CommandError, command, noParams, type AdapterContext, type Command } from '../../adapter.js';
import { openSerialPort } from '../airmar.js';
import {
  BAUD_RATE,
  CMD,
  DEFAULT_RAM_INFO,
  INFO,
  MkDecoder,
  RAM,
  RESPONSE_TIMEOUT_MS,
  WM,
  WM_REPLY,
  deviceState,
  firmwareString,
  infoRequest,
  isMk,
  ledRequest,
  parseAddress,
  parseInfo,
  parseLeds,
  parseMasterMultiLed,
  parseVersion,
  parseWinmon,
  periodToHz,
  ramScale,
  ramValue,
  resetInterface,
  setAddress,
  setState,
  toInt16,
  versionRequest,
  winmon,
  type AcInfo,
  type DcInfo,
  type MkFrame,
  type RamInfo,
} from './protocol.js';

/** Byte-Verbindung zum MK3: TCP (Router mit Serial over IP), serielle Schnittstelle oder Emulator */
export interface ByteLink {
  on(event: 'data', l: (chunk: Buffer) => void): unknown;
  on(event: 'close' | 'error', l: (err?: Error) => void): unknown;
  write(data: Buffer): void;
  close(): void;
}

export type LinkOpener = () => Promise<ByteLink>;

export function tcpOpener(host: string, port: number, timeoutMs = 10_000): LinkOpener {
  return () =>
    new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);
      const fail = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(timeoutMs, () => fail(new Error('Zeitüberschreitung beim Verbindungsaufbau')));
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.off('error', fail);
        resolve({
          on: (event: 'data' | 'close' | 'error', l: (arg?: any) => void) => (event === 'close' ? socket.on('close', () => l()) : socket.on(event, l)),
          write: (data) => void (socket.writable && socket.write(data)),
          close: () => socket.destroy(),
        });
      });
      socket.connect(port, host);
    });
}

export const serialOpener =
  (path: string): LinkOpener =>
  () =>
    openSerialPort(path, BAUD_RATE);

export interface VebusOptions {
  /** Treiber-ID („victron-vebus“ oder „sim“) */
  driver: string;
  /** Anzeige: host:port bzw. Schnittstelle */
  target: string;
  open: LinkOpener;
  pollMs: number;
  reconnectMs: number;
  /** MK3 wiederholt die Betriebsart alle ½ s (wie ein Digital Multi Control) */
  repeatPanelState: boolean;
  timeoutMs?: number;
}

/** Ohne Frames so lange gilt die Verbindung als tot und wird neu aufgebaut */
const STALE_MS = 15_000;
/** So lange braucht das MK3 nach einem Reset */
const RESET_WAIT_MS = 2_000;
const RAM_IDS = [RAM.uMains, RAM.iMains, RAM.uInverter, RAM.iInverter, RAM.uBat, RAM.iBat, RAM.inverterPeriod, RAM.mainsPeriod, RAM.outputPower];
const PHASES = ['L1', 'L2', 'L3', 'L4'] as const;
/** Darunter liegt keine Wechselspannung an (Frequenz wird nicht angezeigt) */
const MIN_AC_V = 50;

const round = (v: number | null, d: number) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const winmonMatch = (code: number) => (f: MkFrame) => !!parseWinmon(f)?.some((r) => r.code === code || r.code === WM_REPLY.unknown);
const winmonValue = (f: MkFrame | null, code: number) => (f ? (parseWinmon(f)?.find((r) => r.code === code) ?? null) : null);

class LinkLost extends Error {}

function initialState(target: string): InverterState {
  return {
    link: { connected: false, target, error: null, lastFrameAt: null, interfaceVersion: null },
    devices: [],
    scanning: false,
    lastScanAt: null,
    mode: null,
    opState: null,
    shoreLimitA: null,
    shoreLimitMinA: null,
    shoreLimitMaxA: null,
    remotePanel: null,
    phases: [],
    acOutHz: null,
    outputW: null,
    dc: { v: null, a: null },
    leds: null,
  };
}

/**
 * Victron MultiPlus/Quattro am VE.Bus über ein MK3-USB-Interface (MK2-Protokoll). Das Interface hängt direkt am
 * Server oder an einem Router, der die Schnittstelle als TCP-Port bereitstellt (z. B. Teltonika „Serial over IP“).
 * Erkennt die Geräte am Bus, liest Messwerte und schaltet wie ein Digital Multi Control (Betriebsart, Landstrom-Begrenzung).
 */
export class VictronVebusAdapter extends BaseAdapter<'inverter'> {
  protected readonly commands: Record<string, Command<any>> = {
    'mode.set': command(z.object({ mode: z.enum(['on', 'off', 'charger-only', 'inverter-only']) }), ({ mode }) => this.setMode(mode)),
    'shore.limit': command(z.object({ amps: z.number().min(0).max(200) }), ({ amps }) => this.setShoreLimit(amps)),
    'bus.scan': command(noParams, () => this.rescan()),
  };

  private link: ByteLink | null = null;
  private decoder = new MkDecoder();
  private pending: { match: (f: MkFrame) => boolean; resolve: (f: MkFrame | null) => void } | null = null;
  private jobs: Promise<unknown> = Promise.resolve();
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private wake: (() => void) | null = null;
  private lastFrame = 0;
  private lastReset = 0;
  private ram: Record<number, RamInfo | null> = {};
  private master: number | null = null;
  /** Zuletzt von ELVIS gesetzte Betriebsart – falls das Gerät sein Schalterregister nicht meldet */
  private commandedMode: InverterMode | null = null;

  constructor(private readonly opts: VebusOptions) {
    super('inverter', opts.driver, initialState(opts.target));
    this.online = false;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    void this.connect();
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.wake?.();
    this.pending?.resolve(null);
    const link = this.link;
    this.link = null;
    link?.close();
  }

  // --- Verbindung ---

  private async connect(): Promise<void> {
    let link: ByteLink;
    try {
      link = await this.opts.open();
    } catch (err) {
      this.lost(`Verbindung zu ${this.opts.target} fehlgeschlagen: ${(err as Error).message}`);
      return;
    }
    if (this.stopped) return link.close();
    this.link = link;
    this.decoder = new MkDecoder();
    this.lastFrame = Date.now();
    let error: string | null = null;
    link.on('data', (chunk) => {
      if (this.link === link) for (const f of this.decoder.push(chunk)) this.onFrame(f);
    });
    link.on('error', (err) => {
      error = err?.message ?? 'Fehler';
    });
    link.on('close', () => {
      if (this.link !== link) return;
      this.link = null;
      this.pending?.resolve(null);
      this.lost(error ?? 'Verbindung getrennt');
    });
    void this.session(link);
  }

  private lost(msg: string): void {
    this.setOnline(false);
    this.update((s) => {
      s.link = { ...s.link, connected: false, error: msg };
      s.scanning = false;
    });
    if (this.stopped) return;
    this.ctx.log.warn(`VE.Bus ${this.opts.target}: ${msg} – neuer Versuch in ${Math.round(this.opts.reconnectMs / 1000)} s`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && !this.link) void this.connect();
    }, this.opts.reconnectMs);
  }

  /** Ablauf je Verbindung: MK3 prüfen, Bus scannen, Skalierung lesen, dann zyklisch abfragen */
  private async session(link: ByteLink): Promise<void> {
    try {
      const version = await this.job(() => this.hello());
      this.ctx.log.info(`VE.Bus ${this.opts.target}: MK3 ${version} verbunden`);
      this.setOnline(true);
      this.update((s) => void (s.link = { ...s.link, connected: true, error: null, interfaceVersion: version }));
      await this.job(() => this.scan());
      await this.job(() => this.loadRamInfo());
      while (this.link === link && !this.stopped) {
        await this.job(() => this.poll());
        if (Date.now() - this.lastFrame > STALE_MS) throw new Error('Keine Daten mehr vom MK3');
        await this.sleep(this.opts.pollMs);
      }
    } catch (err) {
      if (this.link !== link || this.stopped) return;
      const msg = err instanceof LinkLost ? 'Verbindung getrennt' : (err as Error).message;
      this.update((s) => void (s.link = { ...s.link, error: msg }));
      this.ctx.log.warn(`VE.Bus ${this.opts.target}: ${msg}`);
      link.close();
    }
  }

  /** Abfragen, Scan und Befehle nacheinander – sonst verstellt z. B. der Scan die Adresse mitten in der Abfrage */
  private job<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.jobs.then(fn, fn);
    this.jobs = run.catch(() => {});
    return run;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.wake = null;
        resolve();
      }, ms);
      this.timers.add(t);
      this.wake = () => {
        clearTimeout(t);
        this.timers.delete(t);
        this.wake = null;
        resolve();
      };
    });
  }

  private onFrame(f: MkFrame): void {
    this.lastFrame = Date.now();
    if (this.pending?.match(f)) return this.pending.resolve(f);
    // Spontane Versionsframes: spricht das MK3 nicht VE.Bus (lief vor dem Wechselrichter an), zurücksetzen
    const v = parseVersion(f);
    if (v?.mode9bit && Date.now() - this.lastReset > 10_000) {
      this.lastReset = Date.now();
      this.ctx.log.warn(`VE.Bus ${this.opts.target}: MK3 nicht im VE.Bus-Modus – setze es zurück`);
      this.link?.write(resetInterface());
    }
  }

  private request(frame: Buffer, match: (f: MkFrame) => boolean, timeoutMs = this.opts.timeoutMs ?? RESPONSE_TIMEOUT_MS): Promise<MkFrame | null> {
    const link = this.link;
    if (!link) return Promise.reject(new LinkLost());
    return new Promise((resolve) => {
      const t = setTimeout(() => done(null), timeoutMs);
      this.timers.add(t);
      const done = (f: MkFrame | null) => {
        clearTimeout(t);
        this.timers.delete(t);
        if (this.pending?.resolve === done) this.pending = null;
        resolve(f);
      };
      this.pending = { match, resolve: done };
      link.write(frame);
    }).then((f) => {
      if (!f && this.link !== link) throw new LinkLost();
      return f as MkFrame | null;
    });
  }

  private async hello(): Promise<string> {
    let v = await this.request(versionRequest(), (f) => !!parseVersion(f));
    if (v && parseVersion(v)!.mode9bit) {
      this.lastReset = Date.now();
      this.link?.write(resetInterface());
      await this.sleep(RESET_WAIT_MS);
      v = await this.request(versionRequest(), (f) => !!parseVersion(f));
    }
    if (!v) throw new Error('Keine Antwort vom MK3 – ist das Interface angeschlossen und die Schnittstelle auf 2400 Baud eingestellt?');
    const version = parseVersion(v)!;
    if (version.mode9bit) throw new Error('MK3 erkennt keinen VE.Bus – ist der Wechselrichter eingeschaltet?');
    return firmwareString(version.version);
  }

  // --- Bus-Scan ---

  private async selectAddress(address: number): Promise<void> {
    const r = await this.request(setAddress(address), (f) => parseAddress(f) !== null);
    if (!r) throw new Error('MK3 antwortet nicht auf die Adresswahl');
  }

  /** Adressen 0–31 durchprobieren; nach drei leeren Adressen in Folge ist Schluss (Kap. 7.2) */
  private async scan(): Promise<void> {
    this.update((s) => void (s.scanning = true));
    const found: InverterBusDevice[] = [];
    let misses = 0;
    try {
      for (let address = 0; address <= 0x1f && misses < 3; address++) {
        await this.selectAddress(address);
        const v0 = await this.request(winmon(WM.softwareVersion0), winmonMatch(WM_REPLY.softwareVersion0));
        if (!v0) {
          misses++;
          continue;
        }
        misses = 0;
        const v1 = await this.request(winmon(WM.softwareVersion1), winmonMatch(WM_REPLY.softwareVersion1));
        const st = await this.request(winmon(WM.deviceState), winmonMatch(WM_REPLY.deviceState));
        const lo = winmonValue(v0, WM_REPLY.softwareVersion0);
        const hi = winmonValue(v1, WM_REPLY.softwareVersion1);
        const state = winmonValue(st, WM_REPLY.deviceState);
        found.push({
          address,
          role: state?.info0 === 3 ? 'slave' : 'master',
          firmware: lo && hi ? firmwareString((hi.value * 0x10000 + lo.value) >>> 0) : null,
        });
      }
      this.master = (found.find((d) => d.role === 'master') ?? found[0])?.address ?? null;
      if (this.master !== null) await this.selectAddress(this.master);
    } finally {
      this.update((s) => {
        s.scanning = false;
        s.devices = found;
        s.lastScanAt = new Date().toISOString();
        s.link = { ...s.link, error: found.length ? null : 'Kein Gerät am VE.Bus gefunden' };
      });
    }
    this.ctx.log.info(`VE.Bus ${this.opts.target}: ${found.length ? found.map((d) => `Adresse ${d.address} (${d.role}, Firmware ${d.firmware ?? '?'})`).join(', ') : 'kein Gerät gefunden'}`);
  }

  private async rescan(): Promise<string> {
    if (!this.link || !this.state.link.connected) throw new CommandError('Keine Verbindung zum MK3');
    await this.job(async () => {
      await this.scan();
      await this.loadRamInfo();
    });
    const n = this.state.devices.length;
    return n ? `${n} ${n === 1 ? 'Gerät' : 'Geräte'} am VE.Bus gefunden` : 'Kein Gerät am VE.Bus gefunden';
  }

  /** Skalierung der Messwerte vom Master lesen (CommandGetRAMVarInfo) */
  private async loadRamInfo(): Promise<void> {
    if (this.master === null) return;
    for (const id of RAM_IDS) {
      const r = await this.request(winmon(WM.ramVarInfo, id, 0), winmonMatch(WM_REPLY.ramInfoScale));
      const sc = winmonValue(r, WM_REPLY.ramInfoScale);
      if (!sc) continue;
      const offset = winmonValue(r, WM_REPLY.ramInfoOffset);
      this.ram[id] = toInt16(sc.value) === 0 ? null : { sc: toInt16(sc.value), offset: offset ? toInt16(offset.value) : 0 };
    }
  }

  private info(id: number): RamInfo {
    return this.ram[id] ?? DEFAULT_RAM_INFO[id]!;
  }

  // --- Abfrage ---

  private async poll(): Promise<void> {
    const dcFrame = await this.request(infoRequest(INFO.dc), (f) => parseInfo(f)?.kind === 'dc');
    const acFrames: AcInfo[] = [];
    const l1 = await this.request(infoRequest(INFO.acL1), (f) => isPhase(f, 1));
    if (l1) acFrames.push(parseInfo(l1) as AcInfo);
    const phases = acFrames[0]?.phases ?? 1;
    for (let p = 2; p <= phases; p++) {
      const f = await this.request(infoRequest(p), (x) => isPhase(x, p));
      if (f) acFrames.push(parseInfo(f) as AcInfo);
    }
    const mml = await this.request(infoRequest(INFO.masterMultiLed), (f) => !!parseMasterMultiLed(f));
    const led = await this.request(ledRequest(), (f) => isMk(f, CMD.led));
    const st = this.master !== null ? await this.request(winmon(WM.deviceState), winmonMatch(WM_REPLY.deviceState)) : null;
    const power =
      this.master !== null && this.state.devices.length === 1 && this.ram[RAM.outputPower]
        ? await this.request(winmon(WM.readRamVar, RAM.outputPower, 0), winmonMatch(WM_REPLY.ramRead))
        : null;

    const dc = dcFrame ? (parseInfo(dcFrame) as DcInfo) : null;
    const multi = mml ? parseMasterMultiLed(mml) : null;
    const state = winmonValue(st, WM_REPLY.deviceState);
    const pw = winmonValue(power, WM_REPLY.ramRead);
    const noDevice = !dc && !l1;
    const iBat = ramScale(this.info(RAM.iBat));

    this.update((s) => {
      s.link = {
        ...s.link,
        lastFrameAt: new Date(this.lastFrame).toISOString(),
        error: noDevice ? 'Keine Antwort vom Wechselrichter – MK3 erreichbar, VE.Bus stumm' : s.devices.length ? null : s.link.error,
      };
      if (noDevice) return;
      s.dc = dc ? { v: round(ramValue(dc.voltage, this.info(RAM.uBat), false), 2), a: round(iBat * (dc.chargerCurrent - dc.inverterCurrent), 1) } : { v: null, a: null };
      s.phases = acFrames.map((a): InverterPhase => {
        const inV = round(ramValue(a.mainsVoltage, this.info(RAM.uMains)), 1);
        return {
          phase: PHASES[a.phase - 1]!,
          acIn: {
            v: inV,
            a: round(ramValue(a.mainsCurrent, this.info(RAM.iMains)) * a.bfFactor, 1),
            // Ohne Spannung ist die Periodendauer bedeutungslos
            hz: inV !== null && inV >= MIN_AC_V ? round(periodToHz(a.mainsPeriod, this.info(RAM.mainsPeriod)), 1) : null,
          },
          acOut: {
            v: round(ramValue(a.inverterVoltage, this.info(RAM.uInverter)), 1),
            a: round(ramValue(a.inverterCurrent, this.info(RAM.iInverter)) * a.inverterFactor, 1),
          },
        };
      });
      const outputLive = s.phases.some((p) => (p.acOut.v ?? 0) >= MIN_AC_V);
      s.acOutHz = dc && outputLive ? round(periodToHz(dc.inverterPeriod, this.info(RAM.inverterPeriod)), 1) : null;
      s.outputW = pw ? round(ramValue(pw.value, this.ram[RAM.outputPower]!), 0) : null;
      if (multi) {
        s.shoreLimitA = multi.actualLimit / 10;
        s.shoreLimitMinA = multi.minLimit / 10;
        s.shoreLimitMaxA = multi.maxLimit / 10;
        s.remotePanel = multi.remotePanel || multi.dmcDedicated;
      }
      s.mode = multi?.mode ?? this.commandedMode;
      s.opState = state ? deviceState(state.info0, state.info1) : acFrames[0] ? deviceState(acFrames[0].state, 0) : s.opState;
      s.leds = led ? parseLeds(led) : s.leds;
    });
  }

  // --- Befehle ---

  private ensureReady(): void {
    if (!this.link || !this.state.link.connected) throw new CommandError('Keine Verbindung zum MK3');
  }

  private async sendState(mode: InverterMode, limitDeciAmps: number | null): Promise<void> {
    const r = await this.job(() => this.request(setState(mode, limitDeciAmps, this.opts.repeatPanelState), (f) => isMk(f, CMD.state)));
    if (!r) throw new CommandError('MK3 hat den Befehl nicht bestätigt');
    this.commandedMode = mode;
    this.wake?.();
  }

  private async setMode(mode: InverterMode): Promise<string> {
    this.ensureReady();
    const limit = this.state.shoreLimitA === null ? null : Math.round(this.state.shoreLimitA * 10);
    await this.sendState(mode, limit);
    this.update((s) => void (s.mode = mode));
    const warn = this.state.remotePanel ? ' – Achtung: Am VE.Bus ist eine Fernbedienung erkannt, ihr Schalter hat Vorrang.' : '';
    return `Wechselrichter: ${INVERTER_MODE_LABELS[mode]}${warn}`;
  }

  private async setShoreLimit(amps: number): Promise<string> {
    this.ensureReady();
    const mode = this.state.mode ?? this.commandedMode;
    if (!mode) throw new CommandError('Betriebsart noch unbekannt – bitte erst die Betriebsart wählen');
    const { shoreLimitMinA: min, shoreLimitMaxA: max } = this.state;
    if (min !== null && amps < min) throw new CommandError(`Mindestens ${min} A (Untergrenze des Geräts)`);
    if (max !== null && amps > max) throw new CommandError(`Höchstens ${max} A (Obergrenze des Geräts)`);
    await this.sendState(mode, Math.round(amps * 10));
    this.update((s) => void (s.shoreLimitA = amps));
    return `Landstrom-Begrenzung: ${amps.toLocaleString('de-DE')} A`;
  }
}

const isPhase = (f: MkFrame, phase: number) => {
  const i = parseInfo(f);
  return i?.kind === 'ac' && i.phase === phase;
};
