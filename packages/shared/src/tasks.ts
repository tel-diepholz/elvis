import { z } from 'zod';

/** Rollen und Aufgaben im Einsatz. Rollen pflegen Admins; jede Sitzung übernimmt höchstens eine Rolle. */

export interface Role {
  id: number;
  name: string;
  description: string;
  sort: number;
}

/** Rolle mit den Benutzern, die sie gerade (in einer gültigen Sitzung) übernommen haben */
export interface RoleInfo extends Role {
  holders: string[];
}

export const roleInputSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt').max(60),
  description: z.string().trim().max(300).default(''),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

/** Rolle der eigenen Sitzung wählen; null = ohne Rolle */
export const roleChoiceSchema = z.object({ roleId: z.number().int().positive().nullable() });

export const TASK_SUMMARY_MAX = 50;
/** Intervall wiederkehrender Aufgaben: 1 min bis 7 Tage */
export const TASK_INTERVAL_MIN = 1;
export const TASK_INTERVAL_MAX = 7 * 24 * 60;

/** Wer die Aufgabe bekommt: alle, ein Benutzer (nur man selbst) oder eine Rolle */
export const taskAssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('user'), userId: z.number().int().positive() }),
  z.object({ kind: z.literal('role'), roleId: z.number().int().positive() }),
]);
export type TaskAssignee = z.infer<typeof taskAssigneeSchema>;

const interval = z.number().int().min(TASK_INTERVAL_MIN, 'Intervall zu kurz').max(TASK_INTERVAL_MAX, 'Intervall zu lang (höchstens 7 Tage)');
const isoTime = z.string().datetime({ offset: true });

/** Einmalig (optional mit Fälligkeit) oder wiederkehrend ab der ersten Fälligkeit */
export const taskScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), dueAt: isoTime.nullable() }),
  z.object({ kind: z.literal('interval'), intervalMinutes: interval, dueAt: isoTime }),
]);
export type TaskSchedule = z.infer<typeof taskScheduleSchema>;

const taskBase = {
  summary: z.string().trim().min(1, 'Kurztext fehlt').max(TASK_SUMMARY_MAX, `Kurztext höchstens ${TASK_SUMMARY_MAX} Zeichen`),
  description: z.string().trim().max(4000).default(''),
  documentTemplateId: z.number().int().positive().nullable().default(null),
};

export const taskInputSchema = z.object({ ...taskBase, assignee: taskAssigneeSchema, schedule: taskScheduleSchema });
export type TaskInput = z.input<typeof taskInputSchema>;

export interface Task {
  id: number;
  incidentId: number;
  /** Kurztext für Listen (max. 50 Zeichen) */
  summary: string;
  description: string;
  documentTemplateId: number | null;
  documentTemplateName: string | null;
  assignee: TaskAssignee;
  /** Anzeigename des Verantwortlichen (Benutzer oder Rolle), null = alle */
  assigneeName: string | null;
  intervalMinutes: number | null;
  /** Planmäßige Fälligkeit (bei wiederkehrenden die nächste); null = ohne Termin */
  dueAt: string | null;
  /** Geschoben bis – überdeckt dueAt, bis die Aufgabe erledigt ist */
  snoozedUntil: string | null;
  /** Einmalige erledigt bzw. Serie beendet */
  doneAt: string | null;
  doneBy: string | null;
  /** Letzte Erledigung (bei wiederkehrenden die des letzten Durchgangs) */
  lastDoneAt: string | null;
  lastDoneBy: string | null;
  createdAt: string;
  createdBy: string;
  /** Erscheint in „Meine Aufgaben“ des anfragenden Benutzers */
  mine: boolean;
  /** Rolle ist im Einsatz von niemandem besetzt – deshalb für alle sichtbar */
  roleVacant: boolean;
}

export const taskSchedule = (t: Pick<Task, 'intervalMinutes' | 'dueAt'>): TaskSchedule =>
  t.intervalMinutes !== null && t.dueAt !== null ? { kind: 'interval', intervalMinutes: t.intervalMinutes, dueAt: t.dueAt } : { kind: 'once', dueAt: t.dueAt };

/** Tatsächliche Fälligkeit (geschoben oder planmäßig) */
export const taskDueAt = (t: Pick<Task, 'dueAt' | 'snoozedUntil'>): string | null => t.snoozedUntil ?? t.dueAt;

export function taskIsDue(t: Pick<Task, 'dueAt' | 'snoozedUntil' | 'doneAt'>, now: Date | number): boolean {
  const due = taskDueAt(t);
  return !t.doneAt && due !== null && Date.parse(due) <= +now;
}

/** Nächste planmäßige Fälligkeit nach einer Erledigung: im festen Takt, aber nicht in der Vergangenheit */
export function nextIntervalDue(dueAt: string, intervalMinutes: number, now: Date | number): string {
  const step = intervalMinutes * 60_000;
  let next = Date.parse(dueAt) + step;
  if (next <= +now) next += Math.ceil((+now - next + 1) / step) * step;
  return new Date(next).toISOString();
}

export const snoozeSchema = z.union([
  z.object({ minutes: z.number().int().min(1).max(TASK_INTERVAL_MAX) }),
  z.object({ until: isoTime }),
]);
export type SnoozeInput = z.infer<typeof snoozeSchema>;

/** Erledigt; bei wiederkehrenden beendet `final` die Serie, sonst wird der nächste Durchgang fällig */
export const taskDoneSchema = z.object({ final: z.boolean().default(false) });

// --- Aufgabenvorlagen (beim Eröffnen eines Einsatzes angelegt) ---

/** Zeiten relativ zum Einsatzbeginn in Minuten */
export const taskTemplateScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), offsetMinutes: z.number().int().min(0).max(TASK_INTERVAL_MAX).nullable() }),
  z.object({ kind: z.literal('interval'), intervalMinutes: interval, offsetMinutes: z.number().int().min(0).max(TASK_INTERVAL_MAX) }),
]);
export type TaskTemplateSchedule = z.infer<typeof taskTemplateScheduleSchema>;

export const taskTemplateInputSchema = z.object({
  ...taskBase,
  roleId: z.number().int().positive().nullable().default(null),
  schedule: taskTemplateScheduleSchema,
});
export type TaskTemplateInput = z.input<typeof taskTemplateInputSchema>;

export interface TaskTemplate {
  id: number;
  summary: string;
  description: string;
  documentTemplateId: number | null;
  documentTemplateName: string | null;
  roleId: number | null;
  roleName: string | null;
  schedule: TaskTemplateSchedule;
  sort: number;
}

export const idOrderSchema = z.object({ ids: z.array(z.number().int().positive()).max(500) });

/** „1 h 30 min“, „45 min“, „2 Tage“ */
export function fmtInterval(min: number): string {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d && `${d} ${d === 1 ? 'Tag' : 'Tage'}`, h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ') || '0 min';
}
