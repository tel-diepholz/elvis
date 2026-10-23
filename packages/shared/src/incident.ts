/** Einsatzführung: Einsatz, Einsatztagebuch und Kräfteübersicht. */

export interface Incident {
  id: number;
  keyword: string;
  title: string;
  location: string;
  leader: string;
  /** Einsatzort auf der Karte, optional. */
  lat: number | null;
  lon: number | null;
  startedAt: string;
  closedAt: string | null;
}

export interface NewIncident {
  keyword?: string;
  title: string;
  location?: string;
  leader?: string;
  lat?: number | null;
  lon?: number | null;
}

export type IncidentPatch = Partial<NewIncident>;

export type JournalCategory =
  | 'lage'
  | 'auftrag'
  | 'meldung'
  | 'funk'
  | 'telefon'
  | 'entscheidung'
  | 'sonstiges'
  | 'system';

export const JOURNAL_CATEGORY_LABELS: Record<JournalCategory, string> = {
  lage: 'Lage',
  auftrag: 'Auftrag',
  meldung: 'Meldung',
  funk: 'Funk',
  telefon: 'Telefon',
  entscheidung: 'Entscheidung',
  sonstiges: 'Sonstiges',
  system: 'System',
};

/** Entries are append-only: corrections are written as new entries referencing the old one. */
export interface JournalEntry {
  id: number;
  incidentId: number;
  /** Zeitpunkt des Ereignisses. */
  timestamp: string;
  /** Zeitpunkt der Erfassung (weicht bei Nachträgen ab). */
  recordedAt: string;
  category: JournalCategory;
  text: string;
  sender: string;
  recipient: string;
  author: string;
  important: boolean;
  correctsId: number | null;
}

export interface NewJournalEntry {
  category: JournalCategory;
  text: string;
  sender?: string;
  recipient?: string;
  important?: boolean;
  correctsId?: number | null;
  /** Optional time of the event if it is recorded after the fact. */
  timestamp?: string;
}

/** Stärke nach FwDV: Führer / Unterführer / Mannschaft (Gesamt wird berechnet). */
export interface Strength {
  leaders: number;
  subLeaders: number;
  crew: number;
}

export function formatStrength(s: Strength): string {
  return `${s.leaders}/${s.subLeaders}/${s.crew}/${s.leaders + s.subLeaders + s.crew}`;
}

export interface Unit {
  id: number;
  incidentId: number;
  callsign: string;
  unitType: string;
  organization: string;
  strength: Strength;
  section: string;
  fmsStatus: number | null;
  notes: string;
  arrivedAt: string;
  releasedAt: string | null;
  updatedAt: string;
}

export interface NewUnit {
  callsign: string;
  unitType?: string;
  organization?: string;
  strength?: Strength;
  section?: string;
  fmsStatus?: number | null;
  notes?: string;
}

export type UnitPatch = Partial<NewUnit> & { released?: boolean };

export const FMS_STATUS: Record<number, { label: string; short: string }> = {
  0: { label: 'Priorisierter Sprechwunsch', short: 'Notruf' },
  1: { label: 'Einsatzbereit über Funk', short: 'Frei Funk' },
  2: { label: 'Einsatzbereit auf Wache', short: 'Wache' },
  3: { label: 'Einsatzauftrag übernommen', short: 'Anfahrt' },
  4: { label: 'Am Einsatzort', short: 'E-Ort' },
  5: { label: 'Sprechwunsch', short: 'Sprechw.' },
  6: { label: 'Nicht einsatzbereit', short: 'n. e.' },
  7: { label: 'Patient aufgenommen', short: 'Pat.' },
  8: { label: 'Am Transportziel', short: 'Ziel' },
  9: { label: 'Fremdanmeldung / Quittung', short: 'Quitt.' },
};

export interface AuditEntry {
  id: number;
  timestamp: string;
  operator: string;
  target: string;
  action: string;
  params: string;
  success: boolean;
  message: string;
}

export interface IncidentDocument {
  id: number;
  incidentId: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string;
  uploadedBy: string;
  uploadedAt: string;
}
