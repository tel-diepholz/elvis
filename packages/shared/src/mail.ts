import { z } from 'zod';
import { mailboxRequestSchema, type MailboxState, type StatusLevel } from './mailrelay';

/**
 * E-Mail: ein Postfach je ELW (<name>@einsatzleitwagen.app) über das Cloud-Relay. ELVIS erzeugt den OpenPGP-Schlüssel
 * selbst, der private Schlüssel verlässt den ELW nie. Ausgehende Mails werden verschlüsselt, wenn für alle
 * Empfänger ein Schlüssel bekannt ist (Autocrypt, WKD, Import), sonst nur signiert – nach Bestätigung.
 */

/** Zustand aus Sicht von ELVIS; „lost“: ELVIS kennt ein Postfach, das Relay ordnet es dieser Installation nicht mehr zu */
export type MailAccountState = MailboxState | 'lost';

export interface MailAccountStatus {
  /** mail.enabled in config/elvis.json und ein Relay eingetragen */
  enabled: boolean;
  relayUrl: string | null;
  state: MailAccountState;
  address: string | null;
  fingerprint: string | null;
  adminEmail: string | null;
  requestedAt: string | null;
  activatedAt: string | null;
  keysMailedAt: string | null;
  lastFetchAt: string | null;
  lastFetchCountry: string | null;
  lastPollAt: string | null;
  lastError: string | null;
  /** Gesamtstatus des Relays (Statusseite), null = unbekannt */
  relayHealth: StatusLevel | null;
}

export const mailAccountRequestSchema = z.object({
  localpart: mailboxRequestSchema.shape.localpart,
  adminEmail: mailboxRequestSchema.shape.adminEmail,
  /** new: neues Postfach; rebind: bestehendes Postfach nach Neuinstallation übernehmen */
  mode: z.enum(['new', 'rebind']).default('new'),
});
export type MailAccountRequest = z.input<typeof mailAccountRequestSchema>;

export type MailFolder = 'inbox' | 'sent';
/** e2e: Ende zu Ende verschlüsselt · relay: unverschlüsselt übertragen, beim Eingang im Relay verschlüsselt · none: unverschlüsselt */
export type MailEncryption = 'e2e' | 'relay' | 'none';
export type MailSignature = 'valid' | 'invalid' | 'unknown-key' | 'none';

export interface MailSummary {
  id: number;
  folder: MailFolder;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  seen: boolean;
  encryption: MailEncryption;
  signature: MailSignature;
  attachments: number;
  snippet: string;
}

export interface MailAttachment {
  id: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface MailMessage extends Omit<MailSummary, 'attachments'> {
  messageId: string | null;
  replyTo: string | null;
  text: string;
  /** HTML-Teil (nur in einer Sandbox anzeigen) */
  html: string | null;
  attachments: MailAttachment[];
  /** Absender, wie in der Mail angegeben (für Antworten) */
  fromAddress: string;
}

export interface MailList {
  items: MailSummary[];
  unread: number;
}

export interface MailRecipientKey {
  address: string;
  /** Schlüssel bekannt: an diese Adresse wird verschlüsselt */
  encrypt: boolean;
  fingerprint: string | null;
  source: 'autocrypt' | 'wkd' | 'manual' | null;
}

const address = z.string().trim().toLowerCase().email('Adresse ungültig');
/** Anhänge insgesamt höchstens (Base64 kommt noch dazu, das Relay nimmt 25 MB) */
export const MAIL_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export const mailDraftSchema = z
  .object({
    to: z.array(address).min(1, 'Mindestens ein Empfänger').max(50),
    cc: z.array(address).max(50).default([]),
    bcc: z.array(address).max(50).default([]),
    subject: z.string().max(998).default(''),
    text: z.string().max(1_000_000).default(''),
    attachments: z
      .array(z.object({ filename: z.string().trim().min(1).max(255), contentType: z.string().max(255).default('application/octet-stream'), data: z.string() }))
      .max(20)
      .default([]),
    /** Antwort auf diese Mail (Bezug im Kopf) */
    replyToId: z.number().int().positive().optional(),
    /** Fehlt für einen Empfänger der Schlüssel, nur mit dieser Bestätigung unverschlüsselt senden */
    allowUnencrypted: z.boolean().default(false),
  })
  .refine((d) => d.to.length + d.cc.length + d.bcc.length <= 50, 'Höchstens 50 Empfänger')
  .refine((d) => d.attachments.reduce((n, a) => n + Math.floor((a.data.length * 3) / 4), 0) <= MAIL_MAX_ATTACHMENT_BYTES, 'Anhänge zu groß (zusammen höchstens 15 MB)');
export type MailDraft = z.input<typeof mailDraftSchema>;

export const mailKeyImportSchema = z.object({ publicKey: z.string().min(100).max(50_000) });

export interface MailSendResult {
  id: number;
  encrypted: boolean;
}
