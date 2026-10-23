/**
 * Actisense-Gateways (NGT-1, NGX-1) über USB-Seriell.
 *
 * Rahmen:  DLE STX <Befehl> <Länge> <Daten …> <Prüfsumme> DLE ETX
 * - Ein DLE (0x10) innerhalb von Länge/Daten/Prüfsumme wird verdoppelt (DLE DLE).
 * - Die Prüfsumme ergänzt Befehl, Länge und Daten zu 0 (mod 256).
 * - Befehl 0x93 (BST-93): empfangene NMEA-2000-Nachricht, Fast-Packets bereits zusammengesetzt:
 *   Priorität(1) PGN(3, LE) Ziel(1) Quelle(1) Zeitstempel(4, LE, ms) Datenlänge(1) Daten
 *
 * Quelle der Formatbeschreibung: canboatjs, lib/actisense-serial.ts.
 */

const DLE = 0x10;
const STX = 0x02;
const ETX = 0x03;

export const N2K_MSG_RECEIVED = 0x93;
export const NGT_MSG_SEND = 0xa1;
const BEM_OPERATING_MODE = 0x11;
const OPERATING_MODE_RX_ALL = 2;
const MAX_FRAME = 600;

export interface N2kMessage {
  priority: number;
  pgn: number;
  source: number;
  destination: number;
  /** Zeitstempel des Gateways in ms. */
  timestamp: number;
  data: Buffer;
}

/** Rahmen mit Byte-Stuffing und Prüfsumme bauen (zum Senden und für Tests). */
export function composeFrame(command: number, payload: Uint8Array): Buffer {
  const out: number[] = [DLE, STX];
  const push = (b: number) => {
    if (b === DLE) out.push(DLE);
    out.push(b);
  };
  let sum = command + payload.length;
  out.push(command);
  push(payload.length);
  for (const b of payload) {
    push(b);
    sum += b;
  }
  push((256 - (sum & 0xff)) & 0xff);
  out.push(DLE, ETX);
  return Buffer.from(out);
}

/** Gateway in „NGT Transfer Rx All Mode“ versetzen: alle empfangenen PGNs weiterleiten. */
export const SET_RX_ALL_FRAME = composeFrame(NGT_MSG_SEND, Uint8Array.from([BEM_OPERATING_MODE, OPERATING_MODE_RX_ALL & 0xff, OPERATING_MODE_RX_ALL >> 8]));

/** BST-93-Nachricht (Befehl 0x93) im Rahmen bauen – für Tests und Simulation. */
export function composeN2k(msg: Omit<N2kMessage, 'timestamp'> & { timestamp?: number }): Buffer {
  const p = Buffer.alloc(11 + msg.data.length);
  p.writeUInt8(msg.priority, 0);
  p.writeUIntLE(msg.pgn, 1, 3);
  p.writeUInt8(msg.destination, 4);
  p.writeUInt8(msg.source, 5);
  p.writeUInt32LE(msg.timestamp ?? 0, 6);
  p.writeUInt8(msg.data.length, 10);
  msg.data.copy(p, 11);
  return composeFrame(N2K_MSG_RECEIVED, p);
}

type State = 'start' | 'message' | 'escape';

/** Setzt beliebig zerstückelte Bytes aus der Schnittstelle zu N2K-Nachrichten zusammen. */
export class ActisenseDecoder {
  private state: State = 'start';
  private buf: number[] = [];
  /** Verworfene Rahmen (Prüfsumme/Länge) – für die Diagnose. */
  rejected = 0;

  constructor(private readonly onMessage: (m: N2kMessage) => void) {}

  push(chunk: Uint8Array): void {
    for (const c of chunk) this.byte(c);
  }

  private byte(c: number): void {
    if (this.state === 'escape') {
      if (c === ETX) {
        this.frame();
        this.state = 'start';
      } else if (c === STX) {
        this.buf = [];
        this.state = 'message';
      } else if (c === DLE) {
        this.store(c);
        this.state = 'message';
      } else {
        // DLE gefolgt von Unerwartetem: Rahmen verwerfen und neu synchronisieren
        this.buf = [];
        this.state = 'start';
      }
      return;
    }
    if (c === DLE) {
      this.state = 'escape';
      return;
    }
    if (this.state === 'message') this.store(c);
  }

  private store(c: number): void {
    if (this.buf.length < MAX_FRAME) this.buf.push(c);
  }

  private frame(): void {
    const b = this.buf;
    this.buf = [];
    if (b[0] !== N2K_MSG_RECEIVED) return; // Antworten des Gateways (0xA0) o. Ä.
    const len = b[1] ?? 0;
    if (len < 11 || b.length !== len + 3) {
      this.rejected++;
      return;
    }
    if ((b.reduce((a, x) => a + x, 0) & 0xff) !== 0) {
      this.rejected++;
      return;
    }
    const p = Buffer.from(b.slice(2, 2 + len));
    const dataLen = p.readUInt8(10);
    if (11 + dataLen > p.length) {
      this.rejected++;
      return;
    }
    this.onMessage({
      priority: p.readUInt8(0),
      pgn: p.readUIntLE(1, 3),
      destination: p.readUInt8(4),
      source: p.readUInt8(5),
      timestamp: p.readUInt32LE(6),
      data: p.subarray(11, 11 + dataLen),
    });
  }
}
