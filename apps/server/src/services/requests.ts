import {
  PROCUREMENT_MODE_LABELS,
  REQUEST_STATUS_LABELS,
  formatDtg,
  requestFollowUpSchema,
  requestForwardSchema,
  requestFollowUpSummary,
  requestInputSchema,
  requestLabel,
  requestNoteSchema,
  requestOpen,
  requestPatchSchema,
  requestSettingsSchema,
  requestStatusSchema,
  requestTransitions,
  type Incident,
  type JournalEntry,
  type MaterialRequest,
  type MessagePartyInput,
  type RequestForwardInput,
  type RequestInput,
  type RequestNoteInput,
  type RequestPatch,
  type RequestSettings,
  type RequestSettingsInput,
  type RequestStatus,
  type RequestStatusInput,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { MessageService } from './messages.js';
import type { RoleService } from './roles.js';
import type { TaskActor, TaskService, TaskViewer } from './tasks.js';

const SETTINGS_KEY = 'requests:settings';

interface RequestRow {
  id: number;
  incident_id: number;
  number: number;
  unit_id: number | null;
  unit_text: string;
  material: string;
  needed_by: string | null;
  status: RequestStatus;
  status_at: string;
  status_by: string;
  follow_up_at: string;
  source_message_id: number | null;
  forwarded_at: string | null;
  forwarded_by: string | null;
  created_at: string;
  created_by: string;
  task_id: number | null;
}

const REQUEST_SELECT = `
  SELECT q.*, (SELECT t.id FROM tasks t WHERE t.request_id = q.id) AS task_id
  FROM requests q`;

const iso = (ms: number) => new Date(ms).toISOString();
const dtg = (at: string) => formatDtg(new Date(at));
const needed = (at: string | null) => (at === null ? 'sofort' : `bis ${dtg(at)}`);
/** Erste Zeile des Materials für Tagebuch und Listen */
const short = (material: string) => {
  const line = material.split('\n')[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * Materialanforderungen im Einsatz. Anlegen darf jeder (z. B. aus einer Meldung); Status, Wiedervorlage und Weiterleitung
 * führt die Beschaffungsrolle – ist sie nicht eingestellt oder von niemandem besetzt, alle. Jede offene Anforderung hält
 * genau eine Wiedervorlage-Aufgabe für die Beschaffungsrolle aktuell. Im Modus „Stab“ geht die Anforderung als
 * Ausgangsmeldung an den Stab; dessen Rückmeldungen werden als Status mit Notiz nachgetragen.
 */
export class RequestService {
  constructor(
    private readonly db: Db,
    private readonly deps: {
      store: Store;
      roles: RoleService;
      tasks: TaskService;
      messages: MessageService;
      notify: (topics: Topic[]) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // --- Einstellungen ---

  settings(): RequestSettings {
    const r = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
    const value = r ? (JSON.parse(r.value) as Partial<RequestSettings>) : {};
    // Gelöschte Rolle fällt heraus
    const roleId = value.procurementRoleId ?? null;
    return {
      procurementRoleId: roleId !== null && this.deps.roles.find(roleId) ? roleId : null,
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.updated_by ?? null,
    };
  }

  setSettings(raw: RequestSettingsInput, actor: string): RequestSettings {
    const input = requestSettingsSchema.parse(raw);
    if (input.procurementRoleId !== null && !this.deps.roles.find(input.procurementRoleId)) throw new HttpError(400, 'Rolle nicht gefunden');
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(SETTINGS_KEY, JSON.stringify(input), iso(this.now()), actor);
    // Offene Wiedervorlagen gehen an die neue Rolle
    this.deps.store.transaction(() => {
      const open = this.db.prepare(`${REQUEST_SELECT} WHERE q.status IN ('planned', 'approved', 'ordered')`).all() as RequestRow[];
      for (const r of open) this.syncTask(r, actor);
    });
    this.deps.notify(['requests', 'tasks']);
    return this.settings();
  }

  /** Beschaffungsrolle des Betrachters – oder niemand ist zuständig, dann alle */
  private canManage(viewer: TaskViewer | null, roleId = this.settings().procurementRoleId): boolean {
    if (!viewer) return false;
    if (roleId === null) return true;
    return viewer.roleIds.includes(roleId) || !this.deps.roles.holderIds().get(roleId)?.size;
  }

  private requireManage(viewer: TaskViewer): void {
    if (!this.canManage(viewer)) throw new HttpError(403, 'Anforderungen führt die Beschaffungsrolle');
  }

  // --- Lesen ---

  private toRequest(r: RequestRow, messageIds: number[], canManage: boolean): MaterialRequest {
    return {
      id: r.id,
      incidentId: r.incident_id,
      number: r.number,
      unitId: r.unit_id,
      unit: r.unit_text,
      material: r.material,
      neededBy: r.needed_by,
      status: r.status,
      statusAt: r.status_at,
      statusBy: r.status_by,
      followUpAt: r.follow_up_at,
      sourceMessageId: r.source_message_id,
      forwardedAt: r.forwarded_at,
      forwardedBy: r.forwarded_by,
      taskId: r.task_id,
      messageIds,
      createdAt: r.created_at,
      createdBy: r.created_by,
      canManage,
    };
  }

  private messageIds(where: string, id: number): Map<number, number[]> {
    const rows = this.db.prepare(`SELECT m.id, m.request_id FROM messages m JOIN requests q ON q.id = m.request_id WHERE ${where} = ? ORDER BY m.id`).all(id) as { id: number; request_id: number }[];
    const map = new Map<number, number[]>();
    for (const m of rows) map.set(m.request_id, [...(map.get(m.request_id) ?? []), m.id]);
    return map;
  }

  private row(id: number): RequestRow {
    const r = this.db.prepare(`${REQUEST_SELECT} WHERE q.id = ?`).get(id) as RequestRow | undefined;
    if (!r) throw new HttpError(404, 'Anforderung nicht gefunden');
    return r;
  }

  private requireOpen(incidentId: number): Incident {
    const incident = this.deps.store.incident(incidentId);
    if (!incident) throw new HttpError(404, `Einsatz ${incidentId} nicht gefunden`);
    if (incident.closedAt) throw new HttpError(409, 'Einsatz ist abgeschlossen und kann nicht mehr geändert werden');
    return incident;
  }

  list(incidentId: number, viewer: TaskViewer | null): MaterialRequest[] {
    if (!this.deps.store.incident(incidentId)) throw new HttpError(404, `Einsatz ${incidentId} nicht gefunden`);
    const manage = this.canManage(viewer);
    const rows = this.db.prepare(`${REQUEST_SELECT} WHERE q.incident_id = ? ORDER BY q.number DESC`).all(incidentId) as RequestRow[];
    const messages = this.messageIds('q.incident_id', incidentId);
    return rows.map((r) => this.toRequest(r, messages.get(r.id) ?? [], manage));
  }

  get(id: number, viewer: TaskViewer | null): MaterialRequest {
    return this.toRequest(this.row(id), this.messageIds('q.id', id).get(id) ?? [], this.canManage(viewer));
  }

  /** Verlauf: Tagebucheinträge mit Bezug auf die Anforderung */
  journal(id: number): JournalEntry[] {
    const r = this.row(id);
    return this.deps.store.journal(r.incident_id).filter((e) => e.requestId === id);
  }

  // --- Schreiben ---

  /** Kraft nur, wenn sie zu diesem Einsatz gehört – sonst bleibt es beim Freitext */
  private unit(incidentId: number, p: MessagePartyInput): [number | null, string] {
    const unit = p.unitId ? this.deps.store.unit(p.unitId) : null;
    return [unit && unit.incidentId === incidentId ? unit.id : null, p.text.trim()];
  }

  private journalEntry(r: Pick<RequestRow, 'id' | 'incident_id' | 'number'>, text: string, author: string): void {
    this.deps.store.addJournal(r.incident_id, { category: 'system', text: `Anforderung ${requestLabel(r)}: ${text}`, requestId: r.id }, author);
  }

  /** Wiedervorlage-Aufgabe an den Stand der Anforderung angleichen */
  private syncTask(r: RequestRow, actor: string): void {
    const unit = r.unit_text;
    const lines = [
      `${requestLabel(r)} für ${unit}: ${r.material}`,
      '',
      `Bedarf: ${needed(r.needed_by)} · Status: ${REQUEST_STATUS_LABELS[r.status]}${r.forwarded_at ? ` · an den Stab gesendet ${dtg(r.forwarded_at)}` : ''}`,
    ];
    this.deps.tasks.syncRequestTask(
      {
        requestId: r.id,
        incidentId: r.incident_id,
        summary: requestFollowUpSummary({ number: r.number, unit }),
        description: lines.join('\n'),
        roleId: this.settings().procurementRoleId,
        dueAt: r.follow_up_at,
        closed: !requestOpen(r.status),
      },
      actor,
    );
  }

  private assertFuture(at: string): void {
    if (Date.parse(at) <= this.now()) throw new HttpError(400, 'Die Wiedervorlage muss in der Zukunft liegen');
  }

  create(incidentId: number, raw: RequestInput, actor: TaskActor, viewer: TaskViewer): MaterialRequest {
    this.requireOpen(incidentId);
    const input = requestInputSchema.parse(raw);
    this.assertFuture(input.followUpAt);
    if (input.sourceMessageId !== null) {
      const m = this.db.prepare('SELECT incident_id FROM messages WHERE id = ?').get(input.sourceMessageId) as { incident_id: number } | undefined;
      if (m?.incident_id !== incidentId) throw new HttpError(400, 'Meldung nicht gefunden');
    }
    const [unitId, unitText] = this.unit(incidentId, input.unit);
    const ts = iso(this.now());
    const id = this.deps.store.transaction(() => {
      const { n } = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM requests WHERE incident_id = ?').get(incidentId) as { n: number };
      const info = this.db
        .prepare(
          `INSERT INTO requests (incident_id, number, unit_id, unit_text, material, needed_by, status, status_at, status_by, follow_up_at, source_message_id,
             created_at, created_by, created_by_user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(incidentId, n, unitId, unitText, input.material, input.neededBy, ts, actor.name, input.followUpAt, input.sourceMessageId, ts, actor.name, actor.id, ts);
      const r = this.row(Number(info.lastInsertRowid));
      this.journalEntry(r, `${unitText} fordert an: ${short(r.material)} (Bedarf ${needed(r.needed_by)})${input.sourceMessageId !== null ? ' – aus Meldung' : ''}`, actor.name);
      this.syncTask(r, actor.name);
      // Anforderung aus einer Eingangsmeldung: die Meldung gilt damit als zur Kenntnis genommen
      if (input.sourceMessageId !== null) this.deps.messages.acknowledgeIfPending(input.sourceMessageId, actor, viewer);
      return r.id;
    });
    this.deps.notify(input.sourceMessageId !== null ? ['requests', 'tasks', 'journal', 'messages'] : ['requests', 'tasks', 'journal']);
    return this.get(id, viewer);
  }

  /** Kraft, Material und Bedarf korrigieren */
  update(id: number, raw: RequestPatch, actor: TaskActor, viewer: TaskViewer): MaterialRequest {
    const current = this.row(id);
    this.requireOpen(current.incident_id);
    const input = requestPatchSchema.parse(raw);
    const [unitId, unitText] = this.unit(current.incident_id, input.unit);
    const changed = [
      unitText !== current.unit_text && 'Kraft',
      input.material !== current.material && 'Material',
      input.neededBy !== current.needed_by && 'Bedarf',
    ].filter(Boolean);
    if (!changed.length && unitId === current.unit_id) return this.get(id, viewer);
    this.deps.store.transaction(() => {
      this.db.prepare('UPDATE requests SET unit_id = ?, unit_text = ?, material = ?, needed_by = ?, updated_at = ? WHERE id = ?').run(unitId, unitText, input.material, input.neededBy, iso(this.now()), id);
      if (changed.length) this.journalEntry(current, `geändert (${changed.join(', ')})`, actor.name);
      this.syncTask(this.row(id), actor.name);
    });
    this.deps.notify(['requests', 'tasks', 'journal']);
    return this.get(id, viewer);
  }

  /** Statuswechsel; bleibt die Anforderung offen, mit neuer Wiedervorlage. Eine Notiz (z. B. Rückmeldung des Stabs) geht ins Tagebuch */
  setStatus(id: number, raw: RequestStatusInput, actor: TaskActor, viewer: TaskViewer): MaterialRequest {
    const current = this.row(id);
    const incident = this.requireOpen(current.incident_id);
    this.requireManage(viewer);
    const input = requestStatusSchema.parse(raw);
    if (!requestTransitions(current.status, incident.procurementMode).includes(input.status)) {
      throw new HttpError(400, `Von „${REQUEST_STATUS_LABELS[current.status]}“ nicht nach „${REQUEST_STATUS_LABELS[input.status]}“`);
    }
    const open = requestOpen(input.status);
    if (open && input.followUpAt === null) throw new HttpError(400, 'Wiedervorlage fehlt');
    if (open) this.assertFuture(input.followUpAt!);
    const ts = iso(this.now());
    this.deps.store.transaction(() => {
      this.db
        .prepare('UPDATE requests SET status = ?, status_at = ?, status_by = ?, follow_up_at = COALESCE(?, follow_up_at), updated_at = ? WHERE id = ?')
        .run(input.status, ts, actor.name, open ? input.followUpAt : null, ts, id);
      const followUp = open ? `, Wiedervorlage ${dtg(input.followUpAt!)}` : '';
      this.journalEntry(current, `${REQUEST_STATUS_LABELS[input.status]}${followUp}${input.note ? ` – ${input.note}` : ''}`, actor.name);
      this.syncTask(this.row(id), actor.name);
    });
    this.deps.notify(['requests', 'tasks', 'journal']);
    return this.get(id, viewer);
  }

  setFollowUp(id: number, raw: { followUpAt: string }, actor: TaskActor, viewer: TaskViewer): MaterialRequest {
    const current = this.row(id);
    this.requireOpen(current.incident_id);
    this.requireManage(viewer);
    if (!requestOpen(current.status)) throw new HttpError(409, 'Anforderung ist abgeschlossen');
    const { followUpAt } = requestFollowUpSchema.parse(raw);
    this.assertFuture(followUpAt);
    this.deps.store.transaction(() => {
      this.db.prepare('UPDATE requests SET follow_up_at = ?, updated_at = ? WHERE id = ?').run(followUpAt, iso(this.now()), id);
      this.journalEntry(current, `Wiedervorlage ${dtg(followUpAt)}`, actor.name);
      this.syncTask(this.row(id), actor.name);
    });
    this.deps.notify(['requests', 'tasks', 'journal']);
    return this.get(id, viewer);
  }

  /** Modus „Stab“: Anforderung als Ausgangsmeldung an den Stab, die Wiedervorlage erinnert ans Nachfassen */
  forward(id: number, raw: RequestForwardInput, actor: TaskActor, viewer: TaskViewer): MaterialRequest {
    const current = this.row(id);
    const incident = this.requireOpen(current.incident_id);
    this.requireManage(viewer);
    if (incident.procurementMode !== 'staff') throw new HttpError(409, `Beschaffung im Einsatz: ${PROCUREMENT_MODE_LABELS[incident.procurementMode]} – keine Weiterleitung an den Stab`);
    if (!requestOpen(current.status)) throw new HttpError(409, 'Anforderung ist abgeschlossen');
    const input = requestForwardSchema.parse(raw);
    this.assertFuture(input.followUpAt);
    const ts = iso(this.now());
    this.deps.store.transaction(() => {
      this.deps.messages.create(current.incident_id, { direction: 'out', senderRoleId: input.senderRoleId, recipient: input.recipient, body: input.body, requestId: id }, actor, viewer);
      this.db.prepare('UPDATE requests SET forwarded_at = ?, forwarded_by = ?, follow_up_at = ?, updated_at = ? WHERE id = ?').run(ts, actor.name, input.followUpAt, ts, id);
      this.journalEntry(current, `an ${input.recipient.text.trim()} gesendet, Wiedervorlage ${dtg(input.followUpAt)}`, actor.name);
      this.syncTask(this.row(id), actor.name);
    });
    this.deps.notify(['requests', 'tasks', 'journal', 'messages']);
    return this.get(id, viewer);
  }

  /**
   * Eingangsmeldung anhängen (z. B. Rückmeldung des Stabs); eine bereits angehängte wandert zur neuen Anforderung.
   * Steht sie für den Betrachter zur Kenntnisnahme an, gilt sie damit als zur Kenntnis genommen.
   */
  attachMessage(id: number, messageId: number, actor: TaskActor, viewer: TaskViewer): MaterialRequest {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    const m = this.db.prepare('SELECT incident_id, direction, request_id, sender_text FROM messages WHERE id = ?').get(messageId) as
      | { incident_id: number; direction: 'in' | 'out'; request_id: number | null; sender_text: string }
      | undefined;
    if (m?.incident_id !== r.incident_id) throw new HttpError(400, 'Meldung nicht gefunden');
    if (m.direction !== 'in') throw new HttpError(400, 'Nur Eingangsmeldungen lassen sich anhängen');
    this.deps.store.transaction(() => {
      if (m.request_id !== id) {
        this.db.prepare('UPDATE messages SET request_id = ?, updated_at = ? WHERE id = ?').run(id, iso(this.now()), messageId);
        this.journalEntry(r, `Eingangsmeldung #${messageId} von ${m.sender_text} angehängt`, actor.name);
      }
      this.deps.messages.acknowledgeIfPending(messageId, actor, viewer);
    });
    this.deps.notify(['requests', 'messages', 'journal']);
    return this.get(id, viewer);
  }

  /** Notiz ins Einsatztagebuch mit Bezug auf die Anforderung */
  addNote(id: number, raw: RequestNoteInput, actor: TaskActor): JournalEntry {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    const input = requestNoteSchema.parse(raw);
    const entry = this.deps.store.addJournal(
      r.incident_id,
      { category: input.category, text: `Anforderung ${requestLabel(r)}: ${input.text}`, important: input.important, requestId: id },
      actor.name,
    );
    this.deps.notify(['journal', 'requests']);
    return entry;
  }
}
