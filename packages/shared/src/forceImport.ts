import { z } from 'zod';
import { TACTICAL_ORGS } from './tactical';

/**
 * Import in die Kräfteverwaltung aus CSV oder Excel (.xlsx). Spalten werden an den Überschriften erkannt;
 * vorhandene Systemeinheiten (gleicher Funkrufname, sonst gleicher Name und gleiche Organisation) werden
 * aktualisiert oder übersprungen. „Gehört zu“ hängt die Einheit als Untereinheit in eine andere – aus der Datei
 * oder aus dem Katalog.
 */

export const FORCE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const FORCE_IMPORT_MAX_ROWS = 2000;

/** Felder einer Importzeile mit den Spaltenüberschriften, die dafür erkannt werden (klein, ohne Sonderzeichen verglichen) */
export const FORCE_IMPORT_COLUMNS = {
  name: { label: 'Name', headers: ['name', 'bezeichnung', 'einheit', 'fahrzeug', 'einheitsname'] },
  callsign: { label: 'Funkrufname', headers: ['funkrufname', 'rufname', 'funkruf', 'rufzeichen', 'callsign'] },
  organization: { label: 'Organisation', headers: ['organisation', 'wehr', 'ortswehr', 'ortsfeuerwehr', 'feuerwehr', 'ortsverband', 'dienststelle', 'standort'] },
  notes: { label: 'Bemerkung', headers: ['bemerkung', 'bemerkungen', 'notiz', 'notizen', 'hinweis', 'hinweise'] },
  strength: { label: 'Stärke', headers: ['starke', 'staerke', 'besatzung'] },
  leaders: { label: 'Führer', headers: ['fuhrer', 'fuehrer', 'zugfuhrer', 'zugfuehrer'] },
  subLeaders: { label: 'Unterführer', headers: ['unterfuhrer', 'unterfuehrer'] },
  crew: { label: 'Mannschaft', headers: ['mannschaft', 'helfer', 'einsatzkrafte', 'einsatzkraefte'] },
  signText: { label: 'Zeichentext', headers: ['zeichentext', 'kurzbezeichnung', 'kurzname', 'typ', 'fahrzeugtyp'] },
  signOrg: { label: 'Zeichenfarbe', headers: ['zeichenfarbe', 'organisationsart', 'zeichenorganisation', 'art'] },
  parent: { label: 'Gehört zu', headers: ['gehortzu', 'gehoertzu', 'ubergeordneteeinheit', 'uebergeordneteeinheit', 'zug', 'verband', 'parent'] },
  role: { label: 'Rolle', headers: ['rolle', 'funktion', 'aufgabe'] },
} as const;
export type ForceImportField = keyof typeof FORCE_IMPORT_COLUMNS;

/** Überschrift vergleichbar machen: klein, Umlaute aufgelöst, nur Buchstaben/Ziffern */
export const normalizeHeader = (h: string): string =>
  h
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

/** Werte für die Zeichenfarbe: Schlüssel, Bezeichnung oder gängige Kürzel */
export function parseSignOrg(value: string): keyof typeof TACTICAL_ORGS | null {
  const v = normalizeHeader(value);
  if (!v) return null;
  const aliases: Record<string, keyof typeof TACTICAL_ORGS> = {
    fw: 'feuerwehr',
    ff: 'feuerwehr',
    bf: 'feuerwehr',
    feuerwehr: 'feuerwehr',
    thw: 'thw',
    drk: 'hilfsorganisation',
    asb: 'hilfsorganisation',
    juh: 'hilfsorganisation',
    mhd: 'hilfsorganisation',
    dlrg: 'hilfsorganisation',
    rd: 'hilfsorganisation',
    rettungsdienst: 'hilfsorganisation',
    hilfsorganisation: 'hilfsorganisation',
    hiorg: 'hilfsorganisation',
    polizei: 'polizei',
    pol: 'polizei',
    bundeswehr: 'bundeswehr',
    bw: 'bundeswehr',
    fuhrung: 'fuehrung',
    fuehrung: 'fuehrung',
    sonstige: 'sonstige',
  };
  if (aliases[v]) return aliases[v];
  for (const [key, org] of Object.entries(TACTICAL_ORGS)) if (normalizeHeader(org.label) === v) return key as keyof typeof TACTICAL_ORGS;
  return null;
}

const text = (max: number) => z.string().trim().max(max);
const count = (max: number) => z.number().int().min(0).max(max).nullable().default(null);

/** Eine erkannte Zeile; null = Spalte fehlt bzw. leer (vorhandener Wert bleibt beim Aktualisieren) */
export const forceImportRowSchema = z.object({
  /** Zeile in der Datei (für Meldungen) */
  line: z.number().int().positive(),
  name: text(100).min(1, 'Name fehlt'),
  callsign: text(100).nullable().default(null),
  organization: text(100).nullable().default(null),
  notes: text(1000).nullable().default(null),
  leaders: count(999),
  subLeaders: count(999),
  crew: count(9999),
  signText: text(12).nullable().default(null),
  signOrg: z.enum(Object.keys(TACTICAL_ORGS) as [keyof typeof TACTICAL_ORGS, ...(keyof typeof TACTICAL_ORGS)[]]).nullable().default(null),
  parent: text(100).nullable().default(null),
  role: text(60).nullable().default(null),
});
export type ForceImportRow = z.infer<typeof forceImportRowSchema>;

export const forceImportSchema = z.object({
  rows: z.array(forceImportRowSchema).min(1, 'Keine Zeilen').max(FORCE_IMPORT_MAX_ROWS),
  /** Vorhandene Systemeinheiten überschreiben (sonst überspringen) */
  updateExisting: z.boolean().default(true),
});
export type ForceImportInput = z.input<typeof forceImportSchema>;

export type ForceImportAction = 'create' | 'update' | 'skip' | 'error';

export interface ForceImportPlanRow {
  row: ForceImportRow | null;
  line: number;
  /** Name wie in der Datei – auch bei fehlerhaften Zeilen */
  name: string;
  action: ForceImportAction;
  /** Vorhandene Systemeinheit (update/skip) */
  matchId: number | null;
  messages: string[];
}

export interface ForceImportPreview {
  /** Erkannte Spalten: Feld → Überschrift in der Datei */
  columns: Partial<Record<ForceImportField, string>>;
  /** Spalten ohne Zuordnung */
  ignored: string[];
  rows: ForceImportPlanRow[];
}

export interface ForceImportResult {
  created: number;
  updated: number;
  skipped: number;
  /** Neu angelegte Zugehörigkeiten („Gehört zu“) */
  linked: number;
  rows: ForceImportPlanRow[];
}
