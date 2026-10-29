import { z } from 'zod';

/**
 * Backup und Wiederherstellung. ELVIS sichert Datenbank, Dateien und Konfiguration verschlüsselt über einen
 * Backup-Treiber. Den Schlüssel bekommt der Admin bei der Einrichtung einmal angezeigt (Wiederherstellungsschlüssel);
 * mit ihm allein lässt sich eine frisch installierte Instanz wiederherstellen.
 */

export const BACKUP_INTERVALS = ['15m', '1h', '24h'] as const;
export type BackupInterval = (typeof BACKUP_INTERVALS)[number];
export const BACKUP_INTERVAL_MS: Record<BackupInterval, number> = { '15m': 15 * 60_000, '1h': 3600_000, '24h': 24 * 3600_000 };
export const BACKUP_INTERVAL_LABELS: Record<BackupInterval, string> = { '15m': '15 Minuten', '1h': '1 Stunde', '24h': '24 Stunden' };

export const BACKUP_DRIVER_IDS = ['elw-cloud'] as const;
export type BackupDriverId = (typeof BACKUP_DRIVER_IDS)[number];
export const BACKUP_DRIVERS: { id: BackupDriverId; label: string; description: string }[] = [
  {
    id: 'elw-cloud',
    label: 'einsatzleitwagen.app – Cloud',
    description: 'Verschlüsselt im Rechenzentrum von einsatzleitwagen.app (Cloudflare R2). Ohne den Wiederherstellungsschlüssel kann niemand die Backups lesen.',
  },
];

export const DEFAULT_BACKUP_KEEP = 10;

export const backupSettingsSchema = z.object({
  interval: z.enum(BACKUP_INTERVALS),
  /** Anzahl aufbewahrter Backups; das Kontingent des Treibers begrenzt sie zusätzlich */
  keep: z.number().int().min(1).max(1000),
});
export type BackupSettingsInput = z.infer<typeof backupSettingsSchema>;

export const backupSetupSchema = z.object({ driver: z.enum(BACKUP_DRIVER_IDS) });
export interface BackupSetup {
  /** Nur jetzt sichtbar: ELVIS speichert nur die daraus abgeleiteten Schlüssel */
  recoveryKey: string;
}

/** Bestätigung der Einrichtung: die letzten zwei Gruppen des Schlüssels abtippen */
export const backupConfirmSchema = backupSettingsSchema.extend({ check: z.string().trim().min(1).max(20) });
export type BackupConfirmInput = z.infer<typeof backupConfirmSchema>;

export interface BackupQuota {
  maxBackups: number;
  maxBytes: number;
}

/** Ein Backup im Speicher des Treibers (Angaben aus den verschlüsselten Metadaten) */
export interface BackupSummary {
  id: string;
  createdAt: string;
  size: number;
  /** Fahrzeugname zum Zeitpunkt des Backups; null, wenn die Metadaten nicht lesbar sind */
  vehicle: string | null;
  elvisVersion: string | null;
  schemaVersion: number | null;
}

export interface BackupStatus {
  state: 'off' | 'active';
  driver: BackupDriverId | null;
  interval: BackupInterval;
  keep: number;
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  /** Stand beim Treiber (null, solange nicht abgefragt oder nicht erreichbar) */
  quota: BackupQuota | null;
  usedBytes: number | null;
  backups: BackupSummary[];
}

// --- Wiederherstellen (nur bei der Ersteinrichtung, solange es keine Benutzer gibt) ---

export const restoreListSchema = z.object({ driver: z.enum(BACKUP_DRIVER_IDS), recoveryKey: z.string().max(200) });
export const restoreStartSchema = restoreListSchema.extend({ backupId: z.string().uuid() });
export type RestoreStartInput = z.infer<typeof restoreStartSchema>;

export interface RestoreStatus {
  state: 'idle' | 'running' | 'restarting' | 'error';
  /** Aktueller Schritt, z. B. „Lade herunter“ */
  step: string | null;
  /** 0 … 1 beim Herunterladen */
  progress: number | null;
  error: string | null;
}

// --- Wiederherstellungsschlüssel: ELVIS-XXXX-XXXX-… (Crockford-Base32, 12 Gruppen, mit Prüfsumme) ---

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Zufallsanteil des Schlüssels in Byte (224 Bit) */
export const RECOVERY_KEY_BYTES = 28;
const KEY_PREFIX = 'ELVIS';

/** CRC-16/CCITT gegen Tippfehler (kein Schutz, nur Prüfung) */
function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Zufallsbytes als lesbarer Schlüssel mit Prüfsumme */
export function formatRecoveryKey(secret: Uint8Array): string {
  if (secret.length !== RECOVERY_KEY_BYTES) throw new Error('Schlüssel hat die falsche Länge');
  const crc = crc16(secret);
  const text = base32(Uint8Array.from([...secret, crc >> 8, crc & 0xff]));
  return [KEY_PREFIX, ...(text.match(/.{1,4}/g) ?? [])].join('-');
}

/** Eingabe normalisieren (Groß/klein, Leerzeichen, O/0, I/L/1) */
export function normalizeRecoveryKey(input: string): string {
  let s = input.toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.startsWith(KEY_PREFIX)) s = s.slice(KEY_PREFIX.length);
  return s.replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Zufallsanteil des Schlüssels oder null bei Tippfehler/falscher Länge */
export function parseRecoveryKey(input: string): Uint8Array | null {
  const bytes = unbase32(normalizeRecoveryKey(input));
  if (!bytes || bytes.length !== RECOVERY_KEY_BYTES + 2) return null;
  const secret = bytes.subarray(0, RECOVERY_KEY_BYTES);
  const crc = crc16(secret);
  return bytes[RECOVERY_KEY_BYTES] === crc >> 8 && bytes[RECOVERY_KEY_BYTES + 1] === (crc & 0xff) ? Uint8Array.from(secret) : null;
}

/** Die letzten zwei Gruppen, mit denen der Admin die Einrichtung bestätigt */
export function recoveryKeyCheck(key: string): string {
  return key.split('-').slice(-2).join('-');
}
