import { z } from 'zod';
import { MAX_CONTACT_PHONES } from './contacts';
import { MAC_PATTERN } from './workstations';

/**
 * Tischtelefone (Snom D385) an der Telefonanlage des ELW. ELVIS provisioniert sie über eine Abruf-URL (SIP-Konto,
 * Telefonbuch aus den Kontakten, Funktionstasten) und überträgt geänderte Tasten sofort an das Telefon.
 *
 * Tastenbelegung in Ebenen: Vorlage (alle Telefone) → Grundbelegung des Telefons → Überschreibung im laufenden
 * Einsatz. Vorlage und Grundbelegung pflegen Admins, überschreiben darf jeder Angemeldete, solange ein Einsatz läuft.
 * Mit dem Einsatzende fallen die Überschreibungen weg.
 */

export const PHONE_MODEL = {
  d385: { label: 'Snom D385', keys: 48, keysPerPage: 12 },
} as const;
export type PhoneModel = keyof typeof PHONE_MODEL;
export const PHONE_MODELS = Object.keys(PHONE_MODEL) as [PhoneModel, ...PhoneModel[]];

/** Größte Tastenanzahl aller Modelle (für die Prüfung der Vorlage) */
export const MAX_PHONE_KEYS = Math.max(...Object.values(PHONE_MODEL).map((m) => m.keys));

const text = (max: number) => z.string().trim().max(max);
/** Nebenstelle: Ziffern, * und # */
const extension = z.string().trim().regex(/^[0-9*#]{1,20}$/, 'Nebenstelle: nur Ziffern, * und #');

export const PHONE_KEY_TYPE = {
  contact: 'Kontakt',
  number: 'Nummer',
  blf: 'Nebenstelle (BLF)',
  empty: 'leer',
} as const;
export type PhoneKeyType = keyof typeof PHONE_KEY_TYPE;

export const phoneKeySchema = z.discriminatedUnion('type', [
  /** Nummer eines Kontakts – bleibt aktuell, wenn sich der Kontakt ändert */
  z.object({
    type: z.literal('contact'),
    contactId: z.number().int().positive(),
    /** Index der Telefonnummer im Kontakt */
    phone: z.number().int().min(0).max(MAX_CONTACT_PHONES - 1),
    /** Eigene Beschriftung, sonst der Kontaktname */
    label: text(40).default(''),
  }),
  z.object({ type: z.literal('number'), number: text(40).min(1, 'Nummer fehlt'), label: text(40).default('') }),
  /** Besetztlampe einer Nebenstelle, Druck ruft an bzw. übernimmt einen Anruf */
  z.object({ type: z.literal('blf'), extension, label: text(40).default('') }),
  /** Taste ausdrücklich frei (überdeckt Vorlage bzw. Grundbelegung) */
  z.object({ type: z.literal('empty') }),
]);
export type PhoneKeyInput = z.input<typeof phoneKeySchema>;
export type PhoneKey = z.output<typeof phoneKeySchema>;

/** Belegung nach Tastenindex (0 = erste Taste) */
export type PhoneKeys = Record<number, PhoneKey>;

/** Woher die wirksame Belegung einer Taste kommt */
export type PhoneKeySource = 'incident' | 'phone' | 'template';
export const PHONE_KEY_SOURCE: Record<PhoneKeySource, string> = { incident: 'Einsatz', phone: 'Telefon', template: 'Vorlage' };

/** Eine Taste mit allen Ebenen und der aufgelösten Anzeige */
export interface PhoneKeySlot {
  idx: number;
  incident: PhoneKey | null;
  phone: PhoneKey | null;
  template: PhoneKey | null;
  /** Ebene der wirksamen Belegung, null = nichts belegt */
  source: PhoneKeySource | null;
  /** Beschriftung am Telefon */
  label: string;
  /** Gewählte Nummer bzw. Nebenstelle, leer bei freier Taste */
  target: string;
  /** z. B. „Kontakt gelöscht“ – die Taste bleibt dann am Telefon frei */
  error: string | null;
}

export type PhonePushState = 'ok' | 'running' | 'failed';

export interface PhonePush {
  state: PhonePushState;
  at: string;
  error: string | null;
}

export interface Phone {
  id: string;
  name: string;
  mac: string;
  model: PhoneModel;
  /** Nebenstelle = SIP-Benutzer */
  extension: string;
  /** Anzeigename am Telefon und bei Angerufenen */
  displayName: string;
  /** Anmeldename an der Anlage, leer = Nebenstelle */
  authUser: string;
  hasPassword: boolean;
  /** Letzter Abruf der Konfiguration */
  lastSeenAt: string | null;
  lastIp: string | null;
  firmware: string | null;
  /** Letzte Übertragung der Tasten an das Telefon (nur seit dem Serverstart) */
  push: PhonePush | null;
}

export const phoneInputSchema = z.object({
  name: text(60).min(1, 'Name fehlt'),
  mac: z
    .string()
    .trim()
    .toLowerCase()
    .transform((m) => (/^[0-9a-f]{12}$/.test(m.replace(/[-:.]/g, '')) ? m.replace(/[-:.]/g, '').replace(/(..)(?!$)/g, '$1:') : m))
    .pipe(z.string().regex(MAC_PATTERN, 'MAC-Adresse im Format 00:04:13:aa:bb:cc')),
  model: z.enum(PHONE_MODELS).default('d385'),
  extension,
  displayName: text(60).default(''),
  authUser: text(60).default(''),
  /** Leer bzw. weggelassen = unverändert */
  sipPassword: z.string().max(100).optional(),
});
export type PhoneInput = z.input<typeof phoneInputSchema>;
export type PhoneData = z.output<typeof phoneInputSchema>;

/** Gemeinsame Einstellungen aller Telefone */
export const phoneConfigSchema = z.object({
  /** SIP-Server (Telefonanlage), z. B. „192.168.1.10“ oder „pbx.elw:5060“ */
  registrar: text(120).default(''),
  outboundProxy: text(120).default(''),
  /** Kennziffer zum Heranholen eines Anrufs an einer BLF-Nebenstelle, z. B. „*8“ – leer = keine */
  pickupPrefix: z.string().trim().regex(/^[0-9*#]{0,10}$/, 'Nur Ziffern, * und #').default(''),
  ntpServer: text(120).default(''),
  /** Snom-Zeitzone, z. B. GER+1 */
  timezone: text(20).default('GER+1'),
});
export type PhoneConfigInput = z.input<typeof phoneConfigSchema>;
export type PhoneConfig = z.output<typeof phoneConfigSchema>;

export interface PhoneSystemStatus {
  config: PhoneConfig;
  /** Geheimer Teil der Provisionierungs-URL */
  token: string;
  /** Zugang zur Weboberfläche der Telefone (setzt ELVIS bei der Provisionierung) */
  adminUser: string;
  adminPassword: string;
}

/** Tastenbeschriftung und Ziel einer Taste ohne Kontaktauflösung (Nummer, BLF) */
export function phoneKeyTitle(k: PhoneKey | null): string {
  if (!k || k.type === 'empty') return '';
  if (k.type === 'number') return k.label || k.number;
  if (k.type === 'blf') return k.label || k.extension;
  return k.label;
}
