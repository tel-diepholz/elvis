import {
  fullName,
  nextIntervalDue,
  taskInputSchema,
  taskTemplateInputSchema,
  type Incident,
  type SnoozeInput,
  type Task,
  type TaskInput,
  type TaskTemplate,
  type TaskTemplateInput,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { RoleService } from './roles.js';

interface TaskRow {
  id: number;
  incident_id: number;
  summary: string;
  description: string;
  document_template_id: number | null;
  template_name: string | null;
  assignee_user_id: number | null;
  user_first: string | null;
  user_last: string | null;
  assignee_role_id: number | null;
  role_name: string | null;
  interval_minutes: number | null;
  due_at: string | null;
  snoozed_until: string | null;
  done_at: string | null;
  done_by: string | null;
  last_done_at: string | null;
  last_done_by: string | null;
  created_at: string;
  created_by: string;
  request_id: number | null;
}

interface TemplateRow {
  id: number;
  summary: string;
  description: string;
  document_template_id: number | null;
  template_name: string | null;
  role_id: number | null;
  role_name: string | null;
  interval_minutes: number | null;
  offset_minutes: number | null;
  sort: number;
}

const TASK_SELECT = `
  SELECT t.*, tpl.name AS template_name, u.first_name AS user_first, u.last_name AS user_last, r.name AS role_name
  FROM tasks t
  LEFT JOIN templates tpl ON tpl.id = t.document_template_id
  LEFT JOIN users u ON u.id = t.assignee_user_id
  LEFT JOIN roles r ON r.id = t.assignee_role_id`;

const TEMPLATE_SELECT = `
  SELECT tt.*, tpl.name AS template_name, r.name AS role_name
  FROM task_templates tt
  LEFT JOIN templates tpl ON tpl.id = tt.document_template_id
  LEFT JOIN roles r ON r.id = tt.role_id`;

/** Wer fragt: Benutzer und Rollen seiner Sitzung */
export interface TaskViewer {
  userId: number;
  roleIds: number[];
}

export interface TaskActor {
  id: number;
  name: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Aufgaben im Einsatz. Verteilung: ohne Verantwortlichen an alle; an einen Benutzer (nur sich selbst);
 * an eine Rolle – an alle, die sie (auch neben weiteren Rollen) übernommen haben; ist sie von niemandem besetzt, sehen sie alle.
 * Einmalige Aufgaben werden erledigt, wiederkehrende rücken im festen Takt weiter, bis die Serie beendet wird.
 * Schieben setzt snoozed_until, die planmäßige Fälligkeit (und damit der Takt) bleibt unberührt.
 */
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly deps: {
      store: Store;
      roles: RoleService;
      notify: (topics: Topic[]) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private toTask(r: TaskRow, viewer: TaskViewer | null, holders: Map<number, Set<number>>): Task {
    const roleVacant = r.assignee_role_id !== null && !holders.get(r.assignee_role_id)?.size;
    const mine =
      !viewer ||
      (r.assignee_user_id === null && r.assignee_role_id === null) ||
      r.assignee_user_id === viewer.userId ||
      (r.assignee_role_id !== null && (roleVacant || viewer.roleIds.includes(r.assignee_role_id)));
    return {
      id: r.id,
      incidentId: r.incident_id,
      summary: r.summary,
      description: r.description,
      documentTemplateId: r.document_template_id,
      documentTemplateName: r.template_name,
      assignee:
        r.assignee_user_id !== null
          ? { kind: 'user', userId: r.assignee_user_id }
          : r.assignee_role_id !== null
            ? { kind: 'role', roleId: r.assignee_role_id }
            : { kind: 'all' },
      assigneeName: r.user_first !== null ? fullName({ firstName: r.user_first, lastName: r.user_last ?? '' }) : r.role_name,
      intervalMinutes: r.interval_minutes,
      dueAt: r.due_at,
      snoozedUntil: r.snoozed_until,
      doneAt: r.done_at,
      doneBy: r.done_by,
      lastDoneAt: r.last_done_at,
      lastDoneBy: r.last_done_by,
      createdAt: r.created_at,
      createdBy: r.created_by,
      mine,
      roleVacant,
      requestId: r.request_id,
    };
  }

  private row(id: number): TaskRow {
    const r = this.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
    if (!r) throw new HttpError(404, 'Aufgabe nicht gefunden');
    return r;
  }

  private requireOpen(incidentId: number): Incident {
    const incident = this.deps.store.incident(incidentId);
    if (!incident) throw new HttpError(404, `Einsatz ${incidentId} nicht gefunden`);
    if (incident.closedAt) throw new HttpError(409, 'Einsatz ist abgeschlossen und kann nicht mehr geändert werden');
    return incident;
  }

  private assertTemplate(id: number | null): void {
    if (id !== null && !this.db.prepare('SELECT 1 FROM templates WHERE id = ?').get(id)) throw new HttpError(400, 'Dokumentvorlage nicht gefunden');
  }

  private assertRole(id: number | null): void {
    if (id !== null && !this.deps.roles.find(id)) throw new HttpError(400, 'Rolle nicht gefunden');
  }

  private journal(incidentId: number, text: string, author: string): void {
    this.deps.store.addJournal(incidentId, { category: 'system', text }, author);
  }

  // --- Aufgaben ---

  list(incidentId: number, viewer: TaskViewer | null): Task[] {
    if (!this.deps.store.incident(incidentId)) throw new HttpError(404, `Einsatz ${incidentId} nicht gefunden`);
    const holders = this.deps.roles.holderIds();
    const rows = this.db.prepare(`${TASK_SELECT} WHERE t.incident_id = ? ORDER BY COALESCE(t.snoozed_until, t.due_at) IS NULL, COALESCE(t.snoozed_until, t.due_at), t.id`).all(incidentId) as TaskRow[];
    return rows.map((r) => this.toTask(r, viewer, holders));
  }

  get(id: number, viewer: TaskViewer | null): Task {
    return this.toTask(this.row(id), viewer, this.deps.roles.holderIds());
  }

  /** Zuweisung an Benutzer nur an sich selbst – oder eine bestehende Zuweisung unverändert lassen */
  private assigneeColumns(input: TaskInput, actor: TaskActor, current?: TaskRow): [number | null, number | null] {
    const a = input.assignee;
    if (a.kind === 'user') {
      if (a.userId !== actor.id && a.userId !== current?.assignee_user_id) throw new HttpError(403, 'Aufgaben für andere Benutzer bitte über deren Rolle vergeben');
      return [a.userId, null];
    }
    if (a.kind === 'role') {
      this.assertRole(a.roleId);
      return [null, a.roleId];
    }
    return [null, null];
  }

  create(incidentId: number, raw: TaskInput, actor: TaskActor, viewer: TaskViewer): Task {
    this.requireOpen(incidentId);
    const input = taskInputSchema.parse(raw);
    this.assertTemplate(input.documentTemplateId);
    const [userId, roleId] = this.assigneeColumns(input, actor);
    const ts = iso(this.now());
    const info = this.db
      .prepare(
        `INSERT INTO tasks (incident_id, summary, description, document_template_id, assignee_user_id, assignee_role_id, interval_minutes, due_at, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        incidentId,
        input.summary,
        input.description,
        input.documentTemplateId,
        userId,
        roleId,
        input.schedule.kind === 'interval' ? input.schedule.intervalMinutes : null,
        input.schedule.dueAt,
        ts,
        actor.name,
        ts,
      );
    this.deps.notify(['tasks']);
    return this.get(Number(info.lastInsertRowid), viewer);
  }

  /** Neue Fälligkeit hebt ein Schieben auf */
  update(id: number, raw: TaskInput, actor: TaskActor, viewer: TaskViewer): Task {
    const current = this.row(id);
    this.requireOpen(current.incident_id);
    const input = taskInputSchema.parse(raw);
    this.assertTemplate(input.documentTemplateId);
    const [userId, roleId] = this.assigneeColumns(input, actor, current);
    const dueChanged = input.schedule.dueAt !== current.due_at;
    this.db
      .prepare(
        `UPDATE tasks SET summary = ?, description = ?, document_template_id = ?, assignee_user_id = ?, assignee_role_id = ?,
           interval_minutes = ?, due_at = ?, snoozed_until = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.summary,
        input.description,
        input.documentTemplateId,
        userId,
        roleId,
        input.schedule.kind === 'interval' ? input.schedule.intervalMinutes : null,
        input.schedule.dueAt,
        dueChanged ? null : current.snoozed_until,
        iso(this.now()),
        id,
      );
    this.deps.notify(['tasks']);
    return this.get(id, viewer);
  }

  /** Erledigt: einmalige bzw. mit `final` die ganze Serie; sonst rückt die wiederkehrende zum nächsten Termin */
  done(id: number, final: boolean, actor: TaskActor, viewer: TaskViewer): Task {
    const t = this.row(id);
    this.requireOpen(t.incident_id);
    if (t.done_at) throw new HttpError(409, 'Aufgabe ist bereits erledigt');
    const now = this.now();
    const ts = iso(now);
    const recurring = t.interval_minutes !== null && t.due_at !== null;
    this.deps.store.transaction(() => {
      if (recurring && !final) {
        const next = nextIntervalDue(t.due_at!, t.interval_minutes!, now);
        this.db.prepare('UPDATE tasks SET due_at = ?, snoozed_until = NULL, last_done_at = ?, last_done_by = ?, updated_at = ? WHERE id = ?').run(next, ts, actor.name, ts, id);
        this.journal(t.incident_id, `Aufgabe erledigt: ${t.summary} (wiederkehrend)`, actor.name);
      } else {
        this.db
          .prepare('UPDATE tasks SET done_at = ?, done_by = ?, snoozed_until = NULL, last_done_at = ?, last_done_by = ?, updated_at = ? WHERE id = ?')
          .run(ts, actor.name, ts, actor.name, ts, id);
        this.journal(t.incident_id, recurring ? `Wiederkehrende Aufgabe beendet: ${t.summary}` : `Aufgabe erledigt: ${t.summary}`, actor.name);
      }
    });
    this.deps.notify(['tasks', 'journal']);
    return this.get(id, viewer);
  }

  reopen(id: number, actor: TaskActor, viewer: TaskViewer): Task {
    const t = this.row(id);
    this.requireOpen(t.incident_id);
    if (!t.done_at) throw new HttpError(409, 'Aufgabe ist nicht erledigt');
    const ts = iso(this.now());
    this.deps.store.transaction(() => {
      this.db.prepare('UPDATE tasks SET done_at = NULL, done_by = NULL, updated_at = ? WHERE id = ?').run(ts, id);
      this.journal(t.incident_id, `Aufgabe wieder geöffnet: ${t.summary}`, actor.name);
    });
    this.deps.notify(['tasks', 'journal']);
    return this.get(id, viewer);
  }

  snooze(id: number, input: SnoozeInput, viewer: TaskViewer): Task {
    const t = this.row(id);
    this.requireOpen(t.incident_id);
    if (t.done_at) throw new HttpError(409, 'Aufgabe ist bereits erledigt');
    const now = this.now();
    const until = 'minutes' in input ? now + input.minutes * 60_000 : Date.parse(input.until);
    if (until <= now) throw new HttpError(400, 'Der neue Zeitpunkt muss in der Zukunft liegen');
    this.db.prepare('UPDATE tasks SET snoozed_until = ?, updated_at = ? WHERE id = ?').run(iso(until), iso(now), id);
    this.deps.notify(['tasks']);
    return this.get(id, viewer);
  }

  remove(id: number, actor: TaskActor): void {
    const t = this.row(id);
    this.requireOpen(t.incident_id);
    this.deps.store.transaction(() => {
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      if (!t.done_at) this.journal(t.incident_id, `Aufgabe gelöscht: ${t.summary}`, actor.name);
    });
    this.deps.notify(t.done_at ? ['tasks'] : ['tasks', 'journal']);
  }

  // --- Vorlagen ---

  private toTemplate(r: TemplateRow): TaskTemplate {
    return {
      id: r.id,
      summary: r.summary,
      description: r.description,
      documentTemplateId: r.document_template_id,
      documentTemplateName: r.template_name,
      roleId: r.role_id,
      roleName: r.role_name,
      schedule: r.interval_minutes !== null ? { kind: 'interval', intervalMinutes: r.interval_minutes, offsetMinutes: r.offset_minutes ?? r.interval_minutes } : { kind: 'once', offsetMinutes: r.offset_minutes },
      sort: r.sort,
    };
  }

  templates(): TaskTemplate[] {
    return (this.db.prepare(`${TEMPLATE_SELECT} ORDER BY tt.sort, tt.id`).all() as TemplateRow[]).map((r) => this.toTemplate(r));
  }

  private template(id: number): TaskTemplate {
    const r = this.db.prepare(`${TEMPLATE_SELECT} WHERE tt.id = ?`).get(id) as TemplateRow | undefined;
    if (!r) throw new HttpError(404, 'Aufgabenvorlage nicht gefunden');
    return this.toTemplate(r);
  }

  private templateValues(raw: TaskTemplateInput) {
    const input = taskTemplateInputSchema.parse(raw);
    this.assertTemplate(input.documentTemplateId);
    this.assertRole(input.roleId);
    const s = input.schedule;
    return [input.summary, input.description, input.documentTemplateId, input.roleId, s.kind === 'interval' ? s.intervalMinutes : null, s.offsetMinutes] as const;
  }

  createTemplate(raw: TaskTemplateInput): TaskTemplate {
    const values = this.templateValues(raw);
    const sort = (this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM task_templates').get() as { n: number }).n;
    const info = this.db
      .prepare('INSERT INTO task_templates (summary, description, document_template_id, role_id, interval_minutes, offset_minutes, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(...values, sort);
    this.deps.notify(['taskTemplates']);
    return this.template(Number(info.lastInsertRowid));
  }

  updateTemplate(id: number, raw: TaskTemplateInput): TaskTemplate {
    this.template(id);
    const values = this.templateValues(raw);
    this.db
      .prepare('UPDATE task_templates SET summary = ?, description = ?, document_template_id = ?, role_id = ?, interval_minutes = ?, offset_minutes = ? WHERE id = ?')
      .run(...values, id);
    this.deps.notify(['taskTemplates']);
    return this.template(id);
  }

  removeTemplate(id: number): TaskTemplate {
    const t = this.template(id);
    this.db.prepare('DELETE FROM task_templates WHERE id = ?').run(id);
    this.deps.notify(['taskTemplates']);
    return t;
  }

  reorderTemplates(ids: number[]): TaskTemplate[] {
    const update = this.db.prepare('UPDATE task_templates SET sort = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id, i) => update.run(i, id)))();
    this.deps.notify(['taskTemplates']);
    return this.templates();
  }

  /**
   * Wiedervorlage einer Anforderung (innerhalb der Transaktion des Aufrufers): genau eine Aufgabe je Anforderung,
   * an die Beschaffungsrolle (ohne Rolle an alle). Neue Wiedervorlage öffnet sie wieder und hebt ein Schieben auf,
   * eine abgeschlossene Anforderung erledigt sie. Tagebuch und notify übernimmt der Aufrufer.
   */
  syncRequestTask(r: { requestId: number; incidentId: number; summary: string; description: string; roleId: number | null; dueAt: string; closed: boolean }, actor: string): number | null {
    const ts = iso(this.now());
    const current = this.db.prepare('SELECT id, done_at FROM tasks WHERE request_id = ?').get(r.requestId) as { id: number; done_at: string | null } | undefined;
    if (!current) {
      if (r.closed) return null;
      const info = this.db
        .prepare(
          `INSERT INTO tasks (incident_id, summary, description, assignee_role_id, due_at, request_id, created_at, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.incidentId, r.summary, r.description, r.roleId, r.dueAt, r.requestId, ts, actor, ts);
      return Number(info.lastInsertRowid);
    }
    if (r.closed) {
      this.db
        .prepare('UPDATE tasks SET description = ?, snoozed_until = NULL, done_at = COALESCE(done_at, ?), done_by = COALESCE(done_by, ?), updated_at = ? WHERE id = ?')
        .run(r.description, ts, actor, ts, current.id);
    } else {
      this.db
        .prepare(
          `UPDATE tasks SET summary = ?, description = ?, assignee_user_id = NULL, assignee_role_id = ?, interval_minutes = NULL, due_at = ?,
             snoozed_until = NULL, done_at = NULL, done_by = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(r.summary, r.description, r.roleId, r.dueAt, ts, current.id);
    }
    return current.id;
  }

  /** Beim Eröffnen (innerhalb der Transaktion): Vorlagen als Aufgaben anlegen, Zeiten ab Einsatzbeginn */
  instantiate(incident: Incident): void {
    const start = Date.parse(incident.startedAt);
    const insert = this.db.prepare(
      `INSERT INTO tasks (incident_id, summary, description, document_template_id, assignee_role_id, interval_minutes, due_at, created_at, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
    );
    for (const t of this.templates()) {
      const s = t.schedule;
      const due = s.offsetMinutes === null ? null : iso(start + s.offsetMinutes * 60_000);
      insert.run(incident.id, t.summary, t.description, t.documentTemplateId, t.roleId, s.kind === 'interval' ? s.intervalMinutes : null, due, incident.startedAt, incident.startedAt);
    }
  }
}
