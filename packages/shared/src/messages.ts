import { z } from 'zod';

/**
 * Meldungen zwischen Stab und Fernmeldern im Einsatz.
 * Ausgang: eine Rolle schreibt an eine Kraft (oder Freitext), ein Fernmelder übernimmt, übermittelt und antwortet.
 * Eingang: ein Fernmelder erfasst einen Funkspruch; ist ein Dispatcher angemeldet, verteilt er ihn an die Zielrolle,
 * sonst wählt der Fernmelder die Zielrolle selbst.
 */

export const MESSAGE_BODY_MAX = 4000;
export const MESSAGE_PARTY_MAX = 120;
/** „In 2 min erneut versuchen“ */
export const MESSAGE_REMIND_MINUTES = 2;

export type MessageDirection = 'out' | 'in';

/** Kraft aus dem Einsatz (unitId), Systemeinheit aus dem Katalog (forceUnitId, z. B. Leitstelle) oder Freitext; text ist immer der Anzeigename */
export const messagePartySchema = z.object({
  unitId: z.number().int().positive().nullable().default(null),
  forceUnitId: z.number().int().positive().nullable().default(null),
  text: z.string().trim().min(1, 'Angabe fehlt').max(MESSAGE_PARTY_MAX),
});
export type MessagePartyInput = z.input<typeof messagePartySchema>;

const body = z.string().trim().min(1, 'Text fehlt').max(MESSAGE_BODY_MAX, `Text höchstens ${MESSAGE_BODY_MAX} Zeichen`);
const id = z.number().int().positive();

export const messageInputSchema = z.discriminatedUnion('direction', [
  z.object({
    direction: z.literal('out'),
    senderRoleId: id,
    recipient: messagePartySchema,
    body,
    /** Antwort auf eine Eingangsmeldung – diese gilt damit als zur Kenntnis genommen */
    replyToId: id.nullable().default(null),
    /** Ausgangsmeldung zu einer Anforderung */
    requestId: id.nullable().default(null),
  }),
  z.object({
    direction: z.literal('in'),
    sender: messagePartySchema,
    /** Pflicht, solange kein Dispatcher angemeldet ist; sonst verteilt der Dispatcher */
    recipientRoleId: id.nullable().default(null),
    body,
    /** Aus einer E-Mail im Posteingang erfasst: die Kraft bzw. Systemeinheit (sender) merkt sich die Absenderadresse */
    mailId: id.nullable().default(null),
  }),
]);
export type MessageInput = z.input<typeof messageInputSchema>;

export const messageClaimSchema = z.object({ force: z.boolean().default(false) });
export const messageReplySchema = z.object({ body });
export const messageRouteSchema = z.object({ roleId: id });
export const messageSnoozeSchema = z.object({ minutes: z.number().int().min(1).max(240).default(MESSAGE_REMIND_MINUTES) });

/**
 * Was der anfragende Benutzer mit der Meldung tun soll:
 * radio = Ausgang übermitteln, dispatch = Eingang verteilen, recipient = Eingang zur Kenntnis nehmen, reply = Antwort lesen,
 * copy = Kopie lesen
 */
export type MessagePending = 'radio' | 'dispatch' | 'recipient' | 'reply' | 'copy';

/** Kopie an eine Rolle (Einstellung „alle Eingangs-/Ausgangsmeldungen in Kopie“), gelesen beim Öffnen */
export interface MessageCopy {
  roleId: number;
  role: string;
  ackAt: string | null;
  ackBy: string | null;
}

export interface Message {
  id: number;
  incidentId: number;
  direction: MessageDirection;
  /** Markdown */
  body: string;
  senderRoleId: number | null;
  senderUnitId: number | null;
  /** Systemeinheit aus dem Katalog, die nicht im Einsatz ist */
  senderForceUnitId: number | null;
  /** Anzeigename: Rolle (Ausgang) bzw. Kraft/Freitext (Eingang) */
  sender: string;
  recipientRoleId: number | null;
  recipientUnitId: number | null;
  recipientForceUnitId: number | null;
  /** Anzeigename; null = Eingang wartet auf Verteilung */
  recipient: string | null;
  claimedByUserId: number | null;
  claimedBy: string | null;
  claimedAt: string | null;
  remindAt: string | null;
  /** Wie oft „erneut versuchen“ gewählt wurde und zuletzt wann, von wem, um wie viele Minuten */
  snoozeCount: number;
  snoozedAt: string | null;
  snoozedBy: string | null;
  snoozeMinutes: number | null;
  reply: string | null;
  repliedAt: string | null;
  repliedBy: string | null;
  doneAt: string | null;
  doneBy: string | null;
  ackAt: string | null;
  ackBy: string | null;
  replyToId: number | null;
  requestId: number | null;
  copies: MessageCopy[];
  createdAt: string;
  createdBy: string;
  /** Aufgabe des anfragenden Benutzers, null = nichts zu tun */
  pending: MessagePending | null;
  /** Betrifft den anfragenden Benutzer: eigene Rolle als Absender, Ziel oder Kopie, selbst erfasst oder bearbeitet – auch wenn erledigt */
  mine: boolean;
}

/** Braucht jetzt Aufmerksamkeit – beim Fernmelder bzw. Dispatcher nach „erneut versuchen“ erst, wenn die Zeit um ist */
export function messageNeedsAttention(m: Pick<Message, 'pending' | 'remindAt'>, now: Date | number): boolean {
  if (m.pending === null) return false;
  const handling = m.pending === 'radio' || m.pending === 'dispatch';
  return !handling || m.remindAt === null || Date.parse(m.remindAt) <= +now;
}

export type MessageState = 'open' | 'claimed' | 'routed' | 'replied' | 'done';

export function messageState(m: Pick<Message, 'direction' | 'doneAt' | 'reply' | 'claimedBy' | 'recipient'>): MessageState {
  if (m.reply !== null) return 'replied';
  if (m.doneAt) return 'done';
  if (m.direction === 'in' && m.recipient !== null) return 'routed';
  return m.claimedBy ? 'claimed' : 'open';
}

// --- Einstellungen (nur Admins) ---

export const messageSettingsSchema = z.object({
  /** Rollen, die Ausgangsmeldungen übermitteln und Eingangsmeldungen erfassen */
  radioRoleIds: z.array(id).max(50).transform((ids) => [...new Set(ids)]),
  /** Rollen, die Eingangsmeldungen verteilen */
  dispatcherRoleIds: z.array(id).max(50).transform((ids) => [...new Set(ids)]),
  /** Rollen, die alle Eingangs- bzw. Ausgangsmeldungen in Kopie bekommen (z. B. S2 für das Lagebild) */
  copyInRoleIds: z.array(id).max(50).default([]).transform((ids) => [...new Set(ids)]),
  copyOutRoleIds: z.array(id).max(50).default([]).transform((ids) => [...new Set(ids)]),
});
export type MessageSettingsInput = z.input<typeof messageSettingsSchema>;

export interface MessageSettings {
  radioRoleIds: number[];
  dispatcherRoleIds: number[];
  copyInRoleIds: number[];
  copyOutRoleIds: number[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_MESSAGE_SETTINGS = { radioRoleIds: [] as number[], dispatcherRoleIds: [] as number[], copyInRoleIds: [] as number[], copyOutRoleIds: [] as number[] };

/** Für das Meldungsformular: welche Rollen ich habe und ob ein Dispatcher angemeldet ist */
export interface MessageContext {
  radio: boolean;
  dispatcher: boolean;
  dispatcherPresent: boolean;
  radioConfigured: boolean;
}
