import { z } from 'zod';
import { dialableNumber } from './contacts';

/**
 * Telefonie über ein GSM-Gateway (z. B. Yeastar NeoGate TG200): Zustand der GSM-Trunks, SIP-Erreichbarkeit,
 * laufende Gespräche und Anrufliste. SMS laufen über die Nachrichten (chat.ts).
 */

// --- Rufnummern ---

/** Vorwahl für nationale Rufnummern (0…) beim Vergleich */
export const DEFAULT_COUNTRY_CODE = '49';

/**
 * Vergleichsschlüssel einer Rufnummer im internationalen Format: „0171 123“, „+49 (0)171 123“ und „0049171123“
 * ergeben alle „+49171123“. Kurzwahlen und Sonderrufnummern bleiben, wie sie sind (nur Ziffern).
 */
export function phoneKey(number: string): string {
  const d = dialableNumber(number);
  if (d.startsWith('+')) return d;
  if (/^0[1-9]\d{4,}$/.test(d)) return `+${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d;
}

/** Deutsche Mobilfunknummer (+4915…, +4916…, +4917…) */
export const isMobileNumber = (number: string) => /^\+491[5-7]\d{6,}$/.test(phoneKey(number));

/** Anzeige: „+49 171 1234567“ bzw. die Nummer, wie sie ist */
export function formatPhone(number: string): string {
  const k = phoneKey(number);
  const m = /^\+49(1[5-7]\d)(\d+)$/.exec(k);
  return m ? `+49 ${m[1]} ${m[2]}` : k || number;
}

/** Kontakt zu einer Rufnummer */
export interface PhoneMatch {
  contactId: number;
  name: string;
  /** Bezeichnung der Nummer im Kontakt, z. B. „Mobil“ */
  label: string;
}

// --- Gerätezustand ---

export type GsmTrunkStatus = 'up' | 'searching' | 'down' | 'no-sim' | 'unknown';

export interface GsmTrunk {
  /** Port am Gateway (1, 2, …) */
  port: number;
  name: string;
  status: GsmTrunkStatus;
  /** Statuszeile des Gateways, z. B. „Power on, Up, Active, Standard“ */
  statusText: string | null;
  /** Netzbetreiber, z. B. „Telekom.de“ */
  operator: string | null;
  /** Netzregistrierung, z. B. „Registered (Home network)“ */
  registration: string | null;
  roaming: boolean;
  /** Signalqualität (CSQ 0…31), null = unbekannt */
  csq: number | null;
  signalPercent: number | null;
  rssiDbm: number | null;
  /** Bitfehlerrate 0…7 */
  ber: number | null;
  model: string | null;
  imei: string | null;
  smsc: string | null;
  /** Gerade ein Gespräch über diesen Trunk */
  busy: boolean;
}

export interface ActiveCall {
  id: string;
  direction: 'in' | 'out';
  port: number | null;
  number: string;
  /** Kontaktname, falls bekannt */
  name: string | null;
  startedAt: string;
  answeredAt: string | null;
}

export interface TelephonyState {
  /** Verbindung zur API des Gateways; null beim Simulator */
  link: { connected: boolean; target: string; error: string | null; lastEventAt: string | null } | null;
  trunks: GsmTrunk[];
  /** SIP-Seite des Gateways: antwortet der SIP-Dienst, ggf. Registrierung an der Telefonanlage */
  sip: { reachable: boolean | null; registration: string | null; checkedAt: string | null; target: string | null };
  calls: ActiveCall[];
  capabilities: { sms: boolean };
}

/** Beendetes Gespräch (Anrufliste) */
export interface CallRecord {
  id: number;
  direction: 'in' | 'out';
  port: number | null;
  trunk: string | null;
  number: string;
  name: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string;
  /** Gesprächsdauer ab Annahme in Sekunden; 0 = nicht angenommen */
  durationS: number;
  /** Ins Tagebuch dieses Einsatzes geschrieben */
  incidentId: number | null;
}

// --- SMS ---

/** Längere Texte gehen als mehrteilige SMS hinaus */
export const SMS_MAX_LENGTH = 640;

const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

/** Länge und Anzahl der Teile: GSM-Zeichensatz 160 (mehrteilig 153) Zeichen, sonst Unicode 70 (67) */
export function smsParts(text: string): { length: number; parts: number; unicode: boolean } {
  let septets = 0;
  let unicode = false;
  for (const ch of text) {
    if (GSM7.includes(ch)) septets += 1;
    else if (GSM7_EXT.includes(ch)) septets += 2;
    else unicode = true;
  }
  const length = unicode ? [...text].length : septets;
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return { length, parts: length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi), unicode };
}

/** Rufnummer in einer Eingabe → Vergleichsschlüssel (phoneKey) */
export const phoneNumberSchema = z
  .string()
  .trim()
  .regex(/^\+?[\d\s/()-]{3,30}$/, 'Ungültige Rufnummer')
  .transform(phoneKey);

/** Rufnummer einer Kraft (z. B. aus einer SMS gemerkt); leer = keine */
export const mobileSchema = z.union([z.literal(''), phoneNumberSchema]);
