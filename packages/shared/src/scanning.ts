import { z } from 'zod';
import { archivePathSchema } from './documents';

/**
 * Scannen: Multifunktionsgeräte schicken Scans per „Scan an E-Mail“ an den SMTP-Empfänger von ELVIS. Jeder Scan
 * landet im Scan-Eingang und – während ein Einsatz läuft – auf Wunsch zusätzlich in dessen Dokumentverwaltung.
 */

export interface ScanSettings {
  /** SMTP-Empfänger nimmt Scans an */
  enabled: boolean;
  /** Scans im laufenden Einsatz ablegen */
  archive: boolean;
  /** Ordnerpfad im Einsatz, Platzhalter wie bei Vorlagen, z. B. „Scans/{{datum.iso}}“ */
  folderPath: string;
  /** IP-Adressen der Scanner; leer = alle */
  allowedHosts: string[];
  /** SMTP-Anmeldung; leer = ohne Anmeldung */
  username: string;
  passwordSet: boolean;
  /** Scans im Eingang nach so vielen Tagen löschen (abgelegte Dokumente im Einsatz bleiben) */
  retentionDays: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const scanSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    archive: z.boolean(),
    folderPath: archivePathSchema,
    allowedHosts: z.array(z.string().trim().ip('Ungültige IP-Adresse')).max(20).default([]),
    username: z.string().trim().max(80).default(''),
    /** Fehlt = unverändert, leer = entfernen */
    password: z.string().max(200).optional(),
    retentionDays: z.coerce.number().int().min(1, 'mindestens 1 Tag').max(365, 'höchstens 365 Tage').default(14),
  })
  .refine((s) => !s.username || s.password !== '', { message: 'Passwort fehlt', path: ['password'] });
export type ScanSettingsInput = z.infer<typeof scanSettingsInputSchema>;

export const DEFAULT_SCAN_SETTINGS = {
  enabled: true,
  archive: true,
  folderPath: 'Scans/{{datum.iso}}',
  allowedHosts: [] as string[],
  username: '',
  retentionDays: 14,
};

export interface ScanItem {
  id: number;
  filename: string;
  sizeBytes: number;
  /** Absender laut SMTP (MAIL FROM) */
  sender: string;
  subject: string;
  sourceIp: string;
  receivedAt: string;
  /** Abgelegt in diesem Einsatz, null = nur im Eingang */
  incidentId: number | null;
  incidentTitle: string | null;
  documentId: number | null;
  archivedPath: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  /** Hinweis, z. B. fehlgeschlagene Ablage */
  message: string;
}

export interface ScanStatus {
  /** SMTP-Empfänger läuft */
  listening: boolean;
  enabled: boolean;
  port: number | null;
  error: string | null;
  lastReceivedAt: string | null;
  /** Automatische Ablage */
  archive: { enabled: boolean; incident: { id: number; title: string } | null; path: string };
}

export interface ScanInbox {
  status: ScanStatus;
  scans: ScanItem[];
}

export const scanAssignSchema = z.object({
  incidentId: z.number().int().positive(),
  /** Fehlt = Ablageort aus den Einstellungen */
  folderPath: archivePathSchema.optional(),
});
export type ScanAssign = z.infer<typeof scanAssignSchema>;
