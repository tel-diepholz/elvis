import type { InverterLed, InverterLeds, InverterMode, InverterOpState } from '@elvis/shared';

/**
 * MK2/MK3-Protokoll für VE.Bus-Geräte (Victron MultiPlus, Quattro) nach Victrons
 * „Interfacing with VE.Bus products – MK2 Protocol“ (Version 3.14). Nur reine Funktionen:
 * Frames bauen und zerlegen, Werte umrechnen.
 *
 * Frame: <Länge> <Kennung> <Daten …> <Prüfsumme>
 *   Länge      Anzahl Bytes ohne Länge und Prüfsumme; Bit 7 = LED-Status angehängt
 *   Kennung    0xFF für Frames des MK2/MK3, sonst VE.Bus-Frames (0x20 Info, 0x41 MasterMultiLED, 0x40 Panel)
 *   Prüfsumme  so gewählt, dass die Summe aller Bytes (mit Länge und Prüfsumme) 0 ergibt (mod 256)
 * Mehrbyte-Werte sind little endian. Schnittstelle: 2400 Baud, 8N1.
 */

export const BAUD_RATE = 2400;
/** Victron empfiehlt 500 ms (F5: 750 ms); über Serial over IP kommt die Netzlaufzeit dazu */
export const RESPONSE_TIMEOUT_MS = 1500;

export const MARKER_MK2 = 0xff;
export const MARKER_INFO = 0x20;
export const MARKER_MASTER_LED = 0x41;

const ch = (c: string) => c.charCodeAt(0);
export const CMD = { version: ch('V'), reset: ch('R'), address: ch('A'), led: ch('L'), info: ch('F'), state: ch('S'), winmon: ch('W') } as const;

/** Winmon-Befehle (im „W“-Frame) und ihre Antwortkennungen */
export const WM = {
  softwareVersion0: 0x05,
  softwareVersion1: 0x06,
  deviceState: 0x0e,
  readRamVar: 0x30,
  ramVarInfo: 0x36,
} as const;
export const WM_REPLY = {
  unknown: 0x80,
  softwareVersion0: 0x82,
  softwareVersion1: 0x83,
  ramRead: 0x85,
  ramInfoScale: 0x8e,
  ramInfoOffset: 0x8f,
  ramNotSupported: 0x90,
  deviceState: 0x94,
} as const;

/** RAM-Variablen (Kap. 7.3.13.1) */
export const RAM = {
  uMains: 0,
  iMains: 1,
  uInverter: 2,
  iInverter: 3,
  uBat: 4,
  iBat: 5,
  inverterPeriod: 7,
  mainsPeriod: 8,
  inverterPower: 14,
  outputPower: 16,
} as const;

/** Info-Anfragen mit „F“ */
export const INFO = { dc: 0, acL1: 1, masterMultiLed: 5 } as const;

/** Schalterstellung im „S“-Befehl */
export const SWITCH_STATE: Record<InverterMode, number> = { 'charger-only': 1, 'inverter-only': 2, on: 3, off: 4 };

export interface MkFrame {
  /** 0xFF (MK2) oder VE.Bus-Kennung */
  marker: number;
  /** Bytes nach der Kennung, ohne Prüfsumme */
  data: Buffer;
}

export function checksum(bytes: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += bytes[i]!;
  return (256 - (sum & 0xff)) & 0xff;
}

/** Frame mit Länge und Prüfsumme */
export function encodeFrame(marker: number, data: ArrayLike<number>): Buffer {
  const body = [data.length + 1, marker, ...Array.from(data)];
  if (body[0]! > 0x7f) throw new Error('Frame zu lang');
  return Buffer.from([...body, checksum(body)]);
}

/** Befehl an das MK2/MK3 */
export const mk = (cmd: number, ...data: number[]): Buffer => encodeFrame(MARKER_MK2, [cmd, ...data]);

export const versionRequest = () => mk(CMD.version);
export const resetInterface = () => mk(CMD.reset);
export const setAddress = (address: number) => mk(CMD.address, 0x01, address & 0xff);
export const ledRequest = () => mk(CMD.led);
export const infoRequest = (type: number) => mk(CMD.info, type);
export const winmon = (cmd: number, a = 0, b = 0) => mk(CMD.winmon, cmd, a & 0xff, b & 0xff);

/**
 * Betriebsart und Landstrom-Begrenzung als Fernbedienung senden („S“, Variante 2: Grenze in 0,1 A).
 * `limitDeciAmps` null = Begrenzung nicht vorgeben (das Gerät nutzt seine eigene Einstellung).
 * `repeat` = das MK3 wiederholt den Zustand alle ½ s selbst, wie ein Digital Multi Control.
 */
export function setState(mode: InverterMode, limitDeciAmps: number | null, repeat: boolean): Buffer {
  const limit = limitDeciAmps === null ? 0x8000 : Math.max(0, Math.min(0x7fff, Math.round(limitDeciAmps)));
  return mk(CMD.state, SWITCH_STATE[mode], limit & 0xff, limit >> 8, 0x01, 0x80 | (repeat ? 0x01 : 0));
}

/**
 * Zerlegt den Bytestrom in Frames. Passt die Prüfsumme nicht, wird ein Byte verworfen und neu
 * synchronisiert – so findet der Decoder nach Störungen oder mitten im Strom den nächsten Frame.
 */
export class MkDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): MkFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: MkFrame[] = [];
    while (this.buf.length >= 1) {
      const len = this.buf[0]! & 0x7f;
      if (len < 2 || len > MAX_LENGTH) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      const total = len + 2;
      if (this.buf.length < total) {
        // Unvollständig – oder ein Störbyte, das wie eine Länge aussieht: steht dahinter schon ein
        // vollständiger gültiger Frame, war es Müll
        const next = this.findFrame(1);
        if (next < 0) break;
        this.buf = this.buf.subarray(next);
        continue;
      }
      if (!validAt(this.buf, 0)) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      frames.push({ marker: this.buf[1]!, data: Buffer.from(this.buf.subarray(2, total - 1)) });
      this.buf = this.buf.subarray(total);
    }
    if (!this.buf.length) this.buf = Buffer.alloc(0);
    return frames;
  }

  private findFrame(from: number): number {
    for (let i = from; i < this.buf.length; i++) if (KNOWN_MARKERS.has(this.buf[i + 1]!) && validAt(this.buf, i)) return i;
    return -1;
  }
}

/** Längste Antwort: lange Winmon-Frames (Modus 2) mit 14 Bytes Nutzdaten; LED-Status kommt dazu */
const MAX_LENGTH = 0x20;
const KNOWN_MARKERS = new Set([MARKER_MK2, MARKER_INFO, MARKER_MASTER_LED]);

/** Vollständiger Frame mit passender Prüfsumme ab Position i */
function validAt(buf: Buffer, i: number): boolean {
  const len = buf[i]! & 0x7f;
  if (len < 2 || len > MAX_LENGTH || i + len + 2 > buf.length) return false;
  let sum = 0;
  for (let k = i; k < i + len + 2; k++) sum += buf[k]!;
  return (sum & 0xff) === 0;
}

export const isMk = (f: MkFrame, cmd: number) => f.marker === MARKER_MK2 && f.data[0] === cmd;

// --- Antworten ---

export interface VersionFrame {
  version: number;
  /** Adresse, die im MK3 eingestellt ist; null = keine („B“). mode9bit = Gerät spricht nicht VE.Bus */
  address: number | null;
  mode9bit: boolean;
}

export function parseVersion(f: MkFrame): VersionFrame | null {
  if (!isMk(f, CMD.version) || f.data.length < 5) return null;
  const mode = f.data.length > 5 ? f.data[5]! : 0;
  return { version: f.data.readUInt32LE(1), address: mode <= 0x1f ? mode : null, mode9bit: mode === ch('W') };
}

export function parseAddress(f: MkFrame): number | null {
  if (!isMk(f, CMD.address) || f.data.length < 3) return null;
  return f.data[2]!;
}

const led = (on: number, blink: number, bit: number): InverterLed => ((blink >> bit) & 1 ? 'blink' : (on >> bit) & 1 ? 'on' : 'off');

/** „L“-Antwort; null wenn das MK3 die LEDs nicht kennt (beide 0x1F) */
export function parseLeds(f: MkFrame): InverterLeds | null {
  if (!isMk(f, CMD.led) || f.data.length < 3) return null;
  const on = f.data[1]!;
  const blink = f.data[2]!;
  if (on === 0x1f && blink === 0x1f) return null;
  return {
    mains: led(on, blink, 0),
    absorption: led(on, blink, 1),
    bulk: led(on, blink, 2),
    float: led(on, blink, 3),
    inverter: led(on, blink, 4),
    overload: led(on, blink, 5),
    lowBattery: led(on, blink, 6),
    temperature: led(on, blink, 7),
  };
}

export interface DcInfo {
  kind: 'dc';
  /** Rohwerte, Umrechnung mit den RAM-Infos von UBat, IBat und Inverter Period */
  voltage: number;
  inverterCurrent: number;
  chargerCurrent: number;
  inverterPeriod: number;
}

export interface AcInfo {
  kind: 'ac';
  phase: 1 | 2 | 3 | 4;
  /** Nur in L1-Frames: Anzahl der Phasen im System */
  phases: number | null;
  bfFactor: number;
  inverterFactor: number;
  state: number;
  mainsVoltage: number;
  mainsCurrent: number;
  inverterVoltage: number;
  inverterCurrent: number;
  mainsPeriod: number;
}

/** Info-Frame (Kennung 0x20) als Antwort auf F0 (DC) bzw. F1–F4 (AC je Phase) */
export function parseInfo(f: MkFrame): DcInfo | AcInfo | null {
  if (f.marker !== MARKER_INFO || f.data.length < 14) return null;
  const d = f.data;
  const phaseInfo = d[4]!;
  if (phaseInfo === 0x0c) {
    return { kind: 'dc', voltage: d.readUInt16LE(5), inverterCurrent: d.readUIntLE(7, 3), chargerCurrent: d.readUIntLE(10, 3), inverterPeriod: d[13]! };
  }
  if (phaseInfo < 0x05 || phaseInfo > 0x0b) return null;
  const phase = (phaseInfo >= 0x08 ? 1 : 9 - phaseInfo) as AcInfo['phase'];
  return {
    kind: 'ac',
    phase,
    phases: phaseInfo >= 0x08 ? phaseInfo - 0x07 : null,
    bfFactor: d[0]!,
    inverterFactor: d[1]!,
    state: d[3]!,
    mainsVoltage: d.readUInt16LE(5),
    mainsCurrent: d.readUInt16LE(7),
    inverterVoltage: d.readUInt16LE(9),
    inverterCurrent: d.readUInt16LE(11),
    mainsPeriod: d[13]!,
  };
}

export interface MasterMultiLed {
  /** Landstrom-Begrenzung in 0,1 A */
  minLimit: number;
  maxLimit: number;
  actualLimit: number;
  /** Fernbedienung erkannt (ab Firmware 415) */
  remotePanel: boolean;
  /** DMC fest zugeordnet */
  dmcDedicated: boolean;
  /** Betriebsart aus dem Schalterregister; null wenn das Gerät es nicht meldet */
  mode: InverterMode | null;
}

/** MasterMultiLED-Frame (Kennung 0x41) als Antwort auf F5 */
export function parseMasterMultiLed(f: MkFrame): MasterMultiLed | null {
  if (f.marker !== MARKER_MASTER_LED || f.data.length < 11) return null;
  const d = f.data;
  const config = d[4]!;
  const sw = d.length > 11 ? d[11]! : null;
  const charge = sw !== null && !!(sw & 0x10);
  const invert = sw !== null && !!(sw & 0x20);
  return {
    minLimit: d.readUInt16LE(5),
    maxLimit: d.readUInt16LE(7),
    actualLimit: d.readUInt16LE(9),
    remotePanel: !!(config & 0x80),
    dmcDedicated: !!(config & 0x08),
    mode: sw === null ? null : charge && invert ? 'on' : charge ? 'charger-only' : invert ? 'inverter-only' : 'off',
  };
}

export interface WinmonReply {
  code: number;
  value: number;
  /** Rohbytes Info 0 und Info 1 */
  info0: number;
  info1: number;
}

/** Antwort auf „W“: bis zu drei Teil-Frames zu je 3 Bytes (Winmon-Modus 1, Standard des MK3) */
export function parseWinmon(f: MkFrame): WinmonReply[] | null {
  if (!isMk(f, CMD.winmon)) return null;
  const out: WinmonReply[] = [];
  for (let i = 1; i + 3 <= f.data.length; i += 3) {
    out.push({ code: f.data[i]!, info0: f.data[i + 1]!, info1: f.data[i + 2]!, value: f.data.readUInt16LE(i + 1) });
  }
  return out;
}

// --- Umrechnung ---

/** Skalierung einer RAM-Variablen (Antwort auf CommandGetRAMVarInfo) */
export interface RamInfo {
  sc: number;
  offset: number;
}

/** Typische Werte eines MultiPlus (Anhang 2 des Dokuments) – bis das Gerät seine eigenen geliefert hat */
export const DEFAULT_RAM_INFO: Record<number, RamInfo> = {
  [RAM.uMains]: { sc: 32668, offset: 0 },
  [RAM.iMains]: { sc: 32668, offset: 0 },
  [RAM.uInverter]: { sc: 32668, offset: 0 },
  [RAM.iInverter]: { sc: 32668, offset: 0 },
  [RAM.uBat]: { sc: 32668, offset: 0 },
  [RAM.iBat]: { sc: -32668, offset: 0 },
  [RAM.inverterPeriod]: { sc: 30807, offset: 256 },
  [RAM.mainsPeriod]: { sc: 31791, offset: 0 },
};

export const toInt16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v);

export function ramScale(info: RamInfo): number {
  const s = Math.abs(info.sc);
  return s >= 0x4000 ? 1 / (0x8000 - s) : s;
}

/** Anzeigewert = Scale × (x + Offset); x vorzeichenbehaftet, wenn Sc < 0 */
export function ramValue(raw: number, info: RamInfo, signed = info.sc < 0): number {
  return ramScale(info) * ((signed ? toInt16(raw) : raw) + info.offset);
}

/** Periodendauer → Frequenz (Zeitbasis 0,1 s); null ohne Signal */
export function periodToHz(raw: number, info: RamInfo): number | null {
  const t = ramValue(raw, info, false);
  return t > 0 ? 10 / t : null;
}

/** Zustand aus CommandGetSetDeviceState (bzw. dem Info-Frame) */
export function deviceState(state: number, sub: number): InverterOpState | null {
  switch (state) {
    case 0:
      return 'down';
    case 1:
      return 'startup';
    case 2:
      return 'off';
    case 3:
      return 'slave';
    case 4:
    case 5:
      return 'invert';
    case 6:
      return 'aes';
    case 7:
      return 'power-assist';
    case 8:
      return 'passthru';
    case 9:
      return (['charge-init', 'bulk', 'absorption', 'float', 'storage', 'absorption', 'absorption', 'equalize', 'bulk-stopped'] as const)[sub] ?? 'bulk';
    default:
      return null;
  }
}

/** Firmware als Zahl „AABBCCC“ (Produkt, Modell, Version) */
export const firmwareString = (v: number) => String(v);
