import {
  DEFAULT_MESSAGE_SETTINGS,
  messageInputSchema,
  messageSettingsSchema,
  type Incident,
  type Message,
  type MessageContext,
  type MessageCopy,
  type MessageInput,
  type MessagePartyInput,
  type MessagePending,
  type MessageSettings,
  type MessageSettingsInput,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { RoleService } from './roles.js';
import type { TaskActor, TaskViewer } from './tasks.js';

const SETTINGS_KEY = 'messages:settings';

interface MessageRow {
  id: number;
  incident_id: number;
  direction: 'out' | 'in';
  body: string;
  sender_role_id: number | null;
  sender_unit_id: number | null;
  sender_force_id: number | null;
  sender_text: string;
  recipient_role_id: number | null;
  recipient_unit_id: number | null;
  recipient_force_id: number | null;
  recipient_text: string | null;
  claimed_by_user_id: number | null;
  claimed_by: string | null;
  claimed_at: string | null;
  remind_at: string | null;
  snooze_count: number;
  snoozed_at: string | null;
  snoozed_by: string | null;
  snooze_minutes: number | null;
  reply: string | null;
  replied_at: string | null;
  replied_by: string | null;
  done_at: string | null;
  done_by: string | null;
  ack_at: string | null;
  ack_by: string | null;
  reply_to_id: number | null;
  request_id: number | null;
  created_at: string;
  created_by: string;
  created_by_user_id: number | null;
  sender_role_name: string | null;
  recipient_role_name: string | null;
}

const MESSAGE_SELECT = `
  SELECT m.*, sr.name AS sender_role_name, rr.name AS recipient_role_name
  FROM messages m
  LEFT JOIN roles sr ON sr.id = m.sender_role_id
  LEFT JOIN roles rr ON rr.id = m.recipient_role_id`;

/** Wer gerade welche Rolle hält – einmal je Anfrage ermittelt */
interface Ctx {
  settings: MessageSettings;
  holders: Map<number, Set<number>>;
  /** Benutzer mit Fernmelder- bzw. Dispatcher-Rolle */
  radioUsers: Set<number>;
  dispatcherUsers: Set<number>;
}

interface CopyRow {
  message_id: number;
  role_id: number;
  role_name: string;
  ack_at: string | null;
  ack_by: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const some = (ids: number[], roleIds: number[]) => ids.some((id) => roleIds.includes(id));

/**
 * Meldungen im Einsatz. Wer sich kümmern muss, ergibt sich aus den Rollen der Sitzungen (Einstellungen „Fernmelder“
 * und „Dispatcher“): Ausgang → Fernmelder, unverteilter Eingang → Dispatcher (ohne angemeldeten Dispatcher die Fernmelder),
 * verteilter Eingang → Zielrolle, Antwort → Absenderrolle. Wer eine Meldung übernommen hat, ist allein zuständig,
 * solange er die Rolle dafür hält.
 */
export class MessageService {
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

  // --- Einstellungen ---

  settings(): MessageSettings {
    const r = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
    const value = r ? (JSON.parse(r.value) as Partial<MessageSettings>) : {};
    // Gelöschte Rollen fallen heraus
    const known = new Set(this.deps.roles.list().map((role) => role.id));
    const s = { ...DEFAULT_MESSAGE_SETTINGS, ...value };
    return {
      radioRoleIds: s.radioRoleIds.filter((id) => known.has(id)),
      dispatcherRoleIds: s.dispatcherRoleIds.filter((id) => known.has(id)),
      copyInRoleIds: s.copyInRoleIds.filter((id) => known.has(id)),
      copyOutRoleIds: s.copyOutRoleIds.filter((id) => known.has(id)),
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.updated_by ?? null,
    };
  }

  setSettings(raw: MessageSettingsInput, actor: string): MessageSettings {
    const input = messageSettingsSchema.parse(raw);
    for (const id of [...input.radioRoleIds, ...input.dispatcherRoleIds, ...input.copyInRoleIds, ...input.copyOutRoleIds]) if (!this.deps.roles.find(id)) throw new HttpError(400, 'Rolle nicht gefunden');
    if (input.dispatcherRoleIds.some((id) => input.radioRoleIds.includes(id))) throw new HttpError(400, 'Eine Rolle kann nicht zugleich Fernmelder und Dispatcher sein');
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(SETTINGS_KEY, JSON.stringify(input), iso(this.now()), actor);
    this.deps.notify(['messages']);
    return this.settings();
  }

  private ctx(): Ctx {
    const settings = this.settings();
    const holders = this.deps.roles.holderIds();
    const users = (ids: number[]) => new Set(ids.flatMap((id) => [...(holders.get(id) ?? [])]));
    return { settings, holders, radioUsers: users(settings.radioRoleIds), dispatcherUsers: users(settings.dispatcherRoleIds) };
  }

  context(viewer: TaskViewer): MessageContext {
    const c = this.ctx();
    return {
      radio: some(c.settings.radioRoleIds, viewer.roleIds),
      dispatcher: some(c.settings.dispatcherRoleIds, viewer.roleIds),
      dispatcherPresent: c.dispatcherUsers.size > 0,
      radioConfigured: c.settings.radioRoleIds.length > 0,
    };
  }

  /** Wer eine offene Meldung bearbeitet: Fernmelder (Ausgang) bzw. Dispatcher – ohne angemeldeten Dispatcher die Fernmelder */
  private handlers(r: MessageRow, c: Ctx): { roleIds: number[]; users: Set<number> } {
    if (r.direction === 'out') return { roleIds: c.settings.radioRoleIds, users: c.radioUsers };
    return c.dispatcherUsers.size
      ? { roleIds: c.settings.dispatcherRoleIds, users: c.dispatcherUsers }
      : { roleIds: c.settings.radioRoleIds, users: c.radioUsers };
  }

  /** Noch beim Fernmelder bzw. Dispatcher: Ausgang nicht erledigt, Eingang nicht verteilt */
  private atHandler(r: MessageRow): boolean {
    return !r.done_at && (r.direction === 'out' || r.recipient_text === null);
  }

  /** Eigene Aufgabe; sonst eine ungelesene Kopie an eine eigene Rolle */
  private pending(r: MessageRow, copies: CopyRow[], viewer: TaskViewer | null, c: Ctx): MessagePending | null {
    if (!viewer) return null;
    return this.ownPending(r, viewer, c) ?? (copies.some((k) => !k.ack_at && viewer.roleIds.includes(k.role_id)) ? 'copy' : null);
  }

  private ownPending(r: MessageRow, viewer: TaskViewer, c: Ctx): MessagePending | null {
    if (this.atHandler(r)) {
      const h = this.handlers(r, c);
      if (!some(h.roleIds, viewer.roleIds)) return null;
      // Übernahme zählt nur, solange der Übernehmende die Rolle noch hält
      const claimedByOther = r.claimed_by_user_id !== null && r.claimed_by_user_id !== viewer.userId && h.users.has(r.claimed_by_user_id);
      if (claimedByOther) return null;
      return r.direction === 'out' ? 'radio' : 'dispatch';
    }
    if (r.ack_at) return null;
    if (r.direction === 'in' && r.recipient_role_id !== null && viewer.roleIds.includes(r.recipient_role_id)) return 'recipient';
    if (r.direction === 'out' && r.reply !== null && r.sender_role_id !== null && viewer.roleIds.includes(r.sender_role_id)) return 'reply';
    return null;
  }

  private copies(where: string, id: number): Map<number, CopyRow[]> {
    const rows = this.db.prepare(`SELECT k.* FROM message_copies k JOIN messages m ON m.id = k.message_id WHERE ${where} = ? ORDER BY k.role_name COLLATE NOCASE`).all(id) as CopyRow[];
    const map = new Map<number, CopyRow[]>();
    for (const k of rows) map.set(k.message_id, [...(map.get(k.message_id) ?? []), k]);
    return map;
  }

  private mine(r: MessageRow, copies: CopyRow[], viewer: TaskViewer | null, pending: MessagePending | null): boolean {
    if (!viewer) return false;
    const roles = [r.sender_role_id, r.recipient_role_id, ...copies.map((k) => k.role_id)];
    return pending !== null || roles.some((id) => id !== null && viewer.roleIds.includes(id)) || r.created_by_user_id === viewer.userId || r.claimed_by_user_id === viewer.userId;
  }

  private toMessage(r: MessageRow, copies: CopyRow[], viewer: TaskViewer | null, c: Ctx): Message {
    const pending = this.pending(r, copies, viewer, c);
    return {
      id: r.id,
      incidentId: r.incident_id,
      direction: r.direction,
      body: r.body,
      senderRoleId: r.sender_role_id,
      senderUnitId: r.sender_unit_id,
      senderForceUnitId: r.sender_force_id,
      sender: r.sender_role_name ?? r.sender_text,
      recipientRoleId: r.recipient_role_id,
      recipientUnitId: r.recipient_unit_id,
      recipientForceUnitId: r.recipient_force_id,
      recipient: r.recipient_role_name ?? r.recipient_text,
      claimedByUserId: r.claimed_by_user_id,
      claimedBy: r.claimed_by,
      claimedAt: r.claimed_at,
      remindAt: r.remind_at,
      snoozeCount: r.snooze_count,
      snoozedAt: r.snoozed_at,
      snoozedBy: r.snoozed_by,
      snoozeMinutes: r.snooze_minutes,
      reply: r.reply,
      repliedAt: r.replied_at,
      repliedBy: r.replied_by,
      doneAt: r.done_at,
      doneBy: r.done_by,
      ackAt: r.ack_at,
      ackBy: r.ack_by,
      replyToId: r.reply_to_id,
      requestId: r.request_id,
      copies: copies.map((k): MessageCopy => ({ roleId: k.role_id, role: k.role_name, ackAt: k.ack_at, ackBy: k.ack_by })),
      createdAt: r.created_at,
      createdBy: r.created_by,
      pending,
      mine: this.mine(r, copies, viewer, pending),
    };
  }

  private row(id: number): MessageRow {
    const r = this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined;
    if (!r) throw new HttpError(404, 'Meldung nicht gefunden');
    return r;
  }

  private requireOpen(incidentId: number): Incident {
    const incident = this.deps.store.incident(incidentId);
    if (!incident) throw new HttpError(404, `Einsatz ${incidentId} nicht gefunden`);
    if (incident.closedAt) throw new HttpError(409, 'Einsatz ist abgeschlossen und kann nicht mehr geändert werden');
    return incident;
  }

  /** Kraft nur, wenn sie zu diesem Einsatz gehört; sonst eine vorhandene Systemeinheit – oder Freitext */
  private party(incidentId: number, p: MessagePartyInput): [number | null, number | null, string] {
    const unit = p.unitId ? this.deps.store.unit(p.unitId) : null;
    if (unit && unit.incidentId === incidentId) return [unit.id, null, p.text.trim()];
    const force = p.forceUnitId ? (this.db.prepare('SELECT id FROM force_units WHERE id = ?').get(p.forceUnitId) as { id: number } | undefined) : undefined;
    return [null, force?.id ?? null, p.text.trim()];
  }

  private roleName(id: number): string {
    const role = this.deps.roles.find(id);
    if (!role) throw new HttpError(400, 'Rolle nicht gefunden');
    return role.name;
  }

  list(incidentId: number, viewer: TaskViewer | null): Message[] {
    if (!this.deps.store.incident(incidentId)) throw new HttpError(404, `Einsatz ${incidentId} nicht gefunden`);
    const c = this.ctx();
    const rows = this.db.prepare(`${MESSAGE_SELECT} WHERE m.incident_id = ? ORDER BY m.id DESC`).all(incidentId) as MessageRow[];
    const copies = this.copies('m.incident_id', incidentId);
    return rows.map((r) => this.toMessage(r, copies.get(r.id) ?? [], viewer, c));
  }

  get(id: number, viewer: TaskViewer | null): Message {
    return this.toMessage(this.row(id), this.copies('m.id', id).get(id) ?? [], viewer, this.ctx());
  }

  create(incidentId: number, raw: MessageInput, actor: TaskActor, viewer: TaskViewer): Message {
    this.requireOpen(incidentId);
    const input = messageInputSchema.parse(raw);
    const c = this.ctx();
    const ts = iso(this.now());
    let cols: {
      senderRoleId: number | null;
      senderUnitId: number | null;
      senderForceId: number | null;
      senderText: string;
      recipientRoleId: number | null;
      recipientUnitId: number | null;
      recipientForceId: number | null;
      recipientText: string | null;
      replyToId: number | null;
      requestId: number | null;
    };

    if (input.direction === 'out') {
      if (!viewer.roleIds.includes(input.senderRoleId)) throw new HttpError(403, 'Meldungen nur im Namen einer eigenen Rolle');
      if (some(c.settings.radioRoleIds, viewer.roleIds)) throw new HttpError(403, 'Fernmelder erfassen nur Eingangsmeldungen');
      const [unitId, forceId, text] = this.party(incidentId, input.recipient);
      let replyToId: number | null = null;
      if (input.replyToId !== null) {
        const original = this.row(input.replyToId);
        if (original.incident_id !== incidentId || original.direction !== 'in') throw new HttpError(400, 'Bezugsmeldung nicht gefunden');
        replyToId = original.id;
      }
      if (input.requestId !== null) {
        const request = this.db.prepare('SELECT incident_id FROM requests WHERE id = ?').get(input.requestId) as { incident_id: number } | undefined;
        if (request?.incident_id !== incidentId) throw new HttpError(400, 'Anforderung nicht gefunden');
      }
      cols = {
        senderRoleId: input.senderRoleId,
        senderUnitId: null,
        senderForceId: null,
        senderText: this.roleName(input.senderRoleId),
        recipientRoleId: null,
        recipientUnitId: unitId,
        recipientForceId: forceId,
        recipientText: text,
        replyToId,
        requestId: input.requestId,
      };
    } else {
      if (!some(c.settings.radioRoleIds, viewer.roleIds)) throw new HttpError(403, 'Eingangsmeldungen erfassen nur Fernmelder');
      const [unitId, forceId, text] = this.party(incidentId, input.sender);
      // Mit angemeldetem Dispatcher verteilt er – eine Auswahl des Fernmelders zählt dann nicht
      const roleId = c.dispatcherUsers.size ? null : input.recipientRoleId;
      if (!c.dispatcherUsers.size && roleId === null) throw new HttpError(400, 'Empfänger fehlt');
      cols = {
        senderRoleId: null,
        senderUnitId: unitId,
        senderForceId: forceId,
        senderText: text,
        recipientRoleId: roleId,
        recipientUnitId: null,
        recipientForceId: null,
        recipientText: roleId === null ? null : this.roleName(roleId),
        replyToId: null,
        requestId: null,
      };
    }

    let rememberedIssi = false;
    const info = this.deps.store.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT INTO messages (incident_id, direction, body, sender_role_id, sender_unit_id, sender_force_id, sender_text, recipient_role_id, recipient_unit_id, recipient_force_id, recipient_text,
             reply_to_id, request_id, created_at, created_by, created_by_user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          incidentId,
          input.direction,
          input.body,
          cols.senderRoleId,
          cols.senderUnitId,
          cols.senderForceId,
          cols.senderText,
          cols.recipientRoleId,
          cols.recipientUnitId,
          cols.recipientForceId,
          cols.recipientText,
          cols.replyToId,
          cols.requestId,
          ts,
          actor.name,
          actor.id,
          ts,
        );
      // Kopien an die eingestellten Rollen – nicht an Absender- oder Zielrolle selbst
      const messageId = Number(res.lastInsertRowid);
      const copyTo = input.direction === 'out' ? c.settings.copyOutRoleIds : c.settings.copyInRoleIds;
      const insertCopy = this.db.prepare('INSERT INTO message_copies (message_id, role_id, role_name) VALUES (?, ?, ?)');
      for (const roleId of copyTo) if (roleId !== cols.senderRoleId && roleId !== cols.recipientRoleId) insertCopy.run(messageId, roleId, this.roleName(roleId));
      // Wer auf eine Eingangsmeldung antwortet, hat sie zur Kenntnis genommen
      if (cols.replyToId !== null) this.acknowledge(this.row(cols.replyToId), actor, viewer, ts);
      // Aus einem Funkspruch erfasst: Kraft bzw. Systemeinheit merkt sich im Einsatz die ISSI (Freitext-Absender nicht)
      if (input.direction === 'in' && input.issi && (cols.senderUnitId !== null || cols.senderForceId !== null)) {
        this.deps.store.setRadioId(incidentId, input.issi, cols.senderUnitId, cols.senderForceId, ts);
        rememberedIssi = true;
      }
      return res;
    });
    this.deps.notify(rememberedIssi ? ['messages', 'radioIds'] : ['messages']);
    return this.get(Number(info.lastInsertRowid), viewer);
  }

  /** Nur Fernmelder bzw. Dispatcher, solange die Meldung bei ihnen liegt */
  private requireHandler(r: MessageRow, viewer: TaskViewer, c: Ctx): void {
    if (!this.atHandler(r)) throw new HttpError(409, r.done_at ? 'Meldung ist bereits erledigt' : 'Meldung ist bereits verteilt');
    if (!some(this.handlers(r, c).roleIds, viewer.roleIds)) {
      throw new HttpError(403, r.direction === 'out' ? 'Nur Fernmelder können Ausgangsmeldungen bearbeiten' : 'Eingangsmeldungen verteilt der Dispatcher');
    }
  }

  /** Geöffnet: zeigt allen, wer sich kümmert. Fremde Übernahme nur mit force („Übernehmen“) */
  claim(id: number, force: boolean, actor: TaskActor, viewer: TaskViewer): Message {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    const c = this.ctx();
    this.requireHandler(r, viewer, c);
    if (r.claimed_by_user_id === actor.id) return this.get(id, viewer);
    const active = r.claimed_by_user_id !== null && this.handlers(r, c).users.has(r.claimed_by_user_id);
    if (active && !force) throw new HttpError(409, `Meldung wird bereits von ${r.claimed_by} bearbeitet`);
    const ts = iso(this.now());
    this.db.prepare('UPDATE messages SET claimed_by_user_id = ?, claimed_by = ?, claimed_at = ?, remind_at = NULL, updated_at = ? WHERE id = ?').run(actor.id, actor.name, ts, ts, id);
    this.deps.notify(['messages']);
    return this.get(id, viewer);
  }

  /** Zurücklegen: wieder für alle Fernmelder bzw. Dispatcher offen */
  release(id: number, viewer: TaskViewer): Message {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    this.requireHandler(r, viewer, this.ctx());
    this.db.prepare('UPDATE messages SET claimed_by_user_id = NULL, claimed_by = NULL, claimed_at = NULL, remind_at = NULL, updated_at = ? WHERE id = ?').run(iso(this.now()), id);
    this.deps.notify(['messages']);
    return this.get(id, viewer);
  }

  /** Erneut versuchen: nach Ablauf wieder melden; die Übernahme bleibt */
  snooze(id: number, minutes: number, actor: TaskActor, viewer: TaskViewer): Message {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    this.requireHandler(r, viewer, this.ctx());
    const now = this.now();
    this.db
      .prepare(
        `UPDATE messages SET claimed_by_user_id = ?, claimed_by = ?, claimed_at = COALESCE(claimed_at, ?), remind_at = ?,
           snooze_count = snooze_count + 1, snoozed_at = ?, snoozed_by = ?, snooze_minutes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(actor.id, actor.name, iso(now), iso(now + minutes * 60_000), iso(now), actor.name, minutes, iso(now), id);
    this.deps.notify(['messages']);
    return this.get(id, viewer);
  }

  /** Antwort des Fernmelders schließt die Ausgangsmeldung ab; die Absenderrolle wird benachrichtigt */
  reply(id: number, body: string, actor: TaskActor, viewer: TaskViewer): Message {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    this.requireHandler(r, viewer, this.ctx());
    if (r.direction !== 'out') throw new HttpError(400, 'Auf Eingangsmeldungen antwortet die Zielrolle');
    const ts = iso(this.now());
    this.db
      .prepare('UPDATE messages SET reply = ?, replied_at = ?, replied_by = ?, done_at = ?, done_by = ?, remind_at = NULL, updated_at = ? WHERE id = ?')
      .run(body, ts, actor.name, ts, actor.name, ts, id);
    this.deps.notify(['messages']);
    return this.get(id, viewer);
  }

  /** Erledigt ohne Antwort (z. B. per Funk übermittelt) */
  done(id: number, actor: TaskActor, viewer: TaskViewer): Message {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    this.requireHandler(r, viewer, this.ctx());
    if (r.direction !== 'out') throw new HttpError(400, 'Eingangsmeldungen werden verteilt');
    const ts = iso(this.now());
    this.db.prepare('UPDATE messages SET done_at = ?, done_by = ?, remind_at = NULL, updated_at = ? WHERE id = ?').run(ts, actor.name, ts, id);
    this.deps.notify(['messages']);
    return this.get(id, viewer);
  }

  /** Eingang an die Zielrolle verteilen */
  route(id: number, roleId: number, viewer: TaskViewer): Message {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    this.requireHandler(r, viewer, this.ctx());
    if (r.direction !== 'in') throw new HttpError(400, 'Nur Eingangsmeldungen werden verteilt');
    this.db
      .prepare('UPDATE messages SET recipient_role_id = ?, recipient_text = ?, remind_at = NULL, updated_at = ? WHERE id = ?')
      .run(roleId, this.roleName(roleId), iso(this.now()), id);
    this.deps.notify(['messages']);
    return this.get(id, viewer);
  }

  /** Eingang durch die Zielrolle bzw. Antwort durch die Absenderrolle; false, wenn das für den Betrachter nicht ansteht */
  private acknowledge(r: MessageRow, actor: TaskActor, viewer: TaskViewer, ts: string): boolean {
    const roleId = r.direction === 'in' ? r.recipient_role_id : r.reply !== null ? r.sender_role_id : null;
    if (r.ack_at || roleId === null || !viewer.roleIds.includes(roleId)) return false;
    this.db
      .prepare('UPDATE messages SET ack_at = ?, ack_by = ?, done_at = COALESCE(done_at, ?), done_by = COALESCE(done_by, ?), updated_at = ? WHERE id = ?')
      .run(ts, actor.name, ts, actor.name, ts, r.id);
    return true;
  }

  /** Ungelesene Kopien an Rollen des Betrachters als gelesen markieren */
  private acknowledgeCopies(id: number, actor: TaskActor, viewer: TaskViewer, ts: string): boolean {
    if (!viewer.roleIds.length) return false;
    const marks = viewer.roleIds.map(() => '?').join(', ');
    const res = this.db.prepare(`UPDATE message_copies SET ack_at = ?, ack_by = ? WHERE message_id = ? AND ack_at IS NULL AND role_id IN (${marks})`).run(ts, actor.name, id, ...viewer.roleIds);
    return res.changes > 0;
  }

  /** Zur Kenntnis nehmen, soweit es für den Betrachter ansteht (innerhalb der Transaktion des Aufrufers, ohne notify) */
  acknowledgeIfPending(id: number, actor: TaskActor, viewer: TaskViewer): boolean {
    const ts = iso(this.now());
    const own = this.acknowledge(this.row(id), actor, viewer, ts);
    const copies = this.acknowledgeCopies(id, actor, viewer, ts);
    return own || copies;
  }

  /** Zur Kenntnis genommen: Eingang durch die Zielrolle, Antwort durch die Absenderrolle, Kopien durch ihre Rollen */
  ack(id: number, actor: TaskActor, viewer: TaskViewer): Message {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    const ts = iso(this.now());
    const done = this.deps.store.transaction(() => {
      const own = this.acknowledge(r, actor, viewer, ts);
      const copies = this.acknowledgeCopies(id, actor, viewer, ts);
      return own || copies;
    });
    if (!done) throw new HttpError(409, 'Für Ihre Rollen gibt es hier nichts zur Kenntnis zu nehmen');
    this.deps.notify(['messages']);
    return this.get(id, viewer);
  }
}
