import type { GsmTrunkStatus } from '@elvis/shared';

/**
 * Yeastar TG API (NeoGate TG100/TG200/TG400/TG800/TG1600): TCP, Standard-Port 5038, Textprotokoll im Stil des
 * Asterisk Manager Interface. Jede Nachricht besteht aus Zeilen „Schlüssel: Wert“ und endet mit einer Leerzeile.
 * Antworten auf „SMSCommand“ kommen als „Response: Follows“ mit Freitext bis „--END COMMAND--“.
 *
 * Am TG200 (Firmware 2024) erlaubt der API-Benutzer nur SMSCommand, Events, Ping, Login/Logoff, ListCommands und
 * WaitEvent. „Command“, „SIPpeers“ und „Status“ lehnt das Gateway ab – SIP-Zustand und Anrufliste gibt es darüber nicht.
 */

export const DEFAULT_PORT = 5038;

export interface AmiMessage {
  /** Schlüssel in Kleinbuchstaben */
  fields: Record<string, string>;
  /** Freitext einer „Response: Follows“ ohne Endmarke */
  output: string[];
}

/** Zerlegt den Datenstrom in Nachrichten (Banner „Asterisk Call Manager/1.1“ wird übersprungen). */
export class AmiParser {
  private buffer = '';
  private lines: string[] = [];
  private follows = false;

  push(chunk: string): AmiMessage[] {
    this.buffer += chunk;
    const out: AmiMessage[] = [];
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private line(line: string): AmiMessage | null {
    if (this.follows) {
      // Die Endmarke steht manchmal direkt hinter der letzten Zeile („… AT+CSQ\r\n--END COMMAND--“)
      const end = line.indexOf('--END COMMAND--');
      if (end < 0) {
        this.lines.push(line);
        return null;
      }
      const rest = line.slice(0, end).replace(/\\r\\n$/, '');
      if (rest) this.lines.push(rest);
      this.follows = false;
      return null;
    }
    if (line === '') {
      if (!this.lines.length) return null;
      return this.flush();
    }
    if (this.lines.length === 0 && /^Asterisk Call Manager/i.test(line)) return null;
    this.lines.push(line);
    if (/^Response:\s*Follows$/i.test(line)) this.follows = true;
    return null;
  }

  private flush(): AmiMessage {
    const fields: Record<string, string> = {};
    const output: string[] = [];
    let follows = false;
    for (const l of this.lines) {
      const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(l);
      if (m && !(follows && fields.privilege !== undefined)) {
        const key = m[1]!.toLowerCase();
        if (fields[key] === undefined) fields[key] = m[2]!;
        if (key === 'response' && /^follows$/i.test(m[2]!)) follows = true;
      } else {
        output.push(l);
      }
    }
    this.lines = [];
    return { fields, output };
  }
}

/** Aktion als Text, Werte ohne Zeilenumbrüche */
export function action(name: string, fields: Record<string, string | number> = {}): string {
  const lines = [`Action: ${name}`, ...Object.entries(fields).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`)];
  return `${lines.join('\r\n')}\r\n\r\n`;
}

// --- GSM-Status ---

/** Span der TG-API zum Port des Gateways: Span 2 = Port 1 */
export const spanToPort = (span: number) => span - 1;
export const portToSpan = (port: number) => port + 1;

/** „GSM span 2: Power on, Up, Active, Standard“ */
export function parseSpans(output: string[]): { span: number; statusText: string }[] {
  const out: { span: number; statusText: string }[] = [];
  for (const l of output) {
    const m = /^\s*GSM span (\d+):\s*(.*?)\s*$/i.exec(l);
    if (m) out.push({ span: Number(m[1]), statusText: m[2]! });
  }
  return out;
}

export interface SpanDetail {
  statusText: string | null;
  model: string | null;
  imei: string | null;
  operator: string | null;
  registration: string | null;
  csq: number | null;
  ber: number | null;
  smsc: string | null;
  state: string | null;
}

/** Ausgabe von „gsm show span N“ */
export function parseSpanDetail(output: string[]): SpanDetail {
  const kv = new Map<string, string>();
  for (const l of output) {
    const m = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(l);
    if (m) kv.set(m[1]!.toLowerCase(), m[2]!);
  }
  const num = (k: string) => {
    const v = kv.get(k);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
  };
  const text = (k: string) => {
    const v = kv.get(k)?.trim();
    return v ? v : null;
  };
  const operator = text('network name');
  // „Telekom.de Telekom.de“: Lang- und Kurzname sind oft gleich
  const parts = operator?.split(/\s+/) ?? [];
  const half = parts.length % 2 === 0 ? parts.length / 2 : 0;
  const op = half && parts.slice(0, half).join(' ') === parts.slice(half).join(' ') ? parts.slice(0, half).join(' ') : operator;
  const csq = num('signal quality (0,31)');
  return {
    statusText: text('status'),
    model: [text('manufacturer'), text('model name')].filter(Boolean).join(' ') || null,
    imei: text('model imei'),
    operator: op,
    registration: text('network status'),
    csq: csq !== null && csq <= 31 ? csq : null,
    ber: num('ber value (0,7)'),
    smsc: text('sim sms center number'),
    state: text('state'),
  };
}

/** Zustand eines Trunks aus Statuszeile und Netzregistrierung */
export function trunkStatus(statusText: string | null, registration: string | null): GsmTrunkStatus {
  if (!statusText) return 'unknown';
  const s = statusText.toLowerCase();
  if (/sim/.test(s) && /(undetected|no sim|not insert|absent)/.test(s)) return 'no-sim';
  if (/power off/.test(s) || /\bdown\b/.test(s)) return 'down';
  const reg = registration?.toLowerCase() ?? '';
  if (/\bup\b/.test(s) && /active/.test(s)) {
    if (!reg || /^registered/.test(reg)) return 'up';
    return /search|not registered/.test(reg) ? 'searching' : 'down';
  }
  return 'searching';
}

export const signalPercent = (csq: number | null) => (csq === null ? null : Math.round((csq / 31) * 100));
export const rssiDbm = (csq: number | null) => (csq === null ? null : -113 + 2 * csq);

// --- SMS ---

/** Text in Anführungszeichen für „gsm send sms“; Zeilenumbrüche als „\n“ */
export function quoteSms(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

export function sendSmsCommand(span: number, number: string, text: string, id: string): string {
  return `gsm send sms ${span} ${number.replace(/[^\d+*#]/g, '')} ${quoteSms(text)} ${id}`;
}

/**
 * Inhalt einer empfangenen SMS ist URL-kodiert (Leerzeichen als „+“). Je nach Absender stehen die Bytes für UTF-8 oder
 * Latin-1 („f%FCr“) – erst UTF-8 versuchen, sonst Latin-1. Ein Byte-Order-Mark am Anfang fällt weg.
 */
export function decodeContent(v: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    const hex = c === '%' ? v.slice(i + 1, i + 3) : '';
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (c === '+') bytes.push(0x20);
    else for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
  }
  const buf = Buffer.from(bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = buf.toString('latin1');
  }
  return text.replace(/^\uFEFF/, '');
}

export interface ReceivedSms {
  id: string;
  span: number;
  sender: string;
  /** Teil x von total (mehrteilige SMS) */
  index: number;
  total: number;
  text: string;
}

export function parseReceivedSms(f: Record<string, string>): ReceivedSms | null {
  const span = Number(f.gsmspan ?? f.span);
  const sender = (f.sender ?? '').trim();
  if (!Number.isFinite(span) || !sender) return null;
  const index = Number(f.index) || 1;
  const total = Number(f.total) || 1;
  return { id: f.id ?? '', span, sender, index, total, text: decodeContent(f.content ?? '') };
}

/** Sendebestätigung („UpdateSMS“/„UpdateSMSSend“): Smsstatus 1 = gesendet */
export function parseSmsUpdate(f: Record<string, string>): { id: string; ok: boolean } | null {
  if (!f.id) return null;
  const status = f.smsstatus ?? f.status ?? '';
  return { id: f.id.trim(), ok: status.trim() === '1' || /success/i.test(status) };
}

// --- Gespräche (Kanal-Ereignisse) ---

/** Port eines GSM-Kanals aus dem Kanalnamen („extra/2-1“, „GSM/2“, „gsm-2“) – SIP-Kanäle ergeben null */
export function channelSpan(channel: string): number | null {
  if (/^sip\//i.test(channel)) return null;
  const m = /^(?:extra|gsm|dahdi|zap)[/-](\d+)/i.exec(channel);
  return m ? Number(m[1]) : null;
}
