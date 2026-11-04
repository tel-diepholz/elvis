import {
  DAMAGE_COUNT_CATEGORIES,
  DAMAGE_COUNT_LABELS,
  DAMAGE_ENTRY_SIDE_LABELS,
  damageAccountInputSchema,
  damageAccountLabel,
  damageAccountPatchSchema,
  damageCountInputSchema,
  damageEntryInputSchema,
  damageEntryPatchSchema,
  type DamageAccount,
  type DamageAccountInput,
  type DamageAccountPatch,
  type DamageCount,
  type DamageCountBooking,
  type DamageCountCategory,
  type DamageCountInput,
  type DamageEntry,
  type DamageEntryInput,
  type DamageEntryPatch,
  type DamageEntrySide,
  type Incident,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';

interface AccountRow {
  id: number;
  incident_id: number;
  number: number;
  name: string;
  leader_unit_id: number | null;
  leader_text: string;
  radio: string;
  lat: number | null;
  lon: number | null;
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

interface EntryRow {
  id: number;
  account_id: number;
  side: DamageEntrySide;
  text: string;
  sign: string | null;
  count: number | null;
  uncertain: number;
  done_at: string | null;
  done_by: string | null;
  created_at: string;
  created_by: string;
}

interface CountRow {
  id: number;
  account_id: number;
  category: DamageCountCategory;
  value: number;
  forces: number;
  estimated: number;
  note: string;
  at: string;
  by: string;
}

const toEntry = (r: EntryRow): DamageEntry => ({
  id: r.id,
  accountId: r.account_id,
  side: r.side,
  text: r.text,
  sign: r.sign,
  count: r.count,
  uncertain: r.uncertain === 1,
  doneAt: r.done_at,
  doneBy: r.done_by,
  createdAt: r.created_at,
  createdBy: r.created_by,
});

const toCount = (r: CountRow): DamageCount => ({ category: r.category, value: r.value, forces: r.forces, estimated: r.estimated === 1, note: r.note, at: r.at, by: r.by });

/** Eintrag für das Tagebuch: „? 3 × Gasaustritt“ */
const entryText = (e: Pick<DamageEntry, 'side' | 'text' | 'sign' | 'count' | 'uncertain'>) =>
  `${DAMAGE_ENTRY_SIDE_LABELS[e.side]} ${e.uncertain ? '? ' : ''}${e.count !== null ? `${e.count} × ` : ''}${e.text || e.sign?.split('/')[1]?.replaceAll('_', ' ') || ''}`.trim();

const countText = (c: Pick<DamageCount, 'value' | 'forces' | 'estimated'>) => `${c.estimated ? '~' : ''}${c.value}${c.forces ? ` (davon ${c.forces} EK)` : ''}`;

/**
 * Schadenkonten im Einsatz (Lagedarstellung S2). Ein Konto ist zugleich der Einsatzabschnitt der Einheiten (units.account_id).
 * Konten werden aufgelöst statt gelöscht, Einträge erledigt statt gelöscht; Personenschäden werden als neuer Stand gebucht.
 * Jede Änderung steht im Einsatztagebuch.
 */
export class DamageService {
  constructor(
    private readonly db: Db,
    private readonly deps: { store: Store; notify: (topics: Topic[]) => void; now?: () => number },
  ) {}

  private ts(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  private requireOpen(incidentId: number): Incident {
    const incident = this.deps.store.incident(incidentId);
    if (!incident) throw new HttpError(404, `Lage ${incidentId} nicht gefunden`);
    if (incident.closedAt) throw new HttpError(409, 'Lage ist abgeschlossen und kann nicht mehr geändert werden');
    return incident;
  }

  private row(id: number): AccountRow {
    const r = this.db.prepare('SELECT * FROM damage_accounts WHERE id = ?').get(id) as AccountRow | undefined;
    if (!r) throw new HttpError(404, 'Schadenkonto nicht gefunden');
    return r;
  }

  /** Konto zum Schreiben: Einsatz offen, Konto nicht aufgelöst */
  private writable(id: number): AccountRow {
    const r = this.row(id);
    this.requireOpen(r.incident_id);
    if (r.closed_at) throw new HttpError(409, `Schadenkonto ${damageAccountLabel(r)} ist aufgelöst`);
    return r;
  }

  private entryRow(id: number): EntryRow {
    const r = this.db.prepare('SELECT * FROM damage_entries WHERE id = ?').get(id) as EntryRow | undefined;
    if (!r) throw new HttpError(404, 'Eintrag nicht gefunden');
    return r;
  }

  private journal(a: Pick<AccountRow, 'incident_id' | 'number' | 'name'>, text: string, author: string): void {
    this.deps.store.addJournal(a.incident_id, { category: 'lage', text: `Schadenkonto ${damageAccountLabel(a)}: ${text}` }, author);
  }

  /** Abschnittsleiter: Kraft im selben Einsatz; der Anzeigename wird festgehalten */
  private leader(incidentId: number, unitId: number | null, text: string): [number | null, string] {
    if (unitId === null) return [null, text];
    const u = this.deps.store.unit(unitId);
    if (!u || u.incidentId !== incidentId) throw new HttpError(400, 'Abschnittsleiter nicht gefunden');
    return [u.id, text || u.name];
  }

  private assertUniqueName(incidentId: number, name: string, selfId?: number): void {
    const other = this.db
      .prepare('SELECT id FROM damage_accounts WHERE incident_id = ? AND closed_at IS NULL AND name = ? COLLATE NOCASE AND id IS NOT ?')
      .get(incidentId, name, selfId ?? null);
    if (other) throw new HttpError(409, `Es gibt bereits ein Schadenkonto „${name}“`);
  }

  // --- Lesen ---

  private toAccounts(rows: AccountRow[]): DamageAccount[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const entries = this.db.prepare(`SELECT * FROM damage_entries WHERE account_id IN (${marks}) ORDER BY id`).all(...ids) as EntryRow[];
    // Stand = letzte Buchung je Konto und Kategorie
    const counts = this.db
      .prepare(
        `SELECT c.* FROM damage_counts c
         WHERE c.account_id IN (${marks}) AND c.id = (SELECT MAX(id) FROM damage_counts d WHERE d.account_id = c.account_id AND d.category = c.category)`,
      )
      .all(...ids) as CountRow[];
    return rows.map((r) => ({
      id: r.id,
      incidentId: r.incident_id,
      number: r.number,
      name: r.name,
      leaderUnitId: r.leader_unit_id,
      leader: r.leader_text,
      radio: r.radio,
      lat: r.lat,
      lon: r.lon,
      closedAt: r.closed_at,
      closedBy: r.closed_by,
      createdAt: r.created_at,
      createdBy: r.created_by,
      updatedAt: r.updated_at,
      entries: entries.filter((e) => e.account_id === r.id).map(toEntry),
      counts: counts
        .filter((c) => c.account_id === r.id)
        .map(toCount)
        .sort((a, b) => DAMAGE_COUNT_CATEGORIES.indexOf(a.category) - DAMAGE_COUNT_CATEGORIES.indexOf(b.category)),
    }));
  }

  list(incidentId: number): DamageAccount[] {
    if (!this.deps.store.incident(incidentId)) throw new HttpError(404, `Lage ${incidentId} nicht gefunden`);
    return this.toAccounts(this.db.prepare('SELECT * FROM damage_accounts WHERE incident_id = ? ORDER BY number').all(incidentId) as AccountRow[]);
  }

  get(id: number): DamageAccount {
    return this.toAccounts([this.row(id)])[0]!;
  }

  /** Verlauf der Personenschäden eines Kontos, neueste zuerst */
  counts(id: number): DamageCountBooking[] {
    this.row(id);
    return (this.db.prepare('SELECT * FROM damage_counts WHERE account_id = ? ORDER BY id DESC').all(id) as CountRow[]).map((r) => ({
      ...toCount(r),
      id: r.id,
      accountId: r.account_id,
    }));
  }

  // --- Konten ---

  create(incidentId: number, raw: DamageAccountInput, actor: string): DamageAccount {
    this.requireOpen(incidentId);
    const input = damageAccountInputSchema.parse(raw);
    const ts = this.ts();
    const id = this.deps.store.transaction(() => {
      this.assertUniqueName(incidentId, input.name);
      const [leaderId, leader] = this.leader(incidentId, input.leaderUnitId, input.leader);
      const { n } = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM damage_accounts WHERE incident_id = ?').get(incidentId) as { n: number };
      const info = this.db
        .prepare(
          `INSERT INTO damage_accounts (incident_id, number, name, leader_unit_id, leader_text, radio, lat, lon, created_at, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(incidentId, n, input.name, leaderId, leader, input.radio, input.lat, input.lon, ts, actor, ts);
      const r = this.row(Number(info.lastInsertRowid));
      this.journal(r, `eingerichtet${leader ? `, Leiter ${leader}` : ''}${input.radio ? `, Fm ${input.radio}` : ''}`, actor);
      return r.id;
    });
    this.deps.notify(['damage', 'journal']);
    return this.get(id);
  }

  update(id: number, raw: DamageAccountPatch, actor: string): DamageAccount {
    const current = this.writable(id);
    const input = damageAccountPatchSchema.parse(raw);
    const name = input.name ?? current.name;
    const [leaderId, leader] =
      input.leaderUnitId !== undefined || input.leader !== undefined
        ? this.leader(current.incident_id, input.leaderUnitId !== undefined ? input.leaderUnitId : current.leader_unit_id, input.leader ?? '')
        : [current.leader_unit_id, current.leader_text];
    const radio = input.radio ?? current.radio;
    const lat = input.lat !== undefined ? input.lat : current.lat;
    const lon = input.lon !== undefined ? input.lon : current.lon;
    const changes = [
      name !== current.name && `umbenannt (vorher ${current.name})`,
      leader !== current.leader_text && (leader ? `Leiter ${leader}` : 'ohne Leiter'),
      radio !== current.radio && (radio ? `Fm ${radio}` : 'ohne Fm-Verbindung'),
      (lat !== current.lat || lon !== current.lon) && (lat === null ? 'von der Karte entfernt' : current.lat === null ? 'auf der Karte gesetzt' : 'auf der Karte verschoben'),
    ].filter((c): c is string => Boolean(c));
    if (!changes.length && leaderId === current.leader_unit_id) return this.get(id);
    this.deps.store.transaction(() => {
      if (name !== current.name) this.assertUniqueName(current.incident_id, name, id);
      this.db
        .prepare('UPDATE damage_accounts SET name = ?, leader_unit_id = ?, leader_text = ?, radio = ?, lat = ?, lon = ?, updated_at = ? WHERE id = ?')
        .run(name, leaderId, leader, radio, lat, lon, this.ts(), id);
      if (changes.length) this.journal({ ...current, name }, changes.join(', '), actor);
    });
    // Der Name ist der Abschnitt der Einheiten
    this.deps.notify(name !== current.name ? ['damage', 'journal', 'units'] : ['damage', 'journal']);
    return this.get(id);
  }

  /** Auflösen: nur ohne aktive (nicht entlassene) Einheiten im Abschnitt */
  close(id: number, actor: string): DamageAccount {
    const current = this.writable(id);
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM units WHERE account_id = ? AND status <> 'entlassen'").get(id) as { n: number };
    if (n > 0) throw new HttpError(409, `Im Abschnitt sind noch ${n} Einheit${n === 1 ? '' : 'en'} – erst umsetzen oder entlassen`);
    this.deps.store.transaction(() => {
      const ts = this.ts();
      this.db.prepare('UPDATE damage_accounts SET closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?').run(ts, actor, ts, id);
      this.journal(current, 'aufgelöst', actor);
    });
    this.deps.notify(['damage', 'journal']);
    return this.get(id);
  }

  // --- Einträge (Schäden, Gefahren, Maßnahmen) ---

  addEntry(accountId: number, raw: DamageEntryInput, actor: string): DamageEntry {
    const account = this.writable(accountId);
    const input = damageEntryInputSchema.parse(raw);
    const entry = this.deps.store.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO damage_entries (account_id, side, text, sign, count, uncertain, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(accountId, input.side, input.text, input.sign, input.count, input.uncertain ? 1 : 0, this.ts(), actor);
      const e = toEntry(this.entryRow(Number(info.lastInsertRowid)));
      this.journal(account, entryText(e), actor);
      return e;
    });
    this.deps.notify(['damage', 'journal']);
    return entry;
  }

  updateEntry(entryId: number, raw: DamageEntryPatch, actor: string): DamageEntry {
    const current = this.entryRow(entryId);
    const account = this.writable(current.account_id);
    const input = damageEntryPatchSchema.parse(raw);
    const before = toEntry(current);
    const next: DamageEntry = {
      ...before,
      ...(input.text !== undefined && { text: input.text }),
      ...(input.sign !== undefined && { sign: input.sign }),
      ...(input.count !== undefined && { count: input.count }),
      ...(input.uncertain !== undefined && { uncertain: input.uncertain }),
    };
    if (!next.text && !next.sign) throw new HttpError(400, 'Text oder Zeichen angeben');
    const ts = this.ts();
    if (input.done !== undefined && input.done !== (before.doneAt !== null)) {
      next.doneAt = input.done ? ts : null;
      next.doneBy = input.done ? actor : null;
    }
    const changes = [
      (next.text !== before.text || next.sign !== before.sign || next.count !== before.count) && `geändert: ${entryText(next)} (vorher ${entryText(before)})`,
      next.uncertain !== before.uncertain && `${entryText({ ...next, uncertain: false })} ${next.uncertain ? 'unbestätigt' : 'bestätigt'}`,
      next.doneAt !== before.doneAt && `${entryText(next)} ${next.doneAt ? 'erledigt' : 'wieder offen'}`,
    ].filter((c): c is string => Boolean(c));
    if (!changes.length) return before;
    this.deps.store.transaction(() => {
      this.db
        .prepare('UPDATE damage_entries SET text = ?, sign = ?, count = ?, uncertain = ?, done_at = ?, done_by = ? WHERE id = ?')
        .run(next.text, next.sign, next.count, next.uncertain ? 1 : 0, next.doneAt, next.doneBy, entryId);
      this.db.prepare('UPDATE damage_accounts SET updated_at = ? WHERE id = ?').run(ts, account.id);
      this.journal(account, changes.join(', '), actor);
    });
    this.deps.notify(['damage', 'journal']);
    return toEntry(this.entryRow(entryId));
  }

  // --- Personenschäden ---

  /** Neuen Stand einer Kategorie buchen; unveränderter Stand wird nicht erneut gebucht */
  book(accountId: number, raw: DamageCountInput, actor: string): DamageAccount {
    const account = this.writable(accountId);
    const input = damageCountInputSchema.parse(raw);
    const last = this.db
      .prepare('SELECT * FROM damage_counts WHERE account_id = ? AND category = ? ORDER BY id DESC LIMIT 1')
      .get(accountId, input.category) as CountRow | undefined;
    if (last && last.value === input.value && last.forces === input.forces && (last.estimated === 1) === input.estimated && !input.note) return this.get(accountId);
    if (!last && input.value === 0 && !input.note) return this.get(accountId);
    this.deps.store.transaction(() => {
      const ts = this.ts();
      this.db
        .prepare('INSERT INTO damage_counts (account_id, category, value, forces, estimated, note, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(accountId, input.category, input.value, input.forces, input.estimated ? 1 : 0, input.note, ts, actor);
      this.db.prepare('UPDATE damage_accounts SET updated_at = ? WHERE id = ?').run(ts, accountId);
      const was = last ? `${countText(toCount(last))} → ` : '';
      this.journal(account, `${DAMAGE_COUNT_LABELS[input.category]} ${was}${countText(input)}${input.estimated ? ' (geschätzt)' : ''}${input.note ? ` – ${input.note}` : ''}`, actor);
    });
    this.deps.notify(['damage', 'journal']);
    return this.get(accountId);
  }
}
