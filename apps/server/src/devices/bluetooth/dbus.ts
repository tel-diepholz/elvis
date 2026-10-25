import { EventEmitter } from 'node:events';
import { connect as netConnect, type Socket } from 'node:net';

/**
 * Kleiner D-Bus-Client (System-Bus über Unix-Socket) – gerade genug für BlueZ: Anmelden, Methoden aufrufen,
 * Signale empfangen. Wire-Format nach der D-Bus-Spezifikation (dbus.freedesktop.org/doc/dbus-specification.html).
 *
 * Werte: Zahlen (64 Bit als bigint), Strings, Buffer (ay), Arrays, Objekte (Dictionaries; Schlüssel als String),
 * Strukturen als Arrays. Variants werden beim Lesen ausgepackt, beim Schreiben als `new Variant(sig, wert)` angegeben.
 */

export class Variant {
  constructor(
    readonly signature: string,
    readonly value: unknown,
  ) {}
}

export class DbusError extends Error {
  constructor(
    override readonly name: string,
    message: string,
  ) {
    super(message || name);
  }
}

const ALIGN: Record<string, number> = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, '(': 8, '{': 8, v: 1, h: 4 };

/** Länge des ersten vollständigen Typs in `sig` ab `pos` */
function typeEnd(sig: string, pos: number): number {
  const c = sig[pos];
  if (c === undefined) throw new Error(`D-Bus: Signatur „${sig}“ unvollständig`);
  if (c === 'a') return typeEnd(sig, pos + 1);
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}';
    let p = pos + 1;
    while (sig[p] !== close) p = typeEnd(sig, p);
    return p + 1;
  }
  if (!(c in ALIGN)) throw new Error(`D-Bus: unbekannter Typ „${c}“`);
  return pos + 1;
}

/** Signatur in vollständige Einzeltypen zerlegen */
export function splitSignature(sig: string): string[] {
  const out: string[] = [];
  for (let p = 0; p < sig.length; ) {
    const end = typeEnd(sig, p);
    out.push(sig.slice(p, end));
    p = end;
  }
  return out;
}

// --- Schreiben (immer little endian) ---

class Writer {
  private buf = Buffer.alloc(256);
  length = 0;

  constructor(private readonly offset = 0) {}

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.length + n));
    this.buf.copy(next, 0, 0, this.length);
    this.buf = next;
  }

  align(n: number): void {
    const pad = (n - ((this.offset + this.length) % n)) % n;
    this.ensure(pad);
    this.buf.fill(0, this.length, this.length + pad);
    this.length += pad;
  }

  raw(b: Buffer): void {
    this.ensure(b.length);
    b.copy(this.buf, this.length);
    this.length += b.length;
  }

  private num(size: number, fn: (b: Buffer, at: number) => void): void {
    this.align(size);
    this.ensure(size);
    fn(this.buf, this.length);
    this.length += size;
  }

  write(type: string, value: unknown): void {
    switch (type[0]) {
      case 'y':
        return this.num(1, (b, at) => b.writeUInt8(Number(value), at));
      case 'b':
        return this.num(4, (b, at) => b.writeUInt32LE(value ? 1 : 0, at));
      case 'n':
        return this.num(2, (b, at) => b.writeInt16LE(Number(value), at));
      case 'q':
        return this.num(2, (b, at) => b.writeUInt16LE(Number(value), at));
      case 'i':
        return this.num(4, (b, at) => b.writeInt32LE(Number(value), at));
      case 'u':
      case 'h':
        return this.num(4, (b, at) => b.writeUInt32LE(Number(value), at));
      case 'x':
        return this.num(8, (b, at) => b.writeBigInt64LE(BigInt(value as number), at));
      case 't':
        return this.num(8, (b, at) => b.writeBigUInt64LE(BigInt(value as number), at));
      case 'd':
        return this.num(8, (b, at) => b.writeDoubleLE(Number(value), at));
      case 's':
      case 'o': {
        const s = Buffer.from(String(value), 'utf8');
        this.write('u', s.length);
        this.raw(Buffer.concat([s, Buffer.from([0])]));
        return;
      }
      case 'g': {
        const s = Buffer.from(String(value), 'utf8');
        this.write('y', s.length);
        this.raw(Buffer.concat([s, Buffer.from([0])]));
        return;
      }
      case 'v': {
        const v = value as Variant;
        if (!(v instanceof Variant)) throw new Error('D-Bus: Variant erwartet');
        this.write('g', v.signature);
        this.write(v.signature, v.value);
        return;
      }
      case '(': {
        this.align(8);
        const parts = splitSignature(type.slice(1, -1));
        const values = value as unknown[];
        parts.forEach((t, i) => this.write(t, values[i]));
        return;
      }
      case 'a': {
        const elem = type.slice(1);
        this.write('u', 0);
        const lengthAt = this.length - 4;
        this.align(ALIGN[elem[0]!]!);
        const start = this.length;
        if (elem[0] === 'y' && Buffer.isBuffer(value)) this.raw(value);
        else if (elem[0] === '{') {
          const [kt, vt] = splitSignature(elem.slice(1, -1)) as [string, string];
          const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
          for (const [k, v] of entries) {
            this.align(8);
            this.write(kt, 'nqiuxtdy'.includes(kt) ? Number(k) : k);
            this.write(vt, v);
          }
        } else for (const v of value as unknown[]) this.write(elem, v);
        this.buf.writeUInt32LE(this.length - start, lengthAt);
        return;
      }
      default:
        throw new Error(`D-Bus: Typ „${type}“ wird nicht unterstützt`);
    }
  }

  result(): Buffer {
    return this.buf.subarray(0, this.length);
  }
}

// --- Lesen ---

class Reader {
  pos = 0;
  constructor(
    private readonly buf: Buffer,
    private readonly le: boolean,
    private readonly offset = 0,
  ) {}

  align(n: number): void {
    this.pos += (n - ((this.offset + this.pos) % n)) % n;
  }

  private num<T>(size: number, le: (at: number) => T, be: (at: number) => T): T {
    this.align(size);
    if (this.pos + size > this.buf.length) throw new Error('D-Bus: Nachricht zu kurz');
    const v = this.le ? le(this.pos) : be(this.pos);
    this.pos += size;
    return v;
  }

  read(type: string): unknown {
    const b = this.buf;
    switch (type[0]) {
      case 'y':
        return this.num(1, (at) => b.readUInt8(at), (at) => b.readUInt8(at));
      case 'b':
        return this.read('u') !== 0;
      case 'n':
        return this.num(2, (at) => b.readInt16LE(at), (at) => b.readInt16BE(at));
      case 'q':
        return this.num(2, (at) => b.readUInt16LE(at), (at) => b.readUInt16BE(at));
      case 'i':
        return this.num(4, (at) => b.readInt32LE(at), (at) => b.readInt32BE(at));
      case 'u':
      case 'h':
        return this.num(4, (at) => b.readUInt32LE(at), (at) => b.readUInt32BE(at));
      case 'x':
        return this.num(8, (at) => b.readBigInt64LE(at), (at) => b.readBigInt64BE(at));
      case 't':
        return this.num(8, (at) => b.readBigUInt64LE(at), (at) => b.readBigUInt64BE(at));
      case 'd':
        return this.num(8, (at) => b.readDoubleLE(at), (at) => b.readDoubleBE(at));
      case 's':
      case 'o': {
        const len = this.read('u') as number;
        const s = b.toString('utf8', this.pos, this.pos + len);
        this.pos += len + 1;
        return s;
      }
      case 'g': {
        const len = this.read('y') as number;
        const s = b.toString('utf8', this.pos, this.pos + len);
        this.pos += len + 1;
        return s;
      }
      case 'v':
        return this.read(this.read('g') as string);
      case '(': {
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((t) => this.read(t));
      }
      case 'a': {
        const elem = type.slice(1);
        const len = this.read('u') as number;
        this.align(ALIGN[elem[0]!]!);
        const end = this.pos + len;
        if (end > b.length) throw new Error('D-Bus: Nachricht zu kurz');
        if (elem[0] === 'y') {
          const out = Buffer.from(b.subarray(this.pos, end));
          this.pos = end;
          return out;
        }
        if (elem[0] === '{') {
          const [kt, vt] = splitSignature(elem.slice(1, -1)) as [string, string];
          const out: Record<string, unknown> = {};
          while (this.pos < end) {
            this.align(8);
            const k = this.read(kt);
            out[String(k)] = this.read(vt);
          }
          return out;
        }
        const out: unknown[] = [];
        while (this.pos < end) out.push(this.read(elem));
        return out;
      }
      default:
        throw new Error(`D-Bus: Typ „${type}“ wird nicht unterstützt`);
    }
  }
}

// --- Nachrichten ---

export interface DbusMessage {
  type: 'call' | 'return' | 'error' | 'signal';
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature: string;
  body: unknown[];
}

const TYPES = ['call', 'return', 'error', 'signal'] as const;
const FIELD = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 } as const;
const FIELD_SIG: Record<number, string> = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g' };

export function encodeMessage(m: Omit<DbusMessage, 'body' | 'signature'> & { signature?: string; body?: unknown[] }): Buffer {
  const signature = m.signature ?? '';
  const body = new Writer();
  splitSignature(signature).forEach((t, i) => body.write(t, m.body?.[i]));
  const fields: [number, Variant][] = [];
  for (const [key, code] of Object.entries(FIELD) as [keyof typeof FIELD, number][]) {
    const v = key === 'signature' ? (signature || undefined) : m[key];
    if (v !== undefined) fields.push([code, new Variant(FIELD_SIG[code]!, v)]);
  }
  const head = new Writer();
  head.write('y', 'l'.charCodeAt(0));
  head.write('y', TYPES.indexOf(m.type) + 1);
  head.write('y', m.type === 'call' ? 0 : 1); // Rückgabe nur bei Methodenaufrufen erwartet
  head.write('y', 1);
  head.write('u', body.length);
  head.write('u', m.serial);
  head.write('a(yv)', fields);
  head.align(8);
  return Buffer.concat([head.result(), body.result()]);
}

/** Länge der ersten vollständigen Nachricht im Puffer oder null, wenn sie noch nicht ganz da ist */
export function messageLength(buf: Buffer): number | null {
  if (buf.length < 16) return null;
  const le = buf[0] === 0x6c;
  const bodyLen = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLen = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerLen = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8);
  const total = headerLen + bodyLen;
  return buf.length >= total ? total : null;
}

export function decodeMessage(buf: Buffer): DbusMessage {
  const le = buf[0] === 0x6c;
  if (!le && buf[0] !== 0x42) throw new Error('D-Bus: ungültige Byte-Reihenfolge');
  const head = new Reader(buf, le);
  head.pos = 4;
  const bodyLen = head.read('u') as number;
  const serial = head.read('u') as number;
  const fields = head.read('a(yv)') as [number, unknown][];
  head.align(8);
  const m: DbusMessage = { type: TYPES[buf[1]! - 1] ?? 'signal', serial, signature: '', body: [] };
  for (const [code, value] of fields) {
    const key = (Object.keys(FIELD) as (keyof typeof FIELD)[]).find((k) => FIELD[k] === code);
    if (key) (m as unknown as Record<string, unknown>)[key] = value;
  }
  const body = new Reader(buf.subarray(head.pos, head.pos + bodyLen), le);
  m.body = splitSignature(m.signature).map((t) => body.read(t));
  return m;
}

// --- Verbindung ---

/** Adresse des System-Busses: DBUS_SYSTEM_BUS_ADDRESS (unix:path=…) oder der Standard-Socket */
export function systemBusPath(env: NodeJS.ProcessEnv = process.env): string {
  const m = /(?:^|;)unix:path=([^,;]+)/.exec(env.DBUS_SYSTEM_BUS_ADDRESS ?? '');
  return m?.[1] ?? '/run/dbus/system_bus_socket';
}

export interface CallOptions {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: unknown[];
  timeoutMs?: number;
}

export class DbusConnection extends EventEmitter<{ signal: [DbusMessage]; close: [Error | null] }> {
  private serial = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (body: unknown[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    const end = (err: Error | null) => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err ?? new Error('D-Bus-Verbindung getrennt'));
      }
      this.pending.clear();
      this.emit('close', err);
    };
    socket.on('error', end);
    socket.on('close', () => end(null));
  }

  /** Mit dem Bus verbinden, anmelden (EXTERNAL, Benutzer-ID des Prozesses) und Hello senden */
  static connect(path = systemBusPath(), timeoutMs = 5_000): Promise<DbusConnection> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`D-Bus: keine Antwort von ${path}`));
      }, timeoutMs);
      let auth = '';
      const fail = (err: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      socket.once('error', (err: NodeJS.ErrnoException) =>
        fail(new Error(err.code === 'ENOENT' ? `D-Bus-Socket ${path} fehlt` : err.code === 'EACCES' ? `Kein Zugriff auf ${path}` : `D-Bus: ${err.message}`)),
      );
      socket.once('connect', () => {
        const uid = Buffer.from(String(process.getuid?.() ?? 0)).toString('hex');
        socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
      });
      const onAuth = (chunk: Buffer) => {
        auth += chunk.toString('latin1');
        if (!auth.includes('\r\n')) return;
        socket.off('data', onAuth);
        if (!auth.startsWith('OK ')) return fail(new Error(`D-Bus: Anmeldung abgelehnt (${auth.trim()})`));
        socket.write('BEGIN\r\n');
        clearTimeout(timer);
        socket.removeAllListeners('error');
        const conn = new DbusConnection(socket);
        conn
          .call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'Hello' })
          .then(() => resolve(conn), fail);
      };
      socket.on('data', onAuth);
    });
  }

  call(o: CallOptions): Promise<unknown[]> {
    if (this.closed) return Promise.reject(new Error('D-Bus-Verbindung getrennt'));
    const serial = this.serial++;
    const msg = encodeMessage({ type: 'call', serial, destination: o.destination, path: o.path, interface: o.interface, member: o.member, signature: o.signature, body: o.body });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new Error(`D-Bus: ${o.interface}.${o.member} antwortet nicht`));
      }, o.timeoutMs ?? 10_000);
      this.pending.set(serial, { resolve, reject, timer });
      this.socket.write(msg);
    });
  }

  /** Signale abonnieren, z. B. "type='signal',sender='org.bluez'" */
  addMatch(rule: string): Promise<unknown[]> {
    return this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (let len = messageLength(this.buffer); len !== null; len = messageLength(this.buffer)) {
      const raw = this.buffer.subarray(0, len);
      this.buffer = this.buffer.subarray(len);
      let m: DbusMessage;
      try {
        m = decodeMessage(raw);
      } catch {
        continue; // unlesbare Nachricht überspringen
      }
      if ((m.type === 'return' || m.type === 'error') && m.replySerial !== undefined) {
        const p = this.pending.get(m.replySerial);
        if (!p) continue;
        this.pending.delete(m.replySerial);
        clearTimeout(p.timer);
        if (m.type === 'return') p.resolve(m.body);
        else p.reject(new DbusError(m.errorName ?? 'org.freedesktop.DBus.Error.Failed', typeof m.body[0] === 'string' ? m.body[0] : ''));
      } else if (m.type === 'signal') this.emit('signal', m);
    }
  }
}
