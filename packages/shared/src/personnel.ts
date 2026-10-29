import { z } from 'zod';
import type { Strength } from './forces';

/**
 * Personal im Einsatz: die Personen, die eine Einheit (Fahrzeug, Zug …) bilden. Erfasst wird es auf der
 * Detailseite der Einheit oder vom Einheitsführer über ein Online-Formular (Personalbogen), das ELVIS beim
 * Relay anfordert. Eingereichte Bögen landen im Eingang und werden dort einer Einheit zugeordnet.
 *
 * Das Online-Formular verschlüsselt im Browser für den ELW (RSA-OAEP-256 + AES-256-GCM); das Relay sieht
 * keine Personendaten im Klartext. Gegenstück im Relay: tel-diepholz/elvis-relay, src/protocol.ts und src/form.ts.
 */

/** Einordnung nach FwDV – zählt zur Stärke */
export const PERSON_GRADE = {
  leader: 'Führer',
  subLeader: 'Unterführer',
  crew: 'Mannschaft',
} as const;
export type PersonGrade = keyof typeof PERSON_GRADE;
export const PERSON_GRADES = Object.keys(PERSON_GRADE) as [PersonGrade, ...PersonGrade[]];

/** Vorschläge für Qualifikationen (Ankreuzen im Formular); eigene sind erlaubt */
export const QUALIFICATION_SUGGESTIONS = [
  'Atemschutz',
  'Maschinist',
  'Sprechfunk',
  'Truppführer',
  'Gruppenführer',
  'Zugführer',
  'Verbandsführer',
  'Sanitäter',
  'CSA',
  'Motorsäge',
  'Führerschein C',
  'Führerschein CE',
];

const text = (max: number) => z.string().trim().max(max);

export const personInputSchema = z.object({
  lastName: text(80).min(1, 'Nachname fehlt'),
  firstName: text(80).min(1, 'Vorname fehlt'),
  /** JJJJ-MM-TT oder leer */
  birthDate: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Geburtsdatum als JJJJ-MM-TT')
    .default(''),
  grade: z.enum(PERSON_GRADES).default('crew'),
  /** Funktion in der Einheit, z. B. „Gruppenführer“, „Maschinist“ */
  function: text(60).default(''),
  qualifications: z.array(text(40).min(1)).max(30).default([]),
  /** Feuerwehr / Ortsverband */
  organization: text(100).default(''),
  phone: text(40).default(''),
  /** leer oder eine Adresse (für die Übernahme in die Kontakte) */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => v === '' || z.string().email().safeParse(v).success, 'E-Mail-Adresse ungültig')
    .default(''),
  address: text(200).default(''),
  /** Für Freistellung und Verdienstausfall */
  employer: text(200).default(''),
  /** Wer im Notfall benachrichtigt wird */
  emergencyContact: text(200).default(''),
  notes: text(500).default(''),
});
export type PersonInput = z.input<typeof personInputSchema>;
export type PersonData = z.output<typeof personInputSchema>;

export interface Person extends PersonData {
  id: number;
  unitId: number;
  incidentId: number;
  /** Aus einem Personalbogen im Eingang zugeordnet; null = auf der Detailseite erfasst */
  sheetId: number | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export const MAX_SHEET_PERSONS = 60;

/** Ein Personalbogen: Einheit (Freitext) und deren Personal – Inhalt des Online-Formulars */
export const personnelSheetInputSchema = z.object({
  unitLabel: text(100).min(1, 'Einheit / Fahrzeug fehlt'),
  persons: z.array(personInputSchema).min(1, 'Mindestens eine Person').max(MAX_SHEET_PERSONS),
});
export type PersonnelSheetInput = z.input<typeof personnelSheetInputSchema>;

/** Personalbogen im Eingang */
export interface PersonnelSheet {
  id: number;
  incidentId: number | null;
  unitLabel: string;
  persons: PersonData[];
  submittedAt: string;
  receivedAt: string;
  /** Im Eingang angesehen; null = neu */
  readAt: string | null;
  unitId: number | null;
  unitName: string | null;
  assignedAt: string | null;
  assignedBy: string | null;
}

/** Zuordnen: zu einer Einheit im Einsatz oder als neue Einheit */
export const sheetAssignSchema = z.union([
  z.object({ unitId: z.number().int().positive() }),
  z.object({ newUnit: z.object({ name: text(100).min(1, 'Name fehlt'), parentId: z.number().int().positive().nullable().default(null) }) }),
]);
export type SheetAssign = z.input<typeof sheetAssignSchema>;

/** Online-Formular (Link beim Relay) */
export interface PersonnelForm {
  id: string;
  incidentId: number;
  url: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
}

export const FORM_VALID_HOURS = [6, 12, 24, 48, 72] as const;
export const personnelFormInputSchema = z.object({ validHours: z.number().int().min(1).max(168).default(24) });
export type PersonnelFormInput = z.input<typeof personnelFormInputSchema>;

export interface PersonnelInbox {
  /** Relay eingerichtet (Online-Formular möglich) */
  relayEnabled: boolean;
  /** Aktiver Link des laufenden Einsatzes */
  form: PersonnelForm | null;
  sheets: PersonnelSheet[];
  lastError: string | null;
}

/** Stärke aus dem erfassten Personal */
export const personnelStrength = (persons: Pick<PersonData, 'grade'>[]): Strength => ({
  leaders: persons.filter((p) => p.grade === 'leader').length,
  subLeaders: persons.filter((p) => p.grade === 'subLeader').length,
  crew: persons.filter((p) => p.grade === 'crew').length,
});

export const personName = (p: Pick<PersonData, 'firstName' | 'lastName'>) => `${p.lastName}, ${p.firstName}`;

// --- Relay-Protokoll (Online-Formular) ---

/** Verschlüsselter Personalbogen, wie ihn das Formular einreicht (alles Base64) */
export const encryptedSheetSchema = z.object({
  alg: z.literal('RSA-OAEP-256+A256GCM'),
  /** AES-Schlüssel, mit dem öffentlichen Schlüssel des ELW verschlüsselt */
  key: z.string().max(1024),
  iv: z.string().max(32),
  /** Personalbogen als JSON, AES-GCM (Tag angehängt); Zusatzdaten: die Formular-ID */
  data: z.string().max(256 * 1024),
});
export type EncryptedSheet = z.infer<typeof encryptedSheetSchema>;

/** Öffentlicher RSA-Schlüssel als JWK (WebCrypto importKey 'jwk') */
export interface RsaPublicJwk {
  kty: 'RSA';
  n: string;
  e: string;
  alg: 'RSA-OAEP-256';
  ext: true;
  key_ops: ['encrypt'];
}

/** ELVIS → Relay: Formular anlegen */
export interface RelayFormRequest {
  /** Überschrift im Formular, z. B. „ELW 1 Diepholz · B3 Wohnungsbrand“ */
  title: string;
  /** Öffentlicher Schlüssel (JWK, RSA-OAEP-256) */
  publicKey: RsaPublicJwk;
  expiresAt: string;
}

/** Relay → ELVIS */
export interface RelayForm {
  formId: string;
  url: string;
}

export interface RelaySubmission {
  seq: number;
  formId: string;
  submittedAt: string;
  payload: EncryptedSheet;
}

export interface RelaySubmissionBatch {
  items: RelaySubmission[];
  next: number;
}
