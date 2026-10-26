import { unzipSync, strFromU8 } from 'fflate';
import {
  FORCE_IMPORT_COLUMNS,
  FORCE_IMPORT_MAX_ROWS,
  forceImportRowSchema,
  normalizeHeader,
  parseSignOrg,
  type ForceImportField,
  type ForceImportRow,
} from '@elvis/shared';
import { HttpError } from '../errors.js';

/** Eingelesene Zeile: erkannt oder mit Fehlern */
export interface ParsedImportRow {
  line: number;
  name: string;
  row: ForceImportRow | null;
  messages: string[];
}

export interface ParsedImport {
  columns: Partial<Record<ForceImportField, string>>;
  ignored: string[];
  rows: ParsedImportRow[];
}

// --- CSV ---

/** UTF-8 (mit oder ohne BOM), sonst Windows-1252 – so speichert Excel „CSV (Trennzeichen-getrennt)“ */
function decodeText(buf: Buffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const text = utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
  return text.replace(/^﻿/, '');
}

/** Trennzeichen aus der Kopfzeile: Semikolon (deutsches Excel), Komma oder Tabulator */
function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [';', ',', '\t'].map((d) => [d, head.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return rows;
}

// --- Excel (.xlsx): erstes Tabellenblatt ---

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/** Text eines <si>/<is>-Elements: alle <t>-Teile (auch formatierte Runs) zusammen */
const richText = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join('');

/** Spaltenbuchstaben → Index (A = 0, AA = 26) */
const colIndex = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Alle Tabellenblätter in der Reihenfolge der Arbeitsmappe */
export function parseXlsx(buf: Buffer): string[][][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf), { filter: (f) => (f.name.startsWith('xl/') && f.name.endsWith('.xml')) || f.name.endsWith('.rels') });
  } catch {
    throw new HttpError(400, 'Excel-Datei lässt sich nicht lesen');
  }
  const read = (name: string) => (files[name] ? strFromU8(files[name]) : null);

  // Blätter laut Arbeitsmappe (Dateinamen sagen nichts über die Reihenfolge)
  const workbook = read('xl/workbook.xml') ?? '';
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  const targetOf = (rid: string) =>
    new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1];
  const paths = [...workbook.matchAll(/<sheet\b[^>]*\br:id="([^"]+)"/g)]
    .map((m) => targetOf(m[1]!))
    .filter((t): t is string => !!t)
    .map((t) => (t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`));
  const sheets = (paths.length ? paths : ['xl/worksheets/sheet1.xml']).map(read).filter((x): x is string => x !== null);
  if (!sheets.length) throw new HttpError(400, 'Excel-Datei enthält kein Tabellenblatt');

  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => richText(m[1]!));
  return sheets.map((sheet) => readSheet(sheet, shared));
}

function readSheet(sheet: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNo = Number(/\br="(\d+)"/.exec(rowMatch[1]!)?.[1] ?? rows.length + 1);
    const cells: string[] = [];
    for (const c of rowMatch[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const inner = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = richText(inner);
      else if (type === 'b') value = v === '1' ? 'ja' : 'nein';
      else if (v !== undefined) value = unescapeXml(v);
      cells[ref ? colIndex(ref) : cells.length] = value;
    }
    rows[rowNo - 1] = Array.from(cells, (x) => x ?? '');
  }
  return Array.from(rows, (r) => r ?? []);
}

/** CSV oder Excel – an Inhalt (ZIP) bzw. Endung erkannt; bei Excel alle Blätter */
export function readTables(filename: string, buf: Buffer): string[][][] {
  const zip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (zip) return parseXlsx(buf);
  if (/\.xls$/i.test(filename)) throw new HttpError(400, 'Altes Excel-Format (.xls) – bitte als .xlsx oder CSV speichern');
  return [parseCsv(decodeText(buf))];
}

// --- Spalten zuordnen und Zeilen prüfen ---

const FIELDS = Object.keys(FORCE_IMPORT_COLUMNS) as ForceImportField[];

function mapColumns(header: string[]): { index: Partial<Record<ForceImportField, number>>; columns: ParsedImport['columns']; ignored: string[] } {
  const index: Partial<Record<ForceImportField, number>> = {};
  // Vergleichsformen: ganze Überschrift, dann die ersten Wörter (z. B. „Name der Einheit“ → „name“, „Gehört zu (Zug)“ → „gehortzu“)
  const variants = header.map((h) => {
    const words = h.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return [normalizeHeader(h), ...words.slice(0, -1).map((_, k) => normalizeHeader(words.slice(0, words.length - 1 - k).join('')))];
  });
  for (const exact of [true, false]) {
    variants.forEach((v, i) => {
      if (!v[0] || Object.values(index).includes(i)) return;
      const candidates = exact ? v.slice(0, 1) : v.slice(1);
      const field = FIELDS.find((f) => index[f] === undefined && FORCE_IMPORT_COLUMNS[f].headers.some((s) => candidates.includes(s)));
      if (field) index[field] = i;
    });
  }
  const columns = Object.fromEntries(Object.entries(index).map(([f, i]) => [f, header[i]!.trim()]));
  const ignored = header.filter((h, i) => h.trim() && !Object.values(index).includes(i)).map((h) => h.trim());
  return { index, columns, ignored };
}

/** „1/2/6“ oder „1/2/6/9“ (Führer/Unterführer/Mannschaft/Gesamt) */
function parseStrength(v: string): [number, number, number] | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?\s*$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function parseImport(filename: string, buf: Buffer): ParsedImport {
  // Erstes Blatt mit einer Namensspalte (davor z. B. ein Blatt mit Hinweisen)
  const tables = readTables(filename, buf);
  const found = tables
    .map((table) => {
      const headerAt = table.findIndex((r) => r.some((c) => c.trim()));
      return headerAt < 0 ? null : { table, headerAt, ...mapColumns(table[headerAt]!) };
    })
    .filter((t) => t !== null);
  if (!found.length) throw new HttpError(400, 'Die Datei ist leer');
  const sheet = found.find((t) => t.index.name !== undefined);
  if (!sheet) throw new HttpError(400, 'Spalte „Name“ nicht gefunden – die erste befüllte Zeile muss die Spaltenüberschriften enthalten');
  const { table, headerAt, index, columns, ignored } = sheet;

  const body = table.slice(headerAt + 1).map((cells, i) => ({ line: headerAt + i + 2, cells })).filter((r) => r.cells.some((c) => c.trim()));
  if (body.length > FORCE_IMPORT_MAX_ROWS) throw new HttpError(400, `Höchstens ${FORCE_IMPORT_MAX_ROWS} Zeilen je Import`);

  const rows = body.map(({ line, cells }): ParsedImportRow => {
    const get = (f: ForceImportField) => (index[f] === undefined ? '' : (cells[index[f]!] ?? '').trim());
    const opt = (f: ForceImportField) => get(f) || null;
    const messages: string[] = [];
    const num = (f: ForceImportField) => {
      const v = get(f);
      if (!v) return null;
      if (!/^\d+$/.test(v)) return messages.push(`${FORCE_IMPORT_COLUMNS[f].label}: „${v}“ ist keine Zahl`), null;
      return Number(v);
    };
    let [leaders, subLeaders, crew] = [num('leaders'), num('subLeaders'), num('crew')];
    const strength = get('strength');
    if (strength) {
      const s = parseStrength(strength);
      if (!s) messages.push(`Stärke „${strength}“ nicht erkannt (z. B. 1/2/6)`);
      else [leaders, subLeaders, crew] = [leaders ?? s[0], subLeaders ?? s[1], crew ?? s[2]];
    }
    const orgValue = get('signOrg');
    const signOrg = orgValue ? parseSignOrg(orgValue) : null;
    if (orgValue && !signOrg) messages.push(`Zeichenfarbe „${orgValue}“ unbekannt (z. B. Feuerwehr, THW, Hilfsorganisation, Polizei)`);

    const parsed = forceImportRowSchema.safeParse({
      line,
      name: get('name'),
      callsign: opt('callsign'),
      organization: opt('organization'),
      notes: opt('notes'),
      leaders,
      subLeaders,
      crew,
      signText: opt('signText'),
      signOrg,
      parent: opt('parent'),
      role: opt('role'),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as ForceImportField | undefined;
        messages.push(`${field && FORCE_IMPORT_COLUMNS[field] ? `${FORCE_IMPORT_COLUMNS[field].label}: ` : ''}${issue.code === 'too_big' ? 'zu lang' : issue.message}`);
      }
    }
    return { line, name: get('name'), row: parsed.success && !messages.length ? parsed.data : null, messages };
  });
  return { columns, ignored, rows };
}

/** Vorlage für Excel (Semikolon, BOM) mit Beispielzeilen */
export function importTemplate(): string {
  const header = ['Name', 'Funkrufname', 'Organisation', 'Stärke', 'Zeichentext', 'Zeichenfarbe', 'Gehört zu', 'Rolle', 'Bemerkung'];
  const rows = [
    ['1. Zug Diepholz', '', 'FF Diepholz', '0/0/0', '', 'Feuerwehr', '', '', 'Zug ohne eigene Stärke'],
    ['ELW 1 Diepholz', 'Florian Diepholz 11/12-1', 'FF Diepholz', '1/1/1', 'ELW 1', 'Feuerwehr', '1. Zug Diepholz', 'Führungsfahrzeug', ''],
    ['HLF 20 Diepholz', 'Florian Diepholz 11/44-1', 'FF Diepholz', '0/1/8', 'HLF 20', 'Feuerwehr', '1. Zug Diepholz', 'Löschfahrzeug', ''],
  ];
  const cell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
