import { z } from 'zod';
import { MAX_CONTACT_PHONES } from './contacts';
import { MAC_PATTERN } from './workstations';

/**
 * Tischtelefone (Snom D385) an der Telefonanlage des ELW. ELVIS provisioniert sie über eine Abruf-URL (SIP-Konto,
 * Telefonbuch aus den Kontakten, Durchsage-Zonen, Funktionstasten) und überträgt geänderte Tasten sofort an das Telefon.
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

/** Höchstzahl der Durchsage-Zonen (Snom: mc_address 1–10) */
export const MAX_PAGING_ZONES = 10;

/** Multicast-Adresse mit Port, z. B. „239.0.0.1:5000“ (224.0.0.0–239.255.255.255) */
export const multicastAddress = z
  .string()
  .trim()
  .refine((v) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(v);
    if (!m) return false;
    const [a, b, c, d, port] = m.slice(1).map(Number) as [number, number, number, number, number];
    return a >= 224 && a <= 239 && [b, c, d].every((x) => x <= 255) && port >= 1024 && port <= 65535;
  }, 'Multicast-Adresse mit Port, z. B. 239.0.0.1:5000');

export const PHONE_KEY_TYPE = {
  contact: 'Kontakt',
  number: 'Nummer',
  blf: 'Nebenstelle (BLF)',
  paging: 'Durchsage',
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
  /** Durchsage (Multicast) in eine Zone; leere Adresse = Zone am Telefon auswählen */
  z.object({ type: z.literal('paging'), address: z.union([z.literal(''), multicastAddress]).default(''), label: text(40).default('') }),
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

/**
 * Durchsage-Zone: Alle Telefone hören auf die Multicast-Adresse. Bei mehreren gleichzeitigen Durchsagen gewinnt die
 * höchste Priorität.
 */
export const pagingZoneSchema = z.object({
  name: text(30).min(1, 'Name der Zone fehlt'),
  address: multicastAddress,
  /** 0 (niedrig) bis 10 (hoch), Snom-Vorgabe 5 */
  priority: z.number().int().min(0).max(10).default(5),
  /** Durchsage unterbricht ein laufendes Gespräch (danach geht es weiter); sonst nur, wenn das Telefon frei ist */
  interrupt: z.boolean().default(false),
  /** Mit voller Lautstärke wiedergeben */
  loud: z.boolean().default(false),
});
export type PagingZoneInput = z.input<typeof pagingZoneSchema>;
export type PagingZone = z.output<typeof pagingZoneSchema>;

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
  /** Durchsage-Zonen (Multicast), auf die alle Telefone hören */
  pagingZones: z
    .array(pagingZoneSchema)
    .max(MAX_PAGING_ZONES, `Höchstens ${MAX_PAGING_ZONES} Zonen`)
    .refine((zs) => new Set(zs.map((z) => z.address)).size === zs.length, 'Jede Multicast-Adresse nur einmal')
    .default([]),
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
  if (k.type === 'paging') return k.label || k.address || 'Durchsage';
  return k.label;
}
