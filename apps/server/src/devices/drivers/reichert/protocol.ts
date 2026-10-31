/**
 * Textprotokoll der Reichert ZBE (Zentrale Bedieneinheit für Funkgeräte).
 *
 * Zeilenbasiert über TCP, UTF-8, Zeilenende CRLF. Das Protokoll ist nicht öffentlich dokumentiert; Aufbau und
 * Feldbedeutungen sind rekonstruiert (siehe docs/fahrzeugmodule/funk-reichert-zbe.md) und an einigen Stellen
 * unsicher – deshalb parst ELVIS tolerant und meldet Unbekanntes als allgemeines Ereignis statt es zu verwerfen.
 */

export const DEFAULT_PORT = 1234;

/** Anmeldung nach dem Verbindungsaufbau */
export function loginLines(username: string, password: string, clientNumber: number): string[] {
  return [`login ${username} ${password}`, `context client ${clientNumber}`, 'main.action.login 0'];
}

export function sdsLine(fug: number, issi: string, text: string, flash = false): string {
  return `RADIO.ACTION.SM_SEND.${fug} "${issi}" "${flash ? 'FLASH' : 'TEXT'}|${text.replace(/["\r\n]/g, ' ')}"`;
}

export function gpsRequestLine(fug: number, issi: string): string {
  return `RADIO.ACTION.GPS_REQUEST.${fug} 0 "${issi}"`;
}

/** TETRA-Statuscodes nach BDBOS: 0x8002 = Status 0 … 0x800B = Status 9 */
export function statusFromCode(code: number): number | null {
  return code >= 0x8002 && code <= 0x800b ? code - 0x8002 : null;
}

export function statusToCode(status: number): number {
  return 0x8002 + status;
}

/**
 * TSI (MCC 262 + MNC 1001 + ISSI, 15 Stellen) auf die ISSI kürzen; andere Kennungen bleiben unverändert.
 */
export function normalizeIssi(id: string): string {
  const t = id.trim();
  if (/^262\d{12}$/.test(t)) return String(Number(t.slice(7)));
  return t;
}

export type ZbeEvent =
  | {
      type: 'sds';
      fug: number | null;
      from: string;
      to: string | null;
      flash: boolean;
      text: string;
    }
  | {
      type: 'status';
      fug: number | null;
      from: string;
      to: string | null;
      code: number;
      status: number | null;
    }
  | { type: 'gps'; fug: number | null; from: string; lat: number; lon: number }
  | {
      type: 'event';
      fug: number | null;
      name: string;
      from: string | null;
      raw: string;
    };

const EVENT_RE = /RADIO\.EVENT\.([A-Z0-9_]+)(?:\.(\d+))?/;

function quoted(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

/** Eine empfangene Zeile auswerten; null für Zeilen ohne RADIO.EVENT (z. B. Antworten auf die Anmeldung). */
export function parseLine(raw: string): ZbeEvent | null {
  const line = raw.replace(/\r$/, '');
  const m = EVENT_RE.exec(line);
  if (!m) return null;
  const name = m[1]!;
  const fug = m[2] !== undefined ? Number(m[2]) : null;
  const fields = quoted(line);
  const from = fields[0] !== undefined ? normalizeIssi(fields[0]) : null;

  if (name === 'SM_RECEIVED' && from) {
    // "<Absender>" "<Ziel>" "<Typ>|<Inhalt>" …
    const payload = fields.length >= 3 ? fields[2]! : (fields[fields.length - 1] ?? '');
    const to = fields.length >= 3 ? normalizeIssi(fields[1]!) || null : null;
    const bar = payload.indexOf('|');
    const kind = bar > 0 && bar <= 8 ? payload.slice(0, bar).toUpperCase() : '';
    const content = bar > 0 && bar <= 8 ? payload.slice(bar + 1) : payload;
    if (kind === 'STATUS') {
      // dezimal (z. B. 32771 = 0x8003); hexadezimal nur mit Präfix „$“ bzw. „0x“ oder mit Buchstaben
      const c = content.trim();
      const hex = /^(\$|0x)/i.test(c) || /^[0-9]*[a-f][0-9a-f]*$/i.test(c);
      const code = hex ? parseInt(c.replace(/^(\$|0x)/i, ''), 16) : parseInt(c, 10);
      if (Number.isFinite(code))
        return {
          type: 'status',
          fug,
          from,
          to,
          code,
          status: statusFromCode(code),
        };
    }
    if (kind === 'FMS' && content.length >= 11 && content[10] === '0' && /\d/.test(content[8]!)) {
      const status = Number(content[8]);
      return {
        type: 'status',
        fug,
        from,
        to,
        code: statusToCode(status),
        status,
      };
    }
    if (kind === 'TEXT' || kind === 'FLASH' || kind === '') {
      if (!content.trim()) return null;
      return {
        type: 'sds',
        fug,
        from,
        to,
        flash: kind === 'FLASH',
        text: content,
      };
    }
    return { type: 'event', fug, name: `SDS ${kind}`, from, raw: line };
  }

  if (name === 'GPS_DATA' && from) {
    // "<ISSI>" danach Breite und Länge (Dezimalpunkt), ggf. mit vorangestelltem Kennzeichen
    const rest = line.slice(line.indexOf(`"${fields[0]}"`) + fields[0]!.length + 2);
    const nums = [...rest.matchAll(/-?\d+\.\d+/g)].map((x) => Number(x[0]));
    const [lat, lon] = nums;
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { type: 'gps', fug, from, lat, lon };
  }

  return { type: 'event', fug, name, from, raw: line };
}

/** Puffert einen TCP-Datenstrom und liefert vollständige Zeilen. */
export class LineSplitter {
  private buffer = '';
  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    // Schutz vor endlosen Zeilen ohne Umbruch
    if (this.buffer.length > 64_000) this.buffer = '';
    return parts.map((p) => p.replace(/\r$/, '')).filter((p) => p.length > 0);
  }
}
