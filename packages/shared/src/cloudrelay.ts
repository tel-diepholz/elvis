/**
 * Cloud-Zugang (Datenpflege): Verknüpfung einer ELVIS-Installation mit einem Knoten der Baustruktur im Portal
 * cloud.einsatzleitwagen.app. Gegenstück im Relay: src/cloudprotocol.ts (tel-diepholz/elvis-relay) – den Teil
 * „ELVIS ↔ Relay“ dort und hier gleich halten.
 *
 * Aufrufe unter /v1/elws/me/cloud sind wie der Mail-Abruf signiert (MAIL_SIGNATURE_HEADER, mailSignaturePayload), aber
 * mit einem eigenen Ed25519-Schlüssel der Verknüpfung – ein Postfach ist nicht nötig.
 */
import { z } from 'zod';

/** Verknüpfungscode: 8 Zeichen ohne Verwechsler, gilt eine Stunde */
export const CLOUD_LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CLOUD_LINK_CODE_LENGTH = 8;
export const CLOUD_LINK_TTL_MS = 3600_000;

export const cloudLinkRequestSchema = z.object({
  /** Name der Installation, wie er im Portal erscheint (Vorgabe: Fahrzeugname) */
  name: z.string().trim().min(1).max(80),
  /** Öffentlicher Ed25519-Schlüssel (raw, base64url); signiert schon diesen Aufruf */
  sigPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  version: z.string().max(40).default(''),
});
export type CloudLinkRequest = z.input<typeof cloudLinkRequestSchema>;

/** Knoten der Baustruktur: „Niedersachsen › Landkreis Diepholz › Weyhe“ */
export interface CloudNodeRef {
  id: string;
  name: string;
  /** Namen von oben nach unten, ohne Deutschland, inkl. des Knotens selbst */
  path: string[];
}

export type CloudLinkStatus =
  | { state: 'none' }
  | { state: 'pending'; code: string; expiresAt: string }
  | { state: 'linked'; node: CloudNodeRef; linkedAt: string; linkedBy: string };

// --- Nur ELVIS ---

/** Zustand für Einstellungen → Cloud */
export interface CloudStatus {
  /** Relay eingerichtet (app.relayUrl) */
  available: boolean;
  /** Adresse des Portals */
  portalUrl: string;
  link: CloudLinkStatus;
  /** Relay nicht erreichbar o. Ä.; link ist dann der zuletzt bekannte Stand */
  error: string | null;
  checkedAt: string | null;
}

export const cloudLinkInputSchema = z.object({ name: z.string().trim().min(1, 'Name fehlt').max(80) });

/** Code zum Abtippen: ABCD-EFGH */
export const formatLinkCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);
