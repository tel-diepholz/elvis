import { logoBitAddress, logoSpec, parseLogoSignalId } from '@elvis/shared';
import type { LogoClient } from './client.js';

/**
 * Nachbildung einer LOGO für Simulation und Tests: Speicher von DB1, Analogwert AI1 schwankt, und eine steigende
 * Flanke auf NIn schaltet den Ausgang Qn um (wie ein Stromstoßrelais im LOGO-Programm).
 */
export class SimLogoClient implements LogoClient {
  readonly mem = new Uint8Array(1500);
  connected = false;
  failing = false;
  private tick = 0;

  async connect(): Promise<void> {
    if (this.failing) throw new Error('Simulierter Verbindungsfehler');
    this.connected = true;
  }

  private bit(byte: number, bit: number): boolean {
    return ((this.mem[byte]! >> bit) & 1) === 1;
  }

  setSignal(id: string, value: number): void {
    const p = parseLogoSignalId(id)!;
    if (logoSpec(p.kind).analog) {
      const off = logoSpec(p.kind).offset + (p.n - 1) * 2;
      this.mem[off] = (value >> 8) & 0xff;
      this.mem[off + 1] = value & 0xff;
    } else {
      const { byte, bit } = logoBitAddress(p.kind, p.n);
      this.mem[byte] = value ? this.mem[byte]! | (1 << bit) : this.mem[byte]! & ~(1 << bit);
    }
  }

  async readBytes(ranges: { offset: number; length: number }[]): Promise<Uint8Array[]> {
    if (!this.connected || this.failing) throw new Error('Nicht verbunden');
    this.tick++;
    this.setSignal('AI1', 500 + Math.round(Math.sin(this.tick / 5) * 40));
    return ranges.map((r) => this.mem.slice(r.offset, r.offset + r.length));
  }

  async writeBit(byte: number, bit: number, value: boolean): Promise<void> {
    if (!this.connected || this.failing) throw new Error('Nicht verbunden');
    const before = this.bit(byte, bit);
    this.setBitRaw(byte, bit, value);
    const ni = logoSpec('NI');
    const n = (byte - ni.offset) * 8 + bit + 1;
    if (!before && value && n >= 1 && n <= ni.count) this.setSignal(`Q${n}`, this.signal(`Q${n}`) ? 0 : 1);
  }

  private setBitRaw(byte: number, bit: number, value: boolean): void {
    this.mem[byte] = value ? this.mem[byte]! | (1 << bit) : this.mem[byte]! & ~(1 << bit);
  }

  signal(id: string): number {
    const p = parseLogoSignalId(id)!;
    const { byte, bit } = logoBitAddress(p.kind, p.n);
    return this.bit(byte, bit) ? 1 : 0;
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}
