import { z } from 'zod';
import type { Incident } from './incident';
import type { VehicleInfo } from './protocol';
import type { PlaceholderBags } from './template';

/**
 * Dokumente: Je Einsatz eine virtuelle Ordnerstruktur (Vorgabe aus den Einstellungen, beim Eröffnen
 * übernommen), Vorlagen in einem eigenen Baum (Admins) und Bearbeitung im Browser über Collabora Online.
 */

/** Ordner im Einsatz. Systemordner stammen aus der Vorgabe; Ordner lassen sich ergänzen, aber nicht löschen. */
export interface DocumentFolder {
  id: number;
  incidentId: number;
  /** null = direkt unter der Wurzel */
  parentId: number | null;
  name: string;
  system: boolean;
  createdBy: string;
  createdAt: string;
}

/** Vorgabe der Ordnerstruktur für neue Einsätze (Einstellungen) */
export interface FolderSpec {
  name: string;
  children: FolderSpec[];
}

export const DEFAULT_DOCUMENT_FOLDERS: FolderSpec[] = [
  { name: 'Lagemeldungen', children: [] },
  { name: 'Befehle', children: [] },
  { name: 'Protokolle', children: [] },
  { name: 'Pläne', children: [] },
  { name: 'Fotos', children: [] },
  { name: 'Sonstiges', children: [] },
];

/** Ungültig in Datei- und Ordnernamen (Windows-kompatibel, Pfadtrenner) */
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f]/g;

/** Datei- oder Ordnernamen bereinigen: verbotene Zeichen ersetzen, „.“ und „..“ verhindern */
export function sanitizeName(name: string): string {
  const clean = name.replace(FORBIDDEN, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120).trim();
  return clean;
}

const folderName = z
  .string()
  .trim()
  .min(1, 'Name fehlt')
  .max(120)
  .refine((n) => sanitizeName(n) === n, 'Folgende Zeichen sind nicht erlaubt: / \\ : * ? " < > | sowie ein Punkt am Anfang');

export const folderSpecSchema: z.ZodType<FolderSpec> = z.lazy(() =>
  z.object({ name: folderName, children: z.array(folderSpecSchema).max(50).default([]) }),
) as z.ZodType<FolderSpec>;

export const folderSpecsSchema = z
  .array(folderSpecSchema)
  .max(50)
  .refine((list) => {
    const unique = (l: FolderSpec[]): boolean => new Set(l.map((f) => f.name.toLowerCase())).size === l.length && l.every((f) => unique(f.children));
    return unique(list);
  }, 'Ordnernamen müssen je Ebene eindeutig sein');

export const newFolderSchema = z.object({ parentId: z.number().int().positive().nullable(), name: folderName });
export type NewFolder = z.infer<typeof newFolderSchema>;

export interface IncidentDocument {
  id: number;
  incidentId: number;
  folderId: number | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string;
  uploadedBy: string;
  uploadedAt: string;
  /** Aus dieser Vorlage erstellt */
  templateId: number | null;
  /** Neu erstellt und noch nie gespeichert – nur für den Ersteller sichtbar */
  draft: boolean;
  createdByUserId: number | null;
  updatedAt: string;
  updatedBy: string;
  /** Zählt jedes Speichern aus dem Office-Server hoch */
  version: number;
}

export interface DocumentListing {
  folders: DocumentFolder[];
  documents: IncidentDocument[];
}

export const documentPatchSchema = z
  .object({
    folderId: z.number().int().positive().nullable().optional(),
    filename: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'Keine Änderung');
export type DocumentPatch = z.infer<typeof documentPatchSchema>;

/** Leere Dokumente; der Server erzeugt die Dateien (services/blank.ts) */
export const BLANK_KINDS = {
  text: { label: 'Textdokument', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  tabelle: { label: 'Tabelle', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  praesentation: { label: 'Präsentation', ext: 'odp', mime: 'application/vnd.oasis.opendocument.presentation' },
  zeichnung: { label: 'Zeichnung', ext: 'odg', mime: 'application/vnd.oasis.opendocument.graphics' },
} as const;
export type BlankKind = keyof typeof BLANK_KINDS;

export const newBlankDocumentSchema = z.object({
  kind: z.enum(Object.keys(BLANK_KINDS) as [BlankKind, ...BlankKind[]]),
  folderId: z.number().int().positive().nullable(),
  name: z.string().trim().min(1, 'Name fehlt').max(160),
});
export type NewBlankDocument = z.infer<typeof newBlankDocumentSchema>;

export const fromTemplateSchema = z.object({ templateId: z.number().int().positive() });

// --- Vorlagen ---

export interface TemplateFolder {
  id: number;
  parentId: number | null;
  name: string;
}

export interface DocumentTemplate {
  id: number;
  folderId: number | null;
  name: string;
  description: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Ablageordner im Einsatz, z. B. „Lagemeldungen/{{datum.iso}}“; leer = Wurzel */
  targetPath: string;
  /** Dateiname ohne Endung, z. B. „Lagemeldung {{ordner.laufnummer}}“; leer = Vorlagenname */
  filenamePattern: string;
  /** Platzhalter im Dokumentinhalt ersetzen (docx, xlsx, pptx, odt, ods, odp) */
  fillContent: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface TemplateTree {
  folders: TemplateFolder[];
  templates: DocumentTemplate[];
}

export const templateFolderInputSchema = z.object({ parentId: z.number().int().positive().nullable(), name: folderName });
export type TemplateFolderInput = z.infer<typeof templateFolderInputSchema>;

const pattern = z
  .string()
  .trim()
  .max(300)
  .refine((p) => !p.split('/').some((s) => s.trim() === '..' || s.trim() === '.'), '„.“ und „..“ sind als Ordner nicht erlaubt');

export const templateMetaSchema = z.object({
  folderId: z.number().int().positive().nullable(),
  name: z.string().trim().min(1, 'Name fehlt').max(120),
  description: z.string().trim().max(500).default(''),
  targetPath: pattern.default(''),
  filenamePattern: pattern.default(''),
  fillContent: z.boolean().default(true),
});
export type TemplateMeta = z.infer<typeof templateMetaSchema>;

// --- Platzhalter ---

export const DOCUMENT_PLACEHOLDERS: { key: string; label: string; inPath: boolean }[] = [
  { key: 'einsatz.nummer', label: 'Einsatznummer', inPath: true },
  { key: 'einsatz.stichwort', label: 'Stichwort', inPath: true },
  { key: 'einsatz.bezeichnung', label: 'Bezeichnung', inPath: true },
  { key: 'einsatz.ort', label: 'Einsatzort', inPath: true },
  { key: 'einsatz.leiter', label: 'Einsatzleiter', inPath: true },
  { key: 'einsatz.beginn', label: 'Beginn (TT.MM.JJJJ HH:MM)', inPath: true },
  { key: 'datum.heute', label: 'Datum (TT.MM.JJJJ)', inPath: true },
  { key: 'datum.iso', label: 'Datum (JJJJ-MM-TT)', inPath: true },
  { key: 'datum.zeit', label: 'Uhrzeit (HH:MM)', inPath: true },
  { key: 'datum.zeitkurz', label: 'Uhrzeit (HHMM)', inPath: true },
  { key: 'datum.dtg', label: 'Datum-Zeit-Gruppe', inPath: true },
  { key: 'datum.jahr', label: 'Jahr', inPath: true },
  { key: 'datum.monat', label: 'Monat', inPath: true },
  { key: 'datum.tag', label: 'Tag', inPath: true },
  { key: 'benutzer.name', label: 'Name des Bearbeiters', inPath: true },
  { key: 'fahrzeug.name', label: 'Fahrzeug', inPath: true },
  { key: 'fahrzeug.rufname', label: 'Funkrufname', inPath: true },
  { key: 'fahrzeug.organisation', label: 'Organisation', inPath: true },
  { key: 'ordner.laufnummer', label: 'Laufende Nummer im Zielordner (001, 002 …) – nur Dateiname', inPath: false },
];

const p2 = (n: number) => String(n).padStart(2, '0');
const DTG_MONTHS = ['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'];

/** Platzhalterwerte für Pfad, Dateiname und Inhalt. `ordner` fehlt, solange der Zielordner nicht feststeht. */
export function documentPlaceholders(
  ctx: { incident: Incident; vehicle: VehicleInfo; userName: string; now: Date },
  sequence?: number,
): PlaceholderBags {
  const d = ctx.now;
  const started = new Date(ctx.incident.startedAt);
  const date = (x: Date) => `${p2(x.getDate())}.${p2(x.getMonth() + 1)}.${x.getFullYear()}`;
  const time = (x: Date) => `${p2(x.getHours())}:${p2(x.getMinutes())}`;
  return {
    einsatz: {
      nummer: ctx.incident.id,
      stichwort: ctx.incident.keyword,
      bezeichnung: ctx.incident.title,
      ort: ctx.incident.location,
      leiter: ctx.incident.leader,
      beginn: `${date(started)} ${time(started)}`,
    },
    datum: {
      heute: date(d),
      iso: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
      zeit: time(d),
      zeitkurz: `${p2(d.getHours())}${p2(d.getMinutes())}`,
      dtg: `${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${DTG_MONTHS[d.getMonth()]}${String(d.getFullYear()).slice(2)}`,
      jahr: d.getFullYear(),
      monat: p2(d.getMonth() + 1),
      tag: p2(d.getDate()),
    },
    benutzer: { name: ctx.userName },
    fahrzeug: { name: ctx.vehicle.name, rufname: ctx.vehicle.callsign, organisation: ctx.vehicle.organization },
    ...(sequence !== undefined && { ordner: { laufnummer: String(sequence).padStart(3, '0') } }),
  };
}

/** Ablageort im Einsatz (Druck, Scan): Ordnerpfad mit Platzhaltern, z. B. „Drucke/{{datum.iso}}“ */
export const archivePathSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (p) => [...p.matchAll(/\{\{\s*([a-zA-Z]+\.[a-zA-Z0-9_]+)\s*\}\}/g)].every((m) => DOCUMENT_PLACEHOLDERS.some((d) => d.inPath && d.key === m[1])),
    'Unbekannter Platzhalter im Ablageort',
  );

/** Dateiendung (klein, ohne Punkt) */
export const extensionOf = (filename: string) => (/\.([a-zA-Z0-9]{1,8})$/.exec(filename)?.[1] ?? '').toLowerCase();

/** Pfad eines Ordners als „A/B/C“ */
export function folderPath(folders: { id: number; parentId: number | null; name: string }[], id: number | null): string {
  const parts: string[] = [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (let f = id === null ? undefined : byId.get(id); f; f = f.parentId === null ? undefined : byId.get(f.parentId)) parts.unshift(f.name);
  return parts.join('/');
}

// --- Office (Collabora) ---

export interface OfficeStatus {
  available: boolean;
  /** Dateiendungen, die der Office-Server bearbeiten kann */
  editable: string[];
  /** … bzw. nur anzeigen */
  viewable: string[];
}

export interface OfficeSession {
  /** Formularziel für das iframe, inkl. WOPISrc */
  actionUrl: string;
  accessToken: string;
  /** Ablauf in ms seit 1970 (WOPI access_token_ttl) */
  accessTokenTtl: number;
  readOnly: boolean;
  filename: string;
}
