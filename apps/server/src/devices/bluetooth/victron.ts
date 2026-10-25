import { createCipheriv } from 'node:crypto';
import { VICTRON_ALARM_LABELS, type VictronBalancer, type VictronCellVoltage, type VictronReadout } from '@elvis/shared';

/**
 * Victron „Instant Readout“: Victron-Geräte senden ihre Messwerte verschlüsselt in den Herstellerdaten ihrer
 * Bluetooth-Werbepakete (Hersteller-ID 0x02E1). Aufbau nach Victrons „Extra manufacturer data“ und
 * github.com/keshavdv/victron-ble:
 *
 *   0     0x10 (Datensatz „Product advertisement“)
 *   1     reserviert
 *   2–3   Produkt-ID (little endian)
 *   4     Art der Messwerte (1 Solar, 2 Batteriemonitor, 4 DC/DC, 5 Lithium-Batterie, 8 Ladegerät …)
 *   5–6   Zähler, Startwert für AES-CTR (little endian)
 *   7     erstes Byte des Schlüssels – passt es nicht, ist der Schlüssel falsch
 *   8…    Messwerte, AES-128-CTR; Bitfelder ab dem niederwertigsten Bit
 */

export const VICTRON_COMPANY_ID = 0x02e1;

export interface VictronPacket {
  productId: number;
  readoutType: number;
  iv: number;
  keyCheck: number;
  encrypted: Buffer;
}

/** Herstellerdaten (ohne Hersteller-ID) als Instant-Readout-Paket lesen; null bei anderen Victron-Paketen */
export function victronPacket(data: Buffer): VictronPacket | null {
  if (data.length < 9 || data[0] !== 0x10) return null;
  return { productId: data.readUInt16LE(2), readoutType: data[4]!, iv: data.readUInt16LE(5), keyCheck: data[7]!, encrypted: data.subarray(8) };
}

export class VictronKeyError extends Error {
  constructor() {
    super('Schlüssel passt nicht zum Gerät');
  }
}

/** AES-128-CTR mit Zähler im little endian (wie PyCryptodome Counter(little_endian=True)) */
function ctr(key: Buffer, iv: number, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let block = 0; block * 16 < data.length; block++) {
    const counter = Buffer.alloc(16);
    let n = BigInt(iv + block);
    for (let i = 0; i < 16 && n > 0n; i++, n >>= 8n) counter[i] = Number(n & 0xffn);
    const c = createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    const stream = c.update(counter);
    for (let i = 0; i < 16 && block * 16 + i < data.length; i++) out[block * 16 + i] = data[block * 16 + i]! ^ stream[i]!;
  }
  return out;
}

export function victronDecrypt(p: VictronPacket, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 16) throw new VictronKeyError();
  if (p.keyCheck !== key[0]) throw new VictronKeyError();
  return ctr(key, p.iv, p.encrypted);
}

/** Bitfelder ab dem niederwertigsten Bit; fehlende Bytes (kurze Pakete) lesen sich als 1 = „nicht verfügbar“ */
class BitReader {
  private pos = 0;
  constructor(private readonly data: Buffer) {}

  unsigned(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++, this.pos++) {
      const byte = this.data[this.pos >> 3] ?? 0xff;
      v += ((byte >> (this.pos & 7)) & 1) * 2 ** i;
    }
    return v;
  }

  signed(bits: number): { raw: number; value: number } {
    const raw = this.unsigned(bits);
    return { raw, value: raw >= 2 ** (bits - 1) ? raw - 2 ** bits : raw };
  }
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
/** Wert oder null, wenn das Feld „nicht verfügbar“ (alle Bits gesetzt bzw. größte positive Zahl) meldet */
const na = (raw: number, missing: number, value: number): number | null => (raw === missing ? null : value);

const BALANCER: Record<number, VictronBalancer> = { 1: 'balanced', 2: 'balancing', 3: 'imbalance' };

const READOUT_TYPES: Record<number, VictronReadout['type']> = { 0x01: 'solar', 0x02: 'battery-monitor', 0x04: 'dcdc', 0x05: 'lithium', 0x08: 'ac-charger' };

/** Art der Messwerte laut Paketkopf – auch ohne Schlüssel bekannt */
export const victronReadoutType = (readoutType: number): VictronReadout['type'] => READOUT_TYPES[readoutType] ?? 'unsupported';

/** Entschlüsselte Messwerte je nach Art lesen */
export function victronParse(readoutType: number, d: Buffer): VictronReadout {
  const r = new BitReader(d);
  switch (readoutType) {
    case 0x01: {
      const state = r.unsigned(8);
      const error = r.unsigned(8);
      const voltage = r.signed(16);
      const current = r.signed(16);
      const yieldToday = r.unsigned(16);
      const power = r.unsigned(16);
      const load = r.unsigned(9);
      return {
        type: 'solar',
        state: na(state, 0xff, state),
        error: na(error, 0xff, error),
        voltageV: na(voltage.raw, 0x7fff, round(voltage.value / 100, 2)),
        currentA: na(current.raw, 0x7fff, round(current.value / 10, 1)),
        yieldTodayWh: na(yieldToday, 0xffff, yieldToday * 10),
        pvPowerW: na(power, 0xffff, power),
        loadCurrentA: na(load, 0x1ff, round(load / 10, 1)),
      };
    }
    case 0x02: {
      const remaining = r.unsigned(16);
      const voltage = r.signed(16);
      const alarm = r.unsigned(16);
      const aux = r.unsigned(16);
      const auxMode = r.unsigned(2);
      const current = r.signed(22);
      const consumed = r.unsigned(20);
      const soc = r.unsigned(10);
      const auxSigned = aux >= 0x8000 ? aux - 0x10000 : aux;
      return {
        type: 'battery-monitor',
        remainingMin: na(remaining, 0xffff, remaining),
        voltageV: na(voltage.raw, 0x7fff, round(voltage.value / 100, 2)),
        currentA: na(current.raw, 0x1fffff, round(current.value / 1000, 3)),
        consumedAh: na(consumed, 0xfffff, round(-consumed / 10, 1)),
        socPct: na(soc, 0x3ff, round(soc / 10, 1)),
        // Hilfseingang: Starterbatterie (0), Mittelpunkt (1) oder Temperatur in 0,01 K (2); 0x7FFF/0xFFFF = nicht verfügbar
        starterVoltageV: auxMode === 0 && aux !== 0x7fff ? round(auxSigned / 100, 2) : null,
        midpointVoltageV: auxMode === 1 && aux < 0xfffe ? round(aux / 100, 2) : null,
        temperatureC: auxMode === 2 && aux < 0xfffe ? round(aux / 100 - 273.15, 1) : null,
        alarms: VICTRON_ALARM_LABELS.filter(([bit]) => alarm & bit).map(([, label]) => label),
      };
    }
    case 0x04: {
      const state = r.unsigned(8);
      const error = r.unsigned(8);
      const input = r.unsigned(16);
      const output = r.signed(16);
      const offReason = r.unsigned(32);
      return {
        type: 'dcdc',
        state: na(state, 0xff, state),
        error: na(error, 0xff, error),
        inputVoltageV: na(input, 0xffff, round(input / 100, 2)),
        outputVoltageV: na(output.raw, 0x7fff, round(output.value / 100, 2)),
        offReason,
      };
    }
    case 0x05: {
      const bmsFlags = r.unsigned(32);
      const errorFlags = r.unsigned(16);
      const cellsRaw = Array.from({ length: 8 }, () => r.unsigned(7));
      const voltage = r.unsigned(12);
      const balancer = r.unsigned(4);
      const temperature = r.unsigned(7);
      const cells = cellsRaw
        .filter((c) => c !== 0x7f)
        .map((c): VictronCellVoltage => (c === 0 ? 'low' : c === 0x7e ? 'high' : round((260 + c) / 100, 2)));
      return {
        type: 'lithium',
        bmsFlags,
        errorFlags,
        cells,
        voltageV: na(voltage, 0xfff, round(voltage / 100, 2)),
        balancer: BALANCER[balancer] ?? null,
        temperatureC: na(temperature, 0x7f, temperature - 40),
      };
    }
    case 0x08: {
      const state = r.unsigned(8);
      const error = r.unsigned(8);
      const outputs: { voltageV: number; currentA: number | null }[] = [];
      for (let i = 0; i < 3; i++) {
        const v = r.unsigned(13);
        const c = r.unsigned(11);
        if (v !== 0x1fff) outputs.push({ voltageV: round(v / 100, 2), currentA: na(c, 0x7ff, round(c / 10, 1)) });
      }
      const temperature = r.unsigned(7);
      const ac = r.unsigned(9);
      return {
        type: 'ac-charger',
        state: na(state, 0xff, state),
        error: na(error, 0xff, error),
        outputs,
        temperatureC: na(temperature, 0x7f, temperature - 40),
        acCurrentA: na(ac, 0x1ff, round(ac / 10, 1)),
      };
    }
    default:
      return { type: 'unsupported', readoutType };
  }
}

/** Herstellerdaten mit Schlüssel lesen; wirft VictronKeyError bei falschem Schlüssel, null wenn kein Instant Readout */
export function victronRead(data: Buffer, keyHex: string): VictronReadout | null {
  const p = victronPacket(data);
  if (!p) return null;
  return victronParse(p.readoutType, victronDecrypt(p, keyHex));
}

// --- Erzeugen (Simulation und Tests) ---

class BitWriter {
  private readonly bytes: number[] = [];
  private pos = 0;

  put(bits: number, value: number): this {
    const v = value < 0 ? value + 2 ** bits : value;
    for (let i = 0; i < bits; i++, this.pos++) {
      if ((this.pos & 7) === 0) this.bytes.push(0);
      if (Math.floor(v / 2 ** i) % 2) this.bytes[this.pos >> 3]! |= 1 << (this.pos & 7);
    }
    return this;
  }

  buffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/** Messwerte einer Lithium-Batterie bzw. eines Batteriemonitors so verpacken, wie das Gerät sie sendet */
export function victronEncode(
  readout: Extract<VictronReadout, { type: 'lithium' | 'battery-monitor' }>,
  keyHex: string,
  opts: { productId?: number; iv?: number } = {},
): Buffer {
  const w = new BitWriter();
  const cents = (v: number | null, missing: number) => (v === null ? missing : Math.round(v * 100));
  let type: number;
  if (readout.type === 'lithium') {
    type = 0x05;
    w.put(32, readout.bmsFlags).put(16, readout.errorFlags);
    for (let i = 0; i < 8; i++) {
      const c = readout.cells[i];
      w.put(7, c === undefined ? 0x7f : c === 'low' ? 0 : c === 'high' ? 0x7e : Math.round(c * 100) - 260);
    }
    const balancer = Object.entries(BALANCER).find(([, b]) => b === readout.balancer)?.[0];
    w.put(12, cents(readout.voltageV, 0xfff))
      .put(4, balancer ? Number(balancer) : 0xf)
      .put(7, readout.temperatureC === null ? 0x7f : readout.temperatureC + 40);
  } else {
    type = 0x02;
    w.put(16, readout.remainingMin ?? 0xffff)
      .put(16, cents(readout.voltageV, 0x7fff))
      .put(16, 0)
      .put(16, 0xffff)
      .put(2, 3)
      .put(22, readout.currentA === null ? 0x1fffff : Math.round(readout.currentA * 1000))
      .put(20, readout.consumedAh === null ? 0xfffff : Math.round(-readout.consumedAh * 10))
      .put(10, readout.socPct === null ? 0x3ff : Math.round(readout.socPct * 10));
  }
  const key = Buffer.from(keyHex, 'hex');
  const iv = opts.iv ?? 0;
  const head = Buffer.alloc(8);
  head[0] = 0x10;
  head.writeUInt16LE(opts.productId ?? (type === 0x05 ? 0xa3e5 : 0xa389), 2);
  head[4] = type;
  head.writeUInt16LE(iv, 5);
  head[7] = key[0]!;
  return Buffer.concat([head, ctr(key, iv, w.buffer())]);
}
