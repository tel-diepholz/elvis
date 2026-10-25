/**
 * App-Anbindung: Einsatzkräfte senden ihre Position mit der ELVIS-App über ein kleines Cloud-Relay
 * (apps/relay) an den ELW. Die App registriert sich beim Relay und zeigt ID und Code; in der
 * Kräfteübersicht wird sie damit einer Einheit im Einsatz zugeordnet. ELVIS holt die Positionen
 * ausgehend beim Relay ab – der ELW braucht keinen öffentlichen Zugang.
 *
 * Diese Datei ist das gemeinsame Protokoll von App, Relay und ELVIS-Server.
 */
import { z } from 'zod';

// --- Geräte-ID und Code ---

/** Crockford-Base32 ohne I, L, O, U – gut vorzulesen und abzutippen */
export const DEVICE_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const DEVICE_ID_LENGTH = 8;
export const PAIR_CODE_LENGTH = 6;

/** Eingabe vereinheitlichen: Groß-/Kleinschreibung, Leer- und Bindestriche egal, O→0, I/L→1 */
export function normalizeDeviceId(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** Anzeige in zwei Vierergruppen: K7M2-QX9P */
export const formatDeviceId = (id: string) => (id.length === DEVICE_ID_LENGTH ? `${id.slice(0, 4)}-${id.slice(4)}` : id);

const deviceId = z
  .string()
  .transform(normalizeDeviceId)
  .refine((v) => v.length === DEVICE_ID_LENGTH && [...v].every((c) => DEVICE_ID_ALPHABET.includes(c)), 'App-ID ungültig (8 Zeichen, z. B. K7M2-QX9P)');
const pairCode = z
  .string()
  .transform((v) => v.replace(/\s/g, ''))
  .refine((v) => new RegExp(`^\\d{${PAIR_CODE_LENGTH}}$`).test(v), `Code ungültig (${PAIR_CODE_LENGTH} Ziffern)`);

/** Kopplung in ELVIS: ID und Code aus der App */
export const pairInputSchema = z.object({ deviceId, code: pairCode });
export type PairInput = z.input<typeof pairInputSchema>;

// --- Relay-Protokoll ---

export const relayPositionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Genauigkeit in Metern (Radius), null = unbekannt */
  accuracyM: z.number().min(0).max(100_000).nullable(),
  /** Zeitpunkt der Ortung (ISO) */
  ts: z.string().datetime(),
  /** Akkustand 0…1, null = unbekannt */
  battery: z.number().min(0).max(1).nullable().default(null),
});
export type RelayPosition = z.output<typeof relayPositionSchema>;

/** Antwort an die App: Registrierung */
export interface DeviceRegistration {
  deviceId: string;
  token: string;
  code: string;
}

/** Antwort an die App: Zustand (auf jede Positionsmeldung und Statusabfrage) */
export interface DeviceStatus {
  paired: boolean;
  /** Vom ELW gesetzt, z. B. „HLF 20/1 · B3 Wohnungsbrand“ */
  label: string;
  /** Aktueller Code zum Koppeln, nur solange ungekoppelt */
  code: string | null;
}

export interface ElwRegistration {
  elwId: string;
  token: string;
}

export const relayPairSchema = z.object({ deviceId, code: pairCode, label: z.string().trim().max(200).default('') });
export type RelayPair = z.input<typeof relayPairSchema>;

export const relayLabelSchema = z.object({ label: z.string().trim().max(200) });

export interface RelayPositionItem extends RelayPosition {
  seq: number;
  deviceId: string;
}

/** Positionen für den ELW ab einem Cursor (seq) */
export interface ElwPositionBatch {
  items: RelayPositionItem[];
  /** Cursor für den nächsten Abruf */
  next: number;
}

// --- Senderegel der App ---

/** Höchstens so lange ohne Meldung, auch wenn die Person steht */
export const SEND_INTERVAL_MS = 10 * 60_000;
/** Ab dieser Bewegung sofort melden */
export const SEND_DISTANCE_M = 10;

/** Abstand zweier Punkte in Metern (Haversine) */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Melden, wenn noch nichts gesendet wurde, die Person sich ≥ 10 m bewegt hat oder 10 min vergangen sind */
export function shouldSendPosition(last: { lat: number; lon: number; sentAt: number } | null, next: { lat: number; lon: number }, now: number): boolean {
  if (!last) return true;
  return now - last.sentAt >= SEND_INTERVAL_MS || distanceM(last, next) >= SEND_DISTANCE_M;
}

// --- ELVIS ---

/** Gekoppelte App einer Einheit im Einsatz */
export interface AppLink {
  unitId: number;
  deviceId: string;
  pairedAt: string;
  pairedBy: string;
  lastPositionAt: string | null;
  accuracyM: number | null;
  battery: number | null;
}

/** Zustand der Relay-Anbindung (Einstellungen) */
export interface AppRelayStatus {
  /** Relay in config/elvis.json eingetragen */
  enabled: boolean;
  relayUrl: string | null;
  /** ELW beim Relay registriert */
  registered: boolean;
  activeLinks: number;
  lastPollAt: string | null;
  lastError: string | null;
}

/** App-Position gilt danach als veraltet */
export const APP_POSITION_STALE_MS = 20 * 60_000;
