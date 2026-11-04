import { z } from 'zod';
import { messagingVehicleSchema, regionArsSchema, type ConversationState, type MessagingVehicle } from './messagingrelay';

/**
 * Cloud Messaging: Chat zwischen ELVIS-Installationen über das Cloud-Relay (Protokoll: messagingrelay.ts).
 * Voraussetzung ist ein aktives ELVIS-Postfach – dessen OpenPGP-Schlüssel verschlüsselt und signiert alles.
 */

// --- Umschlag (Klartext vor der Verschlüsselung) ---

export const crewMemberSchema = z.object({ name: z.string().max(100), roles: z.array(z.string().max(100)).max(20) });
export type CrewMember = z.infer<typeof crewMemberSchema>;

const base = {
  v: z.literal(1),
  /** Kennung der Nachricht beim Absender (gegen doppelte Zustellung) */
  id: z.string().min(1).max(64),
  sentAt: z.string(),
  /** Wer in der absendenden Installation geschrieben hat */
  sender: crewMemberSchema,
};

/**
 * Inhalt einer Nachricht zwischen Installationen. Neue Arten (z. B. eine synchrone Lagekarte) kommen als weiteres
 * `kind` dazu; was eine Installation nicht kennt, legt sie ins Bedienprotokoll und verwirft es ohne Fehler.
 */
export const envelopeSchema = z.discriminatedUnion('kind', [
  /** Chat-Anfrage: wer fragt, von welchem Fahrzeug */
  z.object({ ...base, kind: z.literal('request'), vehicle: messagingVehicleSchema, crew: z.array(crewMemberSchema).max(50) }),
  /** Besetzung: angemeldete Benutzer mit ihren Rollen (nach dem Annehmen und bei jeder Änderung) */
  z.object({ ...base, kind: z.literal('crew'), crew: z.array(crewMemberSchema).max(50) }),
  z.object({ ...base, kind: z.literal('text'), text: z.string().max(4000) }),
  /** Datei: verschlüsselter Inhalt beim Relay; Schlüssel (AES-256-GCM, base64) und Prüfsumme reisen hier mit */
  z.object({
    ...base,
    kind: z.literal('file'),
    text: z.string().max(4000).default(''),
    name: z.string().min(1).max(200),
    mimeType: z.string().min(1).max(200),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    key: z.string().min(1).max(100),
  }),
  z.object({ ...base, kind: z.literal('location'), text: z.string().max(4000).default(''), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), label: z.string().max(200).default('') }),
]);
export type Envelope = z.infer<typeof envelopeSchema>;
export type EnvelopeKind = Envelope['kind'];

// --- API von ELVIS ---

/** Verbindung zum Relay: connected = WebSocket offen (Push), polling = WebSocket gestört, Abruf jede Minute */
export type MessagingConnection = 'disabled' | 'connecting' | 'connected' | 'polling';

export interface MessagingStatus {
  /** Cloud-Anbindung eingerichtet (app.relayUrl) */
  enabled: boolean;
  /** Aktives ELVIS-Postfach vorhanden (Voraussetzung) */
  mailbox: boolean;
  registered: boolean;
  profile: { regionArs: string; regionLabel: string; listed: boolean; address: string; fingerprint: string; vehicle: MessagingVehicle } | null;
  connection: MessagingConnection;
  /** Seit wann der aktuelle Verbindungszustand gilt */
  since: string | null;
  lastError: string | null;
}

export const messagingRegisterSchema = z.object({
  regionArs: regionArsSchema,
  listed: z.boolean().default(true),
});
export type MessagingRegisterInput = z.input<typeof messagingRegisterSchema>;

export const messagingConnectSchema = z.object({ elwId: z.string().uuid() });

export interface MessagingPeer {
  elwId: string;
  vehicle: MessagingVehicle;
  regionLabel: string;
  address: string;
  fingerprint: string;
}

export interface MessagingConversation {
  id: string;
  peer: MessagingPeer;
  /** out: diese Installation hat angefragt */
  direction: 'in' | 'out';
  state: ConversationState;
  /** Wer angefragt hat (bei eingehenden Anfragen die Person in der anderen Installation) */
  requestedBy: CrewMember | null;
  /** Besetzung der Gegenseite (erst nach dem Annehmen) */
  peerCrew: CrewMember[];
  /** Wer hier angenommen, abgelehnt oder beendet hat */
  decidedBy: string | null;
  /** Gesprächsschlüssel in den Nachrichten (siehe ChatThread.key) */
  threadKey: string;
  createdAt: string;
  updatedAt: string;
}

export const MESSAGING_STATE_LABEL: Record<ConversationState, string> = {
  requested: 'angefragt',
  accepted: 'verbunden',
  declined: 'abgelehnt',
  closed: 'beendet',
};

/** Fahrzeug kurz: „ELW 1 · Florian Stuhr 12/11-1“ */
export const vehicleLabel = (v: Pick<MessagingVehicle, 'name' | 'callsign'>) => [v.name, v.callsign].filter(Boolean).join(' · ');
export const crewLabel = (m: CrewMember) => (m.roles.length ? `${m.name} (${m.roles.join(', ')})` : m.name);
