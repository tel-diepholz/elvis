import { z } from 'zod';
import type { JournalCategory } from './incident';
import { messagePartySchema } from './messages';

/**
 * Materialanforderungen im Einsatz: eine Kraft braucht Material (sofort oder bis zu einem Zeitpunkt).
 * Die Beschaffungsrolle (Einstellungen) plant, genehmigt und bestellt – im Modus „selbst“ lokal, im Modus „Stab“
 * per Ausgangsmeldung an den Stab, dessen Rückmeldungen sie nachträgt. Jede offene Anforderung hat eine
 * Wiedervorlage, aus der eine Aufgabe für die Beschaffungsrolle entsteht.
 */

export const REQUEST_MATERIAL_MAX = 2000;

export type RequestStatus = 'planned' | 'approved' | 'ordered' | 'delivered' | 'rejected' | 'cancelled';

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  planned: 'Geplant',
  approved: 'Genehmigt',
  ordered: 'Bestellt',
  delivered: 'Geliefert',
  rejected: 'Abgelehnt',
  cancelled: 'Storniert',
};

export const REQUEST_STATUSES = Object.keys(REQUEST_STATUS_LABELS) as [RequestStatus, ...RequestStatus[]];

/** Erlaubte Statuswechsel; Geliefert, Abgelehnt und Storniert sind Endzustände */
export const REQUEST_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  planned: ['approved', 'rejected', 'cancelled'],
  approved: ['ordered', 'rejected', 'cancelled'],
  ordered: ['delivered', 'cancelled'],
  delivered: [],
  rejected: [],
  cancelled: [],
};

export const requestOpen = (status: RequestStatus): boolean => REQUEST_TRANSITIONS[status].length > 0;

/** Über den Stab bestellt der Stab – dort folgt auf Genehmigt direkt Geliefert */
export function requestTransitions(status: RequestStatus, mode: ProcurementMode): RequestStatus[] {
  if (mode === 'self' || status !== 'approved') return REQUEST_TRANSITIONS[status];
  return ['delivered', 'rejected', 'cancelled'];
}

/** Beschaffung im Einsatz: selbst (lokal geführt) oder über den Stab (Ausgangsmeldung) */
export type ProcurementMode = 'self' | 'staff';

export const PROCUREMENT_MODE_LABELS: Record<ProcurementMode, string> = {
  self: 'Selbst beschaffen',
  staff: 'Über den Stab',
};

const isoTime = z.string().datetime({ offset: true });
const material = z.string().trim().min(1, 'Material fehlt').max(REQUEST_MATERIAL_MAX, `Material höchstens ${REQUEST_MATERIAL_MAX} Zeichen`);
const id = z.number().int().positive();
const note = z.string().trim().max(4000);

export const requestInputSchema = z.object({
  /** Anfordernde Kraft aus dem Einsatz oder Freitext */
  unit: messagePartySchema,
  material,
  /** null = sofort */
  neededBy: isoTime.nullable().default(null),
  followUpAt: isoTime,
  /** Meldung, aus der die Anforderung entstand */
  sourceMessageId: id.nullable().default(null),
});
export type RequestInput = z.input<typeof requestInputSchema>;

export const requestPatchSchema = z.object({
  unit: messagePartySchema,
  material,
  neededBy: isoTime.nullable(),
});
export type RequestPatch = z.input<typeof requestPatchSchema>;

/** Neuer Status; bleibt die Anforderung offen, ist eine neue Wiedervorlage Pflicht */
export const requestStatusSchema = z.object({
  status: z.enum(REQUEST_STATUSES),
  followUpAt: isoTime.nullable().default(null),
  note: note.default(''),
});
export type RequestStatusInput = z.input<typeof requestStatusSchema>;

export const requestFollowUpSchema = z.object({ followUpAt: isoTime });

/** An den Stab senden (Modus „Stab“): Ausgangsmeldung im Namen einer eigenen Rolle, mit neuer Wiedervorlage */
export const requestForwardSchema = z.object({
  senderRoleId: id,
  recipient: messagePartySchema,
  body: z.string().trim().min(1, 'Text fehlt').max(4000),
  followUpAt: isoTime,
});
export type RequestForwardInput = z.input<typeof requestForwardSchema>;

/** Eingangsmeldung an eine Anforderung anhängen, z. B. die Rückmeldung des Stabs */
export const requestAttachSchema = z.object({ messageId: id });

const noteCategories = ['lage', 'auftrag', 'meldung', 'funk', 'telefon', 'entscheidung', 'sonstiges'] as const satisfies readonly JournalCategory[];

/** Notiz ins Einsatztagebuch mit Verweis auf die Anforderung */
export const requestNoteSchema = z.object({
  category: z.enum(noteCategories).default('sonstiges'),
  text: note.min(1, 'Text fehlt'),
  important: z.boolean().default(false),
});
export type RequestNoteInput = z.input<typeof requestNoteSchema>;

export interface MaterialRequest {
  id: number;
  incidentId: number;
  /** Laufende Nummer im Einsatz (Anzeige „A-3“) */
  number: number;
  unitId: number | null;
  /** Anzeigename der anfordernden Kraft */
  unit: string;
  material: string;
  /** null = sofort */
  neededBy: string | null;
  status: RequestStatus;
  statusAt: string;
  statusBy: string;
  followUpAt: string;
  sourceMessageId: number | null;
  /** An den Stab gesendet (Modus „Stab“) */
  forwardedAt: string | null;
  forwardedBy: string | null;
  /** Wiedervorlage-Aufgabe */
  taskId: number | null;
  /** Ausgangsmeldungen zu dieser Anforderung */
  messageIds: number[];
  createdAt: string;
  createdBy: string;
  /** Darf Status und Wiedervorlage führen: hält die Beschaffungsrolle – ist sie unbesetzt oder nicht eingestellt, alle */
  canManage: boolean;
}

export const requestLabel = (r: Pick<MaterialRequest, 'number'>): string => `A-${r.number}`;

export function requestOverdue(r: Pick<MaterialRequest, 'status' | 'followUpAt'>, now: Date | number): boolean {
  return requestOpen(r.status) && Date.parse(r.followUpAt) <= +now;
}

/** Kurztext der Wiedervorlage-Aufgabe (max. TASK_SUMMARY_MAX) */
export function requestFollowUpSummary(r: Pick<MaterialRequest, 'number' | 'unit'>): string {
  return `Wiedervorlage ${requestLabel(r)}: ${r.unit}`.slice(0, 50);
}

// --- Einstellungen (nur Admins) ---

export const requestSettingsSchema = z.object({
  /** Rolle, die Anforderungen führt und die Wiedervorlagen bekommt */
  procurementRoleId: id.nullable(),
});
export type RequestSettingsInput = z.input<typeof requestSettingsSchema>;

export interface RequestSettings {
  procurementRoleId: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}
