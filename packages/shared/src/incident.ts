import { z } from 'zod';

/** Einsatzführung: Lage und Einsatztagebuch. Kräfte: forces.ts */

/** Art der Lage: bestimmt die Felder beim Anlegen und den Beschaffungsweg */
export type IncidentKind = 'area' | 'rescue' | 'staff';
export const INCIDENT_KINDS = ['rescue', 'area', 'staff'] as const satisfies readonly IncidentKind[];
export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  area: 'Flächenlage',
  rescue: 'Brand/Technische Hilfe',
  staff: 'Stab',
};
/** Stichwort und Einsatzort gibt es nur bei Brand/Technische Hilfe */
export const kindHasSite = (kind: IncidentKind): boolean => kind === 'rescue';
/** Bei einer Stablage läuft die Beschaffung über den Stab, sonst beschafft die Beschaffungsrolle selbst */
export const procurementModeFor = (kind: IncidentKind): 'self' | 'staff' => (kind === 'staff' ? 'staff' : 'self');

export interface Incident {
  id: number;
  kind: IncidentKind;
  keyword: string;
  title: string;
  location: string;
  leader: string;
  /** Einsatzort auf der Karte, optional. */
  lat: number | null;
  lon: number | null;
  /** Eigenes Fahrzeug auf der Karte zeigen (in der Objektliste ausblendbar) */
  vehicleVisible: boolean;
  /** Anforderungen: selbst beschaffen oder über den Stab (Ausgangsmeldung); folgt aus der Art */
  procurementMode: 'self' | 'staff';
  /** Empfänger „Stab“ für Anforderungen im Modus „Stab“ */
  procurementStaff: string;
  startedAt: string;
  closedAt: string | null;
}

export interface NewIncident {
  /** Ohne Angabe: Brand/Technische Hilfe */
  kind?: IncidentKind;
  keyword?: string;
  title: string;
  location?: string;
  leader?: string;
  lat?: number | null;
  lon?: number | null;
  procurementStaff?: string;
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
  /** Bezug auf eine Anforderung */
  requestId: number | null;
}

export interface NewJournalEntry {
  category: JournalCategory;
  text: string;
  sender?: string;
  recipient?: string;
  important?: boolean;
  correctsId?: number | null;
  /** Nur serverseitig: Bezug auf eine Anforderung */
  requestId?: number | null;
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

// --- Einstellungen: vordefinierte Einsatzstichworte (nur Admins) ---

export const incidentSettingsSchema = z.object({
  /** Auswahl für das Einsatzstichwort bei Brand/Technische Hilfe; leer = Freitext */
  keywords: z.array(z.string().trim().min(1).max(40)).max(200),
});
export type IncidentSettingsInput = z.input<typeof incidentSettingsSchema>;

export interface IncidentSettings {
  keywords: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}
