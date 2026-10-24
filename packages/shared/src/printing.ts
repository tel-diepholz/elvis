import { z } from 'zod';
import { archivePathSchema } from './documents';

/**
 * Druckserver: Ein Addon (CUPS) betreibt die Drucker, ELVIS reicht PDFs per IPP weiter. Drucken dürfen auch
 * anonyme Arbeitsplätze; auf Wunsch landet jeder Druck in der Dokumentverwaltung des laufenden Einsatzes.
 */

export type PrinterState = 'idle' | 'processing' | 'stopped';

export interface PrinterInfo {
  /** „<Server-ID>/<Druckername>“ */
  id: string;
  serverName: string;
  name: string;
  /** Beschreibung aus CUPS, sonst der Name */
  info: string;
  location: string;
  state: PrinterState;
  accepting: boolean;
  stateMessage: string;
  color: boolean;
  duplex: boolean;
  /** PWG-Namen, z. B. iso_a4_210x297mm */
  media: string[];
  mediaDefault: string | null;
  numberUp: number[];
}

export interface PrintStatus {
  /** Mindestens ein Druckserver-Addon läuft */
  available: boolean;
  printers: PrinterInfo[];
  /** Nicht erreichbare Druckserver */
  errors: string[];
  defaultPrinter: string | null;
  /** Ablage der Drucke in der Dokumentverwaltung */
  archive: { enabled: boolean; incident: { id: number; title: string } | null; path: string };
}

export type PrintJobState = 'pending' | 'held' | 'processing' | 'stopped' | 'canceled' | 'aborted' | 'completed' | 'unknown';

export const PRINT_JOB_STATE_LABELS: Record<PrintJobState, string> = {
  pending: 'Wartet',
  held: 'Angehalten',
  processing: 'Wird gedruckt',
  stopped: 'Drucker gestoppt',
  canceled: 'Abgebrochen',
  aborted: 'Fehlgeschlagen',
  completed: 'Gedruckt',
  unknown: 'Unbekannt',
};

export const PRINT_JOB_DONE: PrintJobState[] = ['canceled', 'aborted', 'completed'];

export interface PrintJob {
  /** Zufällige Kennung; wer sie kennt, darf den Status abfragen */
  ref: string;
  printerId: string;
  printerName: string;
  filename: string;
  copies: number;
  state: PrintJobState;
  stateMessage: string;
  submittedBy: string;
  createdAt: string;
  /** Ablageort in der Dokumentverwaltung, null = nicht abgelegt */
  archivedPath: string | null;
  documentId: number | null;
}

export const SIDES = {
  'one-sided': 'Einseitig',
  'two-sided-long-edge': 'Beidseitig (lange Kante)',
  'two-sided-short-edge': 'Beidseitig (kurze Kante)',
} as const;
export type Sides = keyof typeof SIDES;

/** Seitenbereich „1-3, 5, 8-“: aufsteigende, nicht überlappende Bereiche; offenes Ende = bis zur letzten Seite */
export function parsePageRanges(input: string): [number, number][] | null {
  const text = input.replace(/\s+/g, '');
  if (!text) return [];
  const out: [number, number][] = [];
  for (const part of text.split(/[,;]/)) {
    const m = /^(\d{1,5})(?:(-)(\d{1,5})?)?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? (m[3] ? Number(m[3]) : 99999) : from;
    if (from < 1 || to < from) return null;
    if (out.length && from <= out[out.length - 1]![1]) return null;
    out.push([from, to]);
  }
  return out;
}

export const printOptionsSchema = z.object({
  printerId: z.string().min(1, 'Drucker wählen').max(200),
  copies: z.coerce.number().int().min(1, 'mindestens 1').max(99, 'höchstens 99').default(1),
  sides: z.enum(Object.keys(SIDES) as [Sides, ...Sides[]]).default('one-sided'),
  color: z.enum(['color', 'monochrome']).default('color'),
  /** leer = Vorgabe des Druckers */
  media: z.union([z.literal(''), z.string().regex(/^[a-z0-9_.-]{1,80}$/)]).default(''),
  orientation: z.enum(['auto', 'portrait', 'landscape']).default('auto'),
  pageRanges: z
    .string()
    .max(100)
    .default('')
    .refine((s) => parsePageRanges(s) !== null, 'Seiten z. B. „1-3, 5“'),
  numberUp: z.coerce.number().int().refine((n) => [1, 2, 4, 6, 9, 16].includes(n), 'Seiten je Blatt').default(1),
  fitToPage: z.boolean().default(true),
});
export type PrintOptions = z.output<typeof printOptionsSchema>;
export type PrintOptionsInput = z.input<typeof printOptionsSchema>;

export interface PrintSettings {
  /** Drucke in der Dokumentverwaltung des laufenden Einsatzes ablegen */
  archive: boolean;
  /** Ordnerpfad im Einsatz, Platzhalter wie bei Vorlagen, z. B. „Drucke/{{datum.iso}}“ */
  folderPath: string;
  /** Vorauswahl auf der Druckseite */
  defaultPrinter: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const printSettingsInputSchema = z.object({
  archive: z.boolean(),
  folderPath: archivePathSchema,
  defaultPrinter: z.string().min(1).max(200).nullable(),
});
export type PrintSettingsInput = z.infer<typeof printSettingsInputSchema>;

export const DEFAULT_PRINT_SETTINGS: Omit<PrintSettings, 'updatedAt' | 'updatedBy'> = { archive: true, folderPath: 'Drucke', defaultPrinter: null };

const MEDIA_NAMES: Record<string, string> = {
  iso_a3: 'A3',
  iso_a4: 'A4',
  iso_a5: 'A5',
  iso_a6: 'A6',
  na_letter: 'Letter',
  na_legal: 'Legal',
  iso_dl: 'Umschlag DL',
  iso_c5: 'Umschlag C5',
};

/** Lesbarer Name eines PWG-Papierformats: „iso_a4_210x297mm“ → „A4“, unbekannte mit Maßen */
export function mediaLabel(keyword: string): string {
  const m = /^([a-z0-9]+_[a-z0-9.-]+?)_([\d.]+)x([\d.]+)(mm|in)$/.exec(keyword);
  if (!m) return keyword;
  const known = MEDIA_NAMES[m[1]!];
  if (known) return known;
  const raw = m[1]!.replace(/^(iso|na|jis|jpn|om|oe|prc|roc|asme)_/, '').replace(/[-_]/g, ' ');
  const name = /^[abc]\d+$/.test(raw) ? raw.toUpperCase() : raw;
  return `${name} (${m[2]}×${m[3]} ${m[4]})`;
}

/** Gängige Formate zuerst, Sonder- und Randlos-Formate ans Ende */
export function sortMedia(list: string[]): string[] {
  const rank = (k: string) => {
    const known = Object.keys(MEDIA_NAMES).findIndex((p) => k.startsWith(`${p}_`));
    return k.includes('.borderless') || k.startsWith('custom_') ? 1000 : known >= 0 ? known : 500;
  };
  return [...new Set(list)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
