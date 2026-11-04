import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import type { InverterMode } from '@elvis/shared';
import {
  CMD,
  DEFAULT_RAM_INFO,
  MARKER_INFO,
  MARKER_MASTER_LED,
  MkDecoder,
  RAM,
  SWITCH_STATE,
  WM,
  WM_REPLY,
  encodeFrame,
  mk,
  ramScale,
  type MkFrame,
} from './protocol.js';
import type { ByteLink } from './adapter.js';

export interface EmulatorOptions {
  /** Anzahl Geräte am Bus (parallel auf einer Phase); Adresse 0 ist Master */
  units?: number;
  /** Landstrom anfangs vorhanden */
  shore?: boolean;
  /** Landstrom im Wechsel an/aus (Sekunden an, Sekunden aus); null = fest */
  shoreCycle?: [number, number] | null;
  /** Fernbedienung (DMC) am Bus melden */
  remotePanel?: boolean;
  /** Antwortverzögerung des Busses */
  latencyMs?: number;
}

const MK3_VERSION = 1170212;
const DEVICE_FIRMWARE = 2623497;
const MAINS_V = 230;
const ABSORPTION_V = 28.8;
const FLOAT_V = 27.6;
const ABSORPTION_S = 120;

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
/** Wert → Rohwert mit Skalierung der RAM-Variablen */
const raw = (id: number, value: number) => Math.max(0, Math.round(value / ramScale(DEFAULT_RAM_INFO[id]!) - DEFAULT_RAM_INFO[id]!.offset));
const periodRaw = (id: number, hz: number) => (hz > 0 ? raw(id, 10 / hz) : 0);

/**
 * Nachbildung eines MK3-USB mit MultiPlus (24 V) dahinter – spricht das MK2-Protokoll wie das echte Gerät.
 * Dient als Simulation in ELVIS, als TCP-Simulator („npm run vebus:sim“) und in den Tests.
 */
export class MultiPlusEmulator {
  private readonly decoder = new MkDecoder();
  private out: ((b: Buffer) => void) | null = null;
  private address: number | null = null;
  private timers: NodeJS.Timeout[] = [];
  private lastTx = 0;
  private readonly units: number;
  private readonly latencyMs: number;
  private readonly shoreCycle: [number, number] | null;
  private cycleStart = Date.now();
  private lastTick = Date.now();
  // Modell
  mode: InverterMode = 'on';
  limitDeci = 160;
  readonly minLimitDeci = 30;
  readonly maxLimitDeci = 500;
  shore: boolean;
  remotePanel: boolean;
  batteryV = 26.2;
  batteryA = 0;
  loadW = 450;
  private absorptionLeft = ABSORPTION_S;
  /** Zuletzt gesendete Befehle (für Tests) */
  readonly received: number[] = [];

  constructor(opts: EmulatorOptions = {}) {
    this.units = Math.max(1, Math.min(4, opts.units ?? 1));
    this.shore = opts.shore ?? true;
    this.shoreCycle = opts.shoreCycle ?? null;
    this.remotePanel = opts.remotePanel ?? false;
    this.latencyMs = opts.latencyMs ?? 20;
  }

  start(): void {
    this.stop();
    this.lastTick = this.cycleStart = Date.now();
    this.timers.push(setInterval(() => this.tick(), 1000));
    // Versionsframes etwa einmal pro Sekunde, wenn sonst nichts gesendet wird
    this.timers.push(setInterval(() => Date.now() - this.lastTx >= 1000 && this.send(this.versionFrame()), 1000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  attach(out: (b: Buffer) => void): void {
    this.out = out;
    this.address = null;
  }

  detach(): void {
    this.out = null;
  }

  receive(chunk: Buffer): void {
    for (const f of this.decoder.push(chunk)) this.handle(f);
  }

  // --- Modell ---

  get opState(): { state: number; sub: number } {
    if (this.mode === 'off') return { state: 2, sub: 0 };
    const charging = this.shore && (this.mode === 'on' || this.mode === 'charger-only');
    if (charging) {
      if (this.batteryV < ABSORPTION_V - 0.05 && this.absorptionLeft === ABSORPTION_S) return { state: 9, sub: 1 };
      if (this.absorptionLeft > 0) return { state: 9, sub: 2 };
      return { state: 9, sub: 3 };
    }
    if (this.shore && this.mode === 'inverter-only') return { state: 4, sub: 0 };
    if (!this.shore && this.mode !== 'charger-only') return { state: 4, sub: 0 };
    return { state: 2, sub: 0 };
  }

  get inverting(): boolean {
    return this.opState.state === 4;
  }

  get outputOn(): boolean {
    const s = this.opState.state;
    return s === 4 || (s === 9 && this.shore);
  }

  get mainsA(): number {
    if (!this.shore || this.mode === 'off' || this.mode === 'inverter-only') return 0;
    const chargeW = this.batteryA > 0 ? this.batteryA * this.batteryV * 1.1 : 0;
    return Math.min(this.limitDeci / 10, (this.loadW + chargeW) / MAINS_V);
  }

  private tick(): void {
    const now = Date.now();
    const dt = Math.min(5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (this.shoreCycle) {
      const [on, off] = this.shoreCycle;
      const t = ((now - this.cycleStart) / 1000) % (on + off);
      const shore = t < on;
      if (shore !== this.shore) {
        this.shore = shore;
        if (shore) this.absorptionLeft = ABSORPTION_S;
      }
    }
    this.loadW = Math.max(80, Math.min(2200, this.loadW + (650 - this.loadW) * 0.05 + (Math.random() - 0.5) * 60));
    const { state, sub } = this.opState;
    if (state === 9) {
      const limitW = Math.max(0, (this.limitDeci / 10) * MAINS_V - this.loadW) / 1.1;
      const target = sub === 1 ? 50 : sub === 2 ? Math.max(2, 50 * (this.absorptionLeft / ABSORPTION_S)) : 1;
      this.batteryA = Math.min(target, limitW / this.batteryV);
      const targetV = sub === 3 ? FLOAT_V : ABSORPTION_V;
      this.batteryV += (targetV - this.batteryV) * 0.03 * dt;
      if (sub === 2) this.absorptionLeft = Math.max(0, this.absorptionLeft - dt);
    } else if (state === 4) {
      this.batteryA = -this.loadW / this.batteryV / 0.92;
      this.batteryV = Math.max(23.5, this.batteryV - 0.0008 * dt * (this.loadW / 500) + (25.6 - this.batteryV) * 0.001 * dt);
    } else {
      this.batteryA = 0;
      this.batteryV += (26.2 - this.batteryV) * 0.01 * dt;
    }
  }

  // --- Protokoll ---

  private send(frame: Buffer): void {
    if (!this.out) return;
    this.lastTx = Date.now();
    const out = this.out;
    setTimeout(() => out === this.out && out(frame), this.latencyMs);
  }

  private versionFrame(): Buffer {
    const v = MK3_VERSION;
    return mk(CMD.version, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff, this.address ?? 0x42);
  }

  private handle(f: MkFrame): void {
    if (f.marker !== 0xff) return;
    const cmd = f.data[0]!;
    this.received.push(cmd);
    this.lastTx = Date.now();
    switch (cmd) {
      case CMD.version:
        return this.send(this.versionFrame());
      case CMD.reset:
        this.address = null;
        return;
      case CMD.address: {
        const action = f.data[1] ?? 0;
        if (action & 1) {
          const a = f.data[2] ?? 0xff;
          this.address = a <= 0x1f ? a : null;
        }
        return this.send(mk(CMD.address, action, this.address ?? 0xff));
      }
      case CMD.led:
        return this.send(mk(CMD.led, ...this.leds()));
      case CMD.info:
        return this.info(f.data[1] ?? 0);
      case CMD.state:
        return this.setState(f.data);
      case CMD.winmon:
        return this.winmon(f.data[1] ?? 0, f.data[2] ?? 0);
    }
  }

  private leds(): [number, number] {
    let on = 0;
    let blink = 0;
    const { state, sub } = this.opState;
    if (this.shore && this.mode !== 'off' && this.mode !== 'inverter-only') on |= 1;
    if (state === 9 && sub === 2) on |= 1 << 1;
    if (state === 9 && sub === 1) on |= 1 << 2;
    if (state === 9 && sub === 3) on |= 1 << 3;
    if (state === 4) on |= 1 << 4;
    if (state === 4 && this.loadW > 2000) blink |= 1 << 5;
    if (this.batteryV < 23.8) blink |= 1 << 6;
    return [on, blink];
  }

  private info(type: number): void {
    const n = this.units;
    if (type === 0) {
      const inv = this.batteryA < 0 ? -this.batteryA : 0;
      const chg = this.batteryA > 0 ? this.batteryA : 0;
      return this.send(
        encodeFrame(MARKER_INFO, [0, 0, 0, 0, 0x0c, ...u16(raw(RAM.uBat, this.batteryV)), ...u24(raw(RAM.iBat, inv)), ...u24(raw(RAM.iBat, chg)), periodRaw(RAM.inverterPeriod, this.outputOn ? 50 : 0)]),
      );
    }
    if (type === 1) {
      const outA = this.outputOn ? this.loadW / MAINS_V : 0;
      const mainsV = this.shore ? MAINS_V + (Math.random() - 0.5) * 2 : 0;
      return this.send(
        encodeFrame(MARKER_INFO, [
          n,
          n,
          0,
          this.opState.state,
          0x08,
          ...u16(raw(RAM.uMains, mainsV)),
          ...u16(raw(RAM.iMains, this.mainsA / n)),
          ...u16(raw(RAM.uInverter, this.outputOn ? MAINS_V : 0)),
          ...u16(raw(RAM.iInverter, outA / n)),
          periodRaw(RAM.mainsPeriod, this.shore ? 50 : 0),
        ]),
      );
    }
    if (type === 5) {
      const sw = this.mode === 'on' ? 0x30 : this.mode === 'charger-only' ? 0x10 : this.mode === 'inverter-only' ? 0x20 : 0;
      return this.send(encodeFrame(MARKER_MASTER_LED, [0, 0, 0, 0, this.remotePanel ? 0x80 : 0, ...u16(this.minLimitDeci), ...u16(this.maxLimitDeci), ...u16(this.limitDeci), sw]));
    }
    // L2–L4 gibt es in diesem einphasigen System nicht: keine Antwort
  }

  private setState(d: Buffer): void {
    const sw = d[1]!;
    const flags = d[5] ?? 0;
    const mode = (Object.keys(SWITCH_STATE) as InverterMode[]).find((m) => SWITCH_STATE[m] === sw);
    if (mode && !this.remotePanel) this.mode = mode;
    if (flags & 0x80) {
      const limit = d.readUInt16LE(2);
      if (limit < 0x8000) this.limitDeci = Math.max(this.minLimitDeci, Math.min(this.maxLimitDeci, limit));
    } else if (d[3]! > 1) {
      this.limitDeci = Math.min(this.maxLimitDeci, Math.round((d[2]! * d[3]! * 10) / 256));
    }
    this.send(mk(CMD.state));
  }

  private winmon(cmd: number, a: number): void {
    // Ohne Gerät an der eingestellten Adresse antwortet niemand
    if (this.address === null || this.address >= this.units) return;
    const w = (code: number, value: number) => [code, ...u16(value & 0xffff)];
    const slave = this.address > 0;
    switch (cmd) {
      case WM.softwareVersion0:
        return this.send(mk(CMD.winmon, ...w(WM_REPLY.softwareVersion0, DEVICE_FIRMWARE & 0xffff)));
      case WM.softwareVersion1:
        return this.send(mk(CMD.winmon, ...w(WM_REPLY.softwareVersion1, DEVICE_FIRMWARE >>> 16)));
      case WM.deviceState: {
        const { state, sub } = slave ? { state: 3, sub: 0 } : this.opState;
        return this.send(mk(CMD.winmon, WM_REPLY.deviceState, state, sub));
      }
      case WM.ramVarInfo: {
        const info = a === RAM.outputPower || a === RAM.inverterPower ? { sc: -1, offset: 0 } : DEFAULT_RAM_INFO[a];
        if (!info) return this.send(mk(CMD.winmon, ...w(WM_REPLY.ramInfoScale, 0)));
        return this.send(mk(CMD.winmon, ...w(WM_REPLY.ramInfoScale, info.sc), ...w(WM_REPLY.ramInfoOffset, info.offset)));
      }
      case WM.readRamVar:
        if (a === RAM.outputPower) return this.send(mk(CMD.winmon, ...w(WM_REPLY.ramRead, Math.round(this.outputOn ? this.loadW / this.units : 0))));
        return this.send(mk(CMD.winmon, ...w(WM_REPLY.ramNotSupported, 0)));
      default:
        return this.send(mk(CMD.winmon, WM_REPLY.unknown, 0, 0));
    }
  }
}

/** Verbindung direkt zum Emulator, ohne Socket (Treiber „Simulation“) */
export class EmulatorLink extends EventEmitter implements ByteLink {
  constructor(private readonly emulator: MultiPlusEmulator) {
    super();
    emulator.attach((b) => this.emit('data', b));
  }

  write(data: Buffer): void {
    this.emulator.receive(data);
  }

  close(): void {
    this.emulator.detach();
    queueMicrotask(() => this.emit('close'));
  }
}

/**
 * TCP-Server wie der Router mit „Serial over IP“: ein Client gleichzeitig, ein neuer verdrängt den alten.
 */
export class VebusSimulator {
  readonly emulator: MultiPlusEmulator;
  private server: Server | null = null;
  private client: Socket | null = null;

  constructor(opts: EmulatorOptions = {}) {
    this.emulator = new MultiPlusEmulator(opts);
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.emulator.start();
    const server = createServer((socket) => {
      this.client?.destroy();
      this.client = socket;
      this.emulator.attach((b) => socket.writable && socket.write(b));
      socket.on('data', (b: Buffer) => this.emulator.receive(b));
      socket.on('error', () => {});
      socket.on('close', () => {
        if (this.client === socket) {
          this.client = null;
          this.emulator.detach();
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    const addr = server.address();
    return typeof addr === 'object' && addr ? addr.port : port;
  }

  /** Verbindungen trennen, Server läuft weiter (für Tests des Wiederverbindens) */
  dropClients(): void {
    this.client?.destroy();
  }

  async close(): Promise<void> {
    this.emulator.stop();
    this.client?.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
