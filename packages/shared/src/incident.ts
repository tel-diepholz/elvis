/** Einsatzführung: Einsatz und Einsatztagebuch. Kräfte: forces.ts */

export interface Incident {
  id: number;
  keyword: string;
  title: string;
  location: string;
  leader: string;
  /** Einsatzort auf der Karte, optional. */
  lat: number | null;
  lon: number | null;
  /** Eigenes Fahrzeug auf der Karte zeigen (in der Objektliste ausblendbar) */
  vehicleVisible: boolean;
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

export type IncidentPatch = Partial<NewIncident> & { vehicleVisible?: boolean };

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

/** FMS-Status der Funkgeräte (Kommunikation); die Kräfteübersicht führt eigene Status (forces.ts) */
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
