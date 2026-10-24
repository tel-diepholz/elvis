/**
 * Schlanker IPP-Client (RFC 8010/8011) für CUPS: nur die Operationen und Wertetypen, die ELVIS braucht.
 * IPP läuft per HTTP-POST mit Content-Type application/ipp; der Dokumentinhalt folgt direkt auf die Attribute.
 */

export const OP = {
  printJob: 0x0002,
  getJobAttributes: 0x0009,
  cupsGetPrinters: 0x4002,
} as const;

export const GROUP = { operation: 0x01, job: 0x02, end: 0x03, printer: 0x04, unsupported: 0x05 } as const;

export const TAG = {
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  endCollection: 0x37,
  textWithLanguage: 0x35,
  nameWithLanguage: 0x36,
  text: 0x41,
  name: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  language: 0x48,
  mimeType: 0x49,
  memberName: 0x4a,
} as const;

export type IppValue = string | number | boolean | [number, number];

export interface IppAttribute {
  tag: number;
  name: string;
  values: IppValue[];
}

export interface IppRequest {
  operation: number;
  requestId?: number;
  /** charset und natural-language setzt der Encoder selbst an den Anfang */
  operationAttributes: IppAttribute[];
  jobAttributes?: IppAttribute[];
  document?: Uint8Array;
}

export type IppGroup = Record<string, IppValue[]>;

export interface IppResponse {
  status: number;
  requestId: number;
  operation: IppGroup;
  /** je Drucker bzw. Auftrag eine Gruppe */
  printers: IppGroup[];
  jobs: IppGroup[];
  unsupported: IppGroup;
}

export const attr = (tag: number, name: string, ...values: IppValue[]): IppAttribute => ({ tag, name, values });

function encodeValue(tag: number, v: IppValue): Buffer {
  if (tag === TAG.integer || tag === TAG.enum) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v as number);
    return b;
  }
  if (tag === TAG.boolean) return Buffer.from([v ? 1 : 0]);
  if (tag === TAG.rangeOfInteger) {
    const [from, to] = v as [number, number];
    const b = Buffer.alloc(8);
    b.writeInt32BE(from);
    b.writeInt32BE(to, 4);
    return b;
  }
  return Buffer.from(String(v), 'utf8');
}

function encodeAttribute(a: IppAttribute): Buffer {
  const parts: Buffer[] = [];
  a.values.forEach((v, i) => {
    const name = i === 0 ? Buffer.from(a.name, 'utf8') : Buffer.alloc(0);
    const value = encodeValue(a.tag, v);
    const head = Buffer.alloc(3);
    head.writeUInt8(a.tag);
    head.writeUInt16BE(name.length, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(value.length);
    parts.push(head, name, len, value);
  });
  return Buffer.concat(parts);
}

/** IPP-Nachricht: Kopf mit Operation (Anfrage) bzw. Status (Antwort), Attributgruppen, optional Dokument */
export function encodeMessage(code: number, requestId: number, groups: { tag: number; attributes: IppAttribute[] }[], document?: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt8(2, 0); // IPP 2.0
  head.writeUInt8(0, 1);
  head.writeUInt16BE(code, 2);
  head.writeInt32BE(requestId, 4);
  const parts: Buffer[] = [head];
  for (const g of groups) {
    parts.push(Buffer.from([g.tag]));
    for (const a of g.attributes) parts.push(encodeAttribute(a));
  }
  parts.push(Buffer.from([GROUP.end]));
  if (document) parts.push(Buffer.from(document.buffer, document.byteOffset, document.byteLength));
  return Buffer.concat(parts);
}

export function encodeRequest(req: IppRequest): Buffer {
  const operation = [attr(TAG.charset, 'attributes-charset', 'utf-8'), attr(TAG.language, 'attributes-natural-language', 'de'), ...req.operationAttributes];
  const groups: { tag: number; attributes: IppAttribute[] }[] = [{ tag: GROUP.operation, attributes: operation }];
  if (req.jobAttributes?.length) groups.push({ tag: GROUP.job, attributes: req.jobAttributes });
  return encodeMessage(req.operation, req.requestId ?? 1, groups, req.document);
}

function decodeValue(tag: number, b: Buffer): IppValue {
  if ((tag === TAG.integer || tag === TAG.enum) && b.length === 4) return b.readInt32BE();
  if (tag === TAG.boolean && b.length === 1) return b[0] !== 0;
  if (tag === TAG.rangeOfInteger && b.length === 8) return [b.readInt32BE(), b.readInt32BE(4)];
  if (tag === TAG.textWithLanguage || tag === TAG.nameWithLanguage) {
    // Sprache (Länge + Text), dann Wert (Länge + Text)
    const langLen = b.readUInt16BE(0);
    const valueLen = b.readUInt16BE(2 + langLen);
    return b.subarray(4 + langLen, 4 + langLen + valueLen).toString('utf8');
  }
  // Ganzzahl-artige Typen ohne passende Länge sowie Oktettstrings (Auflösung, Datum …) nur als Hex
  if (tag < 0x40 && tag >= 0x30) return b.toString('hex');
  return b.toString('utf8');
}

export function decodeResponse(buf: Buffer): IppResponse {
  if (buf.length < 9) throw new Error('IPP-Antwort zu kurz');
  const res: IppResponse = { status: buf.readUInt16BE(2), requestId: buf.readInt32BE(4), operation: {}, printers: [], jobs: [], unsupported: {} };
  let group: IppGroup | null = null;
  let last: IppValue[] | null = null;
  // Sammlungen (z. B. media-col) überspringen – ELVIS fragt nur einfache Attribute ab
  let depth = 0;
  let pos = 8;
  while (pos < buf.length) {
    const tag = buf.readUInt8(pos++);
    if (tag === GROUP.end) break;
    if (tag <= 0x0f) {
      group = {};
      if (tag === GROUP.operation) res.operation = group;
      else if (tag === GROUP.printer) res.printers.push(group);
      else if (tag === GROUP.job) res.jobs.push(group);
      else if (tag === GROUP.unsupported) res.unsupported = group;
      last = null;
      continue;
    }
    if (pos + 2 > buf.length) throw new Error('IPP-Antwort abgeschnitten');
    const nameLen = buf.readUInt16BE(pos);
    pos += 2;
    const name = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen;
    const valueLen = buf.readUInt16BE(pos);
    pos += 2;
    const value = buf.subarray(pos, pos + valueLen);
    pos += valueLen;
    if (pos > buf.length) throw new Error('IPP-Antwort abgeschnitten');
    if (tag === TAG.begCollection) {
      depth++;
      if (depth === 1 && group && name) group[name] = last = [];
      continue;
    }
    if (tag === TAG.endCollection) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (!group) continue;
    // Außerbandwerte (unknown, no-value …) zählen nicht als Wert
    const v = tag >= 0x10 && tag <= 0x1f ? null : decodeValue(tag, value);
    if (name) {
      group[name] = last = v === null ? [] : [v];
    } else if (last && v !== null) last.push(v);
  }
  return res;
}

export const ippOk = (status: number) => status < 0x0100;

const STATUS_TEXT: Record<number, string> = {
  0x0400: 'Ungültige Anfrage',
  0x0401: 'Zugriff verweigert',
  0x0402: 'Anmeldung am Druckserver erforderlich',
  0x0403: 'Keine Berechtigung',
  0x0406: 'Drucker nicht gefunden',
  0x0407: 'Drucker nicht mehr vorhanden',
  0x040a: 'Dokumentformat wird nicht unterstützt',
  0x040b: 'Attribute oder Werte nicht unterstützt',
  0x0500: 'Interner Fehler des Druckservers',
  0x0506: 'Drucker nimmt keine Aufträge an',
  0x0507: 'Druckserver ausgelastet',
};

export function ippStatusText(status: number, message?: IppValue[]): string {
  const detail = message?.[0] ? ` (${String(message[0])})` : '';
  return `${STATUS_TEXT[status] ?? `IPP-Status 0x${status.toString(16).padStart(4, '0')}`}${detail}`;
}
