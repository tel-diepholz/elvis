import { z } from 'zod';
import { phoneKey } from './telephony';

/**
 * Nachrichten: SMS und Messenger (Signal, Threema, WhatsApp, Telegram) in einer gemeinsamen Ansicht. Jeder Messenger
 * ist ein eigenes Fahrzeugmodul mit Treiber; SMS laufen über das Modul Telefonie (GSM-Gateway).
 */

export const CHAT_CHANNELS = ['sms', 'signal', 'threema', 'whatsapp', 'telegram'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

/** Messenger mit eigenem Fahrzeugmodul (alles außer SMS) */
export const MESSENGER_IDS = ['signal', 'threema', 'whatsapp', 'telegram'] as const;
export type MessengerId = (typeof MESSENGER_IDS)[number];

export const CHAT_CHANNEL_LABEL: Record<ChatChannel, string> = {
  sms: 'SMS',
  signal: 'Signal',
  threema: 'Threema',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
};

/** Vorgabe für den Kanal einer neuen Nachricht: der erste erreichbare in dieser Reihenfolge */
export const DEFAULT_CHANNEL_ORDER: ChatChannel[] = ['signal', 'threema', 'whatsapp', 'telegram', 'sms'];

export const isMessenger = (c: string): c is MessengerId => (MESSENGER_IDS as readonly string[]).includes(c);

// --- Zustand eines Messenger-Moduls ---

export type MessengerStatus = 'connected' | 'connecting' | 'setup' | 'error' | 'offline';

/**
 * Einrichtung, die im Modul noch aussteht: start = Konto einrichten (Aktionen je Treiber), qr = QR-Code scannen (den
 * Inhalt liefert nur die Admin-Route, nicht der öffentliche Gerätezustand), code/password = Bestätigungscode bzw.
 * 2FA-Passwort eingeben, info = nur Hinweis (z. B. Moduleinstellungen fehlen)
 */
export interface MessengerSetup {
  step: 'start' | 'qr' | 'code' | 'password' | 'info';
  hint: string;
  /** Letzter Fehler der Einrichtung (z. B. falscher Code) */
  error?: string | null;
}

/** Einrichtungsdaten für Admins (nicht im öffentlichen Gerätezustand) */
export interface MessengerSetupInfo {
  channel: MessengerId;
  driver: string;
  setup: MessengerSetup | null;
  /** Inhalt des QR-Codes (z. B. Signal-Kopplungslink) */
  qr: string | null;
  /** Webhook beim Cloud-Relay: diese Adresse (und bei Meta das Prüf-Token) beim Dienst eintragen */
  webhook: { url: string; verifyToken: string | null } | null;
}

export const messengerSetupSchema = z.object({
  action: z.enum(['link', 'register', 'login', 'code', 'password', 'cancel', 'logout']),
  /** Rufnummer bei der Registrierung, Code, Passwort, Captcha … */
  number: z.string().trim().max(40).optional(),
  code: z.string().trim().max(40).optional(),
  password: z.string().max(200).optional(),
  captcha: z.string().trim().max(4000).optional(),
  voice: z.boolean().optional(),
});
export type MessengerSetupInput = z.infer<typeof messengerSetupSchema>;

/**
 * Standort aus einem Kartenlink im Text (Google Maps, OpenStreetMap, geo:) – Signal und manche Apps teilen Standorte so
 */
export function parseLocationLink(text: string): { lat: number; lon: number } | null {
  const patterns = [
    /geo:(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/i,
    /maps\.google\.[a-z.]+\/(?:maps)?\?(?:[^\s]*&)?q=(-?\d{1,2}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i,
    /google\.[a-z.]+\/maps\/(?:search\/|place\/[^/\s]+\/)?@?(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/i,
    /google\.[a-z.]+\/maps\?(?:[^\s]*&)?q=(-?\d{1,2}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i,
    /openstreetmap\.org\/\?(?:[^\s]*&)?mlat=(-?\d{1,2}\.\d+)&mlon=(-?\d{1,3}\.\d+)/i,
    /openstreetmap\.org\/[^\s]*#map=\d+\/(-?\d{1,2}\.\d+)\/(-?\d{1,3}\.\d+)/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
}

export interface MessengerState {
  status: MessengerStatus;
  /** Eigenes Konto: Rufnummer, Threema-ID o. Ä.; null = noch nicht eingerichtet */
  account: string | null;
  /** Verbindung zum Dienst bzw. zum lokalen Hilfsdienst (signal-cli, Relay); null beim Simulator */
  link: { connected: boolean; target: string; error: string | null; lastEventAt: string | null } | null;
  capabilities: {
    images: boolean;
    /** Kann andere Dateien als Bilder übertragen (PDF, Office …) */
    files: boolean;
    location: boolean;
    /** Kann prüfen, ob eine Rufnummer den Messenger nutzt */
    reachability: boolean;
  };
  setup: MessengerSetup | null;
}

// --- Nachrichten ---

export type ChatFolder = 'inbox' | 'sent';
export type ChatStatus = 'received' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export const CHAT_STATUS_LABEL: Record<ChatStatus, string> = {
  received: 'empfangen',
  sending: 'wird gesendet',
  sent: 'gesendet',
  delivered: 'zugestellt',
  read: 'gelesen',
  failed: 'fehlgeschlagen',
};

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ChatLocation {
  lat: number;
  lon: number;
  /** z. B. Ortsname oder Adresse */
  label: string;
}

export interface ChatMessage {
  id: number;
  channel: ChatChannel;
  folder: ChatFolder;
  /** Kennung der Gegenstelle im Kanal: Rufnummer, Threema-ID, Telegram-ID … */
  peer: string;
  /** Rufnummer der Gegenstelle (Vergleichsschlüssel), falls bekannt */
  number: string | null;
  /** Kontaktname zur Rufnummer, sonst der Name, den der Messenger liefert */
  name: string | null;
  text: string;
  attachment: ChatAttachment | null;
  location: ChatLocation | null;
  /** Nur SMS: Port am GSM-Gateway */
  port: number | null;
  status: ChatStatus;
  error: string | null;
  seen: boolean;
  date: string;
  createdBy: string;
  /** Gespräch, zu dem die Nachricht gehört (siehe ChatThread.key) */
  thread: string;
}

export interface ChatList {
  items: ChatMessage[];
  unread: number;
}

/**
 * Gespräch mit einer Gegenstelle über alle Kanäle. Schlüssel: „contact:<id>“ für einen Kontakt (alle seine Rufnummern),
 * sonst die Rufnummer, ohne Rufnummer „<kanal>:<kennung>“ (z. B. Threema-ID).
 */
export interface ChatThread {
  key: string;
  contactId: number | null;
  /** Kontaktname bzw. Name aus dem Messenger */
  name: string | null;
  /** Rufnummern im Gespräch, die zuletzt genutzte zuerst */
  numbers: string[];
  /** Kennung im Kanal, wenn es keine Rufnummer gibt */
  peer: string | null;
  /** Genutzte Kanäle, der zuletzt genutzte zuerst */
  channels: ChatChannel[];
  last: ChatMessage;
  unread: number;
  count: number;
}

/** Gesprächsschlüssel aus Rufnummer bzw. Kanal und Kennung (Kontakt: contact:<id>) */
export function chatThreadKey(m: Pick<ChatMessage, 'channel' | 'peer' | 'number'>, contactId?: number | null): string {
  if (contactId != null) return `contact:${contactId}`;
  return m.number ?? `${m.channel}:${m.peer}`;
}

export interface ChatChannelInfo {
  channel: ChatChannel;
  label: string;
  available: boolean;
  /** Eigenes Konto (Rufnummer, ID) */
  account: string | null;
  status: MessengerStatus;
  images: boolean;
  /** Andere Dateien als Bilder (PDF, Office …) */
  files: boolean;
  location: boolean;
  reachability: boolean;
  /** WhatsApp Cloud API: freie Nachrichten nur bis 24 h nach der letzten Nachricht der Gegenstelle */
  window24h: boolean;
}

export interface ChatAvailability {
  /** Mindestens ein Kanal verfügbar */
  available: boolean;
  channels: ChatChannelInfo[];
  order: ChatChannel[];
  /** SMS: Trunks am Gateway */
  ports: { port: number; name: string; status: string }[];
  defaultPort: number | null;
}

/** Rufnummer (Vergleichsschlüssel) → Kanäle, über die sie erreichbar ist (in der eingestellten Reihenfolge) */
export type ChatReachability = Record<string, ChatChannel[]>;

/** Vorschlag im Empfängerfeld */
export interface ChatSuggestion {
  number: string;
  name: string;
  label: string;
  source: 'contact' | 'chat';
}

// --- Senden ---

export const CHAT_TEXT_MAX = 4000;
export const CHAT_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;
/** Bildtypen, die sich verschicken lassen */
export const CHAT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/** Als Bild anzeigen und senden; alles andere geht als Datei */
export const isChatImage = (mimeType: string): boolean => CHAT_IMAGE_TYPES.includes(mimeType);

/** Dokument aus der Dokumentverwaltung als Anhang einer Nachricht */
export const chatFromDocumentSchema = z.object({ documentId: z.number().int().positive() });

export const chatLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  label: z.string().trim().max(200).default(''),
});

/** Telefonnummer oder Kennung im Kanal (Threema-ID, Telegram-Benutzername) */
export const chatRecipientSchema = z.object({
  channel: z.enum(CHAT_CHANNELS),
  to: z.string().trim().min(1, 'Empfänger fehlt').max(64),
});
export type ChatRecipient = z.output<typeof chatRecipientSchema>;

/** Bild einer Nachricht in die Dokumente eines Einsatzes übernehmen; folderId null = oberste Ebene */
export const chatToDocumentSchema = z.object({
  incidentId: z.number().int().positive(),
  folderId: z.number().int().positive().nullable().default(null),
  description: z.string().trim().max(500).default(''),
});
export type ChatToDocument = z.input<typeof chatToDocumentSchema>;

export const chatDraftSchema = z
  .object({
    to: z.array(chatRecipientSchema).min(1, 'Mindestens ein Empfänger').max(20, 'Höchstens 20 Empfänger'),
    text: z.string().trim().max(CHAT_TEXT_MAX, `Höchstens ${CHAT_TEXT_MAX} Zeichen`).default(''),
    /** Vorher aus den Dokumenten übernommener Anhang (Bild oder Datei) */
    attachmentId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable()
      .default(null),
    location: chatLocationSchema.nullable().default(null),
    /** SMS: Port am Gateway; fehlt er, gilt der Standard aus den Moduleinstellungen */
    port: z.number().int().min(1).max(32).optional(),
  })
  .refine((d) => d.text !== '' || d.attachmentId !== null || d.location !== null, { message: 'Text fehlt', path: ['text'] });
export type ChatDraft = z.input<typeof chatDraftSchema>;

export const chatSettingsSchema = z.object({
  order: z
    .array(z.enum(CHAT_CHANNELS))
    .refine((o) => new Set(o).size === o.length && o.length === CHAT_CHANNELS.length, 'Jeder Kanal genau einmal'),
});
export type ChatSettings = z.output<typeof chatSettingsSchema>;

/** Sieht die Eingabe wie eine Rufnummer aus? (sonst Kennung im Kanal) */
export const looksLikePhone = (s: string) => /^\+?[\d\s/()-]{3,30}$/.test(s.trim());

/** Rufnummer bzw. Kennung normalisieren: Rufnummern → phoneKey, Threema-IDs groß, Telegram-Namen ohne @ */
export function chatPeer(channel: ChatChannel, to: string): { number: string | null; peer: string } {
  const t = to.trim();
  if (looksLikePhone(t)) {
    const n = phoneKey(t);
    return { number: n, peer: n };
  }
  if (channel === 'threema') return { number: null, peer: t.toUpperCase() };
  if (channel === 'telegram') return { number: null, peer: t.replace(/^@/, '') };
  return { number: null, peer: t };
}

/** Kartenlink für einen Standort (z. B. in einer SMS) */
export const locationLink = (l: Pick<ChatLocation, 'lat' | 'lon'>) => `https://www.openstreetmap.org/?mlat=${l.lat.toFixed(6)}&mlon=${l.lon.toFixed(6)}#map=17/${l.lat.toFixed(6)}/${l.lon.toFixed(6)}`;
