/**
 * Textprotokoll der Reichert ZBE (Zentrale Bedieneinheit für bis zu 20 Funkgeräte, TETRA und analog).
 *
 * Zeilenbasiert über TCP, UTF-8, Zeilenende CRLF. Das Protokoll ist nicht öffentlich dokumentiert; Aufbau und
 * Feldbedeutungen sind rekonstruiert (siehe docs/fahrzeugmodule/funk-reichert-zbe.md). Bekannte Clients schreiben die
 * Felder teils mit Komma, teils mit Leerzeichen getrennt – ELVIS liest beides und meldet Unbekanntes als allgemeines
 * Ereignis statt es zu verwerfen.
 *
 * Telegramme tragen den Anschluss der ZBE als Suffix, ab 0 gezählt: `RADIO.EVENT.SM_RECEIVED.0` = Anschluss 1.
 */

export const DEFAULT_PORT = 9001;
/** Zugangsdaten, wenn an der ZBE nichts Eigenes eingerichtet ist */
export const DEFAULT_LOGIN = 'api';
/** Höchstzahl der Anschlüsse einer ZBE */
export const MAX_PORTS = 20;
/** Lebenszeichen des Clients */
export const PING = 'ping';

/** Trennzeichen der Parameter in gesendeten Telegrammen */
export type ZbeStyle = 'comma' | 'space';

/** Anmeldung nach dem Verbindungsaufbau */
export function loginLines(username: string, password: string, clientNumber: number, style: ZbeStyle = 'comma'): string[] {
  const user = username || DEFAULT_LOGIN;
  const pass = password || DEFAULT_LOGIN;
  return [`login ${user} ${pass}`, `context client ${clientNumber}`, style === 'comma' ? 'main.action.login.-1,1' : 'main.action.login 0'];
}

const sep = (style: ZbeStyle) => (style === 'comma' ? ',' : ' ');
const clean = (s: string) => s.replace(/["\r\n]/g, ' ');

/** SDS an eine ISSI über den Anschluss (0-basiert im Telegramm) */
export function sdsLine(portIndex: number, issi: string, text: string, flash = false, style: ZbeStyle = 'comma'): string {
  return `RADIO.ACTION.SM_SEND.${portIndex}${sep(style)}"${issi}"${sep(style)}"${flash ? 'FLASH' : 'TEXT'}|${clean(text)}"`;
}

export function gpsRequestLine(portIndex: number, issi: string, style: ZbeStyle = 'comma'): string {
  return `RADIO.ACTION.GPS_REQUEST.${portIndex}${sep(style)}0${sep(style)}"${issi}"`;
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

/** Meldungen der Anlage selbst (Konfiguration, Lebenszeichen, Bedienteil) – für ELVIS ohne Bedeutung */
const SYSTEM_EVENTS = [
  'CONFIG_LINE',
  'STATION',
  'WATCHDOG',
  'BUSY',
  'FACTORY_INFO',
  'RUNTIME_INFO',
  'CSPTSS',
  'E2EE',
  'VOLUME',
  'SELECT',
  'ACTIVATE',
  'CHECKIN_CNF',
  'DISPLAY',
];
const SYSTEM_RE = new RegExp(`(^|\\.)(${SYSTEM_EVENTS.join('|')})\\.`);

/** `port` ist der Anschluss ab 0 (Suffix im Telegramm); null, wenn das Telegramm keinen trägt */
export type ZbeEvent =
  | { type: 'sds'; port: number | null; from: string; to: string | null; flash: boolean; text: string }
  | { type: 'status'; port: number | null; from: string; to: string | null; code: number; status: number | null }
  | { type: 'gps'; port: number | null; from: string; lat: number; lon: number }
  /** Aufzeichnungsinfo: wer gerade spricht (TSI/ISSI); kommt vor bzw. mit SPEAK */
  | { type: 'speaker'; port: number | null; speaker: string | null; call: string | null }
  /** Es wird gesprochen (Sprecher aus der vorangehenden Aufzeichnungsinfo) */
  | { type: 'speak'; port: number | null }
  | { type: 'event'; port: number | null; name: string; from: string | null; raw: string };

const EVENT_RE = /RADIO\.EVENT\.([A-Z0-9_]+)(?:\.(-?\d+))?/;

/**
 * Felder nach dem Ereignisnamen: getrennt durch Komma oder Leerzeichen außerhalb von Anführungszeichen,
 * Anführungszeichen entfernt. Ein Feld in Anführungszeichen darf Komma und Leerzeichen enthalten.
 */
export function tokenize(rest: string): string[] {
  // Komma-Modus, sobald ein Komma außerhalb von Anführungszeichen steht
  let quoted = false;
  let commaMode = false;
  for (const ch of rest) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) commaMode = true;
  }
  const tokens: string[] = [];
  let cur = '';
  let had = false;
  quoted = false;
  const push = () => {
    if (commaMode || had) tokens.push(commaMode ? cur.trim() : cur);
    cur = '';
    had = false;
  };
  for (const ch of rest) {
    if (ch === '"') {
      quoted = !quoted;
      had = true;
    } else if (!quoted && (commaMode ? ch === ',' : /\s/.test(ch))) push();
    else {
      cur += ch;
      had = true;
    }
  }
  if (had || (commaMode && tokens.length > 0)) push();
  // im Komma-Modus steht das erste Komma direkt hinter dem Ereignisnamen
  if (commaMode && tokens[0] === '' && /^\s*,/.test(rest)) tokens.shift();
  return tokens;
}

const PAYLOAD_RE = /^([A-Z0-9_]{2,8})\|/i;

/** Eine empfangene Zeile auswerten; null für Zeilen ohne Bedeutung (Anmeldeantworten, Anlagenmeldungen, Kommentare). */
export function parseLine(raw: string): ZbeEvent | null {
  const line = raw.replace(/\r$/, '');
  if (line.trimStart().startsWith('#')) return null;
  if (SYSTEM_RE.test(line.split(/[\s,]/)[0] ?? '')) return null;
  const m = EVENT_RE.exec(line);
  if (!m) return null;
  const name = m[1]!;
  const port = m[2] !== undefined && Number(m[2]) >= 0 ? Number(m[2]) : null;
  const tokens = tokenize(line.slice(m.index + m[0].length));

  if (name === 'SPEAK') return { type: 'speak', port };

  if (name === 'DOKU_REC_INFO') {
    // drittes Feld „<Ruf>-<Sprecher>“; der Sprecher kommt als TSI oder ISSI
    const info = tokens[2] ?? tokens.find((t) => t.includes('-')) ?? '';
    if (info.length <= 3) return { type: 'speaker', port, speaker: null, call: null };
    const dash = info.indexOf('-');
    const speaker = normalizeIssi(dash >= 0 ? info.slice(dash + 1) : info);
    const call = dash > 0 ? normalizeIssi(info.slice(0, dash)) : null;
    return { type: 'speaker', port, speaker: /^\d{1,15}$/.test(speaker) ? speaker : null, call };
  }

  if (name === 'SM_RECEIVED') {
    // …, "<Absender>", "<Ziel>", "<Typ>|<Inhalt>" – der Absender steht zwei Felder vor der Nutzlast
    let p = tokens.findIndex((t) => PAYLOAD_RE.test(t));
    if (p < 0) p = Math.min(2, tokens.length - 1);
    const from = normalizeIssi(tokens[p - 2] ?? tokens[0] ?? '');
    const toRaw = p >= 2 ? tokens[p - 1] : undefined;
    const to = toRaw ? normalizeIssi(toRaw) || null : null;
    const payload = tokens[p] ?? '';
    if (!from) return { type: 'event', port, name, from: null, raw: line };
    const bar = PAYLOAD_RE.exec(payload);
    const kind = bar ? bar[1]!.toUpperCase() : '';
    const content = bar ? payload.slice(bar[0].length) : payload;
    if (kind === 'STATUS') {
      // dezimal (z. B. 32771 = 0x8003); hexadezimal nur mit Präfix „$“, „&H“ bzw. „0x“ oder mit Buchstaben
      const c = content.trim();
      const hex = /^(\$|0x|&H)/i.test(c) || /^[0-9]*[a-f][0-9a-f]*$/i.test(c);
      const code = hex ? parseInt(c.replace(/^(\$|0x|&H)/i, ''), 16) : parseInt(c, 10);
      if (Number.isFinite(code)) return { type: 'status', port, from, to, code, status: statusFromCode(code) };
    }
    if (kind === 'FMS' && content.length >= 11 && content[10] === '0' && /\d/.test(content[8]!)) {
      const status = Number(content[8]);
      return { type: 'status', port, from, to, code: statusToCode(status), status };
    }
    if (kind === 'TEXT' || kind === 'FLASH' || kind === '') {
      if (!content.trim()) return null;
      return { type: 'sds', port, from, to, flash: kind === 'FLASH', text: content };
    }
    return { type: 'event', port, name: `SDS ${kind}`, from, raw: line };
  }

  const first = tokens[0] ? normalizeIssi(tokens[0]) : null;

  if (name === 'GPS_DATA' && first) {
    // "<ISSI>", Kennzeichen, Breite, Länge (Dezimalpunkt)
    const nums = tokens
      .slice(1)
      .filter((t) => /^-?\d+\.\d+$/.test(t.trim()))
      .map(Number);
    const [lat, lon] = nums;
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { type: 'gps', port, from: first, lat, lon };
  }

  return { type: 'event', port, name, from: first && /^\d+$/.test(first) ? first : null, raw: line };
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
