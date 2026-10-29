import {
  DEFAULT_UNIT_SIGN,
  forceDescendants,
  forceUnitInputSchema,
  tacticalSignSchema,
  type ForceImportPlanRow,
  type ForceImportResult,
  type ForceImportRow,
  type ForceUnit,
  type ForceUnitInput,
  type Unit,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { ParsedImportRow } from './forceImport.js';

interface ForceRow {
  id: number;
  name: string;
  callsign: string;
  organization: string;
  notes: string;
  email: string;
  sign: string;
  leaders: number;
  sub_leaders: number;
  crew: number;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  parent_id: number;
  child_id: number;
  role: string;
}

const now = () => new Date().toISOString();

/**
 * Kräfteverwaltung: Systemeinheiten und ihre Zusammensetzung (force_unit_members). Eine Einheit darf
 * Mitglied mehrerer Einheiten sein; Zyklen werden beim Speichern abgelehnt. Lesen dürfen alle
 * Angemeldeten (Übernahme in den Einsatz), pflegen nur Admins.
 */
export class ForceService {
  constructor(
    private readonly db: Db,
    private readonly store: Store,
  ) {}

  list(): ForceUnit[] {
    const members = this.db.prepare('SELECT parent_id, child_id, role FROM force_unit_members ORDER BY sort').all() as MemberRow[];
    const rows = this.db.prepare('SELECT * FROM force_units ORDER BY name COLLATE NOCASE, id').all() as ForceRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      callsign: r.callsign,
      organization: r.organization,
      notes: r.notes,
      email: r.email,
      sign: tacticalSignSchema.parse(JSON.parse(r.sign)),
      strength: { leaders: r.leaders, subLeaders: r.sub_leaders, crew: r.crew },
      members: members.filter((m) => m.parent_id === r.id).map((m) => ({ unitId: m.child_id, role: m.role })),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  get(id: number): ForceUnit {
    const unit = this.list().find((u) => u.id === id);
    if (!unit) throw new HttpError(404, 'Systemeinheit nicht gefunden');
    return unit;
  }

  /** Mitglieder prüfen: vorhanden, nicht doppelt, keine Einheit enthält sich selbst (auch nicht über Umwege) */
  private checkMembers(id: number | null, members: ForceUnitInput['members'] = []): void {
    const all = this.list();
    const ids = new Set(all.map((u) => u.id));
    const seen = new Set<number>();
    for (const m of members) {
      if (!ids.has(m.unitId)) throw new HttpError(400, `Untereinheit ${m.unitId} nicht gefunden`);
      if (seen.has(m.unitId)) throw new HttpError(400, `${all.find((u) => u.id === m.unitId)!.name} ist doppelt enthalten`);
      seen.add(m.unitId);
      if (id !== null && (m.unitId === id || forceDescendants(all, m.unitId).has(id))) {
        throw new HttpError(400, `${all.find((u) => u.id === m.unitId)!.name} enthält diese Einheit bereits – eine Einheit kann sich nicht selbst enthalten`);
      }
    }
  }

  private write(id: number | null, input: ReturnType<typeof forceUnitInputSchema.parse>): number {
    const params = {
      name: input.name,
      callsign: input.callsign,
      organization: input.organization,
      notes: input.notes,
      email: input.email ?? null,
      sign: JSON.stringify(input.sign),
      leaders: input.strength.leaders,
      subLeaders: input.strength.subLeaders,
      crew: input.strength.crew,
      ts: now(),
    };
    let target = id;
    if (target === null) {
      const info = this.db
        .prepare(
          `INSERT INTO force_units (name, callsign, organization, notes, email, sign, leaders, sub_leaders, crew, created_at, updated_at)
           VALUES (@name, @callsign, @organization, @notes, COALESCE(@email, ''), @sign, @leaders, @subLeaders, @crew, @ts, @ts)`,
        )
        .run(params);
      target = Number(info.lastInsertRowid);
    } else {
      this.db
        .prepare(
          `UPDATE force_units SET name=@name, callsign=@callsign, organization=@organization, notes=@notes, email=COALESCE(@email, email), sign=@sign,
           leaders=@leaders, sub_leaders=@subLeaders, crew=@crew, updated_at=@ts WHERE id=@id`,
        )
        .run({ ...params, id: target });
      this.db.prepare('DELETE FROM force_unit_members WHERE parent_id = ?').run(target);
    }
    const add = this.db.prepare('INSERT INTO force_unit_members (parent_id, child_id, role, sort) VALUES (?, ?, ?, ?)');
    input.members.forEach((m, i) => add.run(target, m.unitId, m.role, i));
    return target;
  }

  create(input: ForceUnitInput): ForceUnit {
    const parsed = forceUnitInputSchema.parse(input);
    this.checkMembers(null, parsed.members);
    return this.get(this.db.transaction(() => this.write(null, parsed))());
  }

  update(id: number, input: ForceUnitInput): ForceUnit {
    this.get(id);
    const parsed = forceUnitInputSchema.parse(input);
    this.checkMembers(id, parsed.members);
    this.db.transaction(() => this.write(id, parsed))();
    return this.get(id);
  }

  /** Adresse aus einer eingegangenen Mail merken (z. B. Leitstelle als Absender einer Meldung) */
  setEmail(id: number, email: string): void {
    this.db.prepare('UPDATE force_units SET email = ?, updated_at = ? WHERE id = ?').run(email, now(), id);
  }

  /** Mitgliedschaften fallen weg; Einsätze behalten ihre Kopie (source_id → NULL) */
  remove(id: number): ForceUnit {
    const unit = this.get(id);
    this.db.prepare('DELETE FROM force_units WHERE id = ?').run(id);
    return unit;
  }

  /**
   * Im Einsatz erfasste Einheit samt Untereinheiten als Systemeinheit übernehmen. Untereinheiten, die
   * selbst aus dem Katalog stammen, werden verknüpft statt kopiert. Die Einheiten im Einsatz verweisen
   * danach auf ihre Systemeinheit (nur solange der Einsatz läuft – das Archiv bleibt unverändert).
   */
  adopt(unitId: number): ForceUnit {
    const root = this.store.unit(unitId);
    if (!root) throw new HttpError(404, `Einheit ${unitId} nicht gefunden`);
    const known = new Set(this.list().map((u) => u.id));
    if (root.sourceId !== null && known.has(root.sourceId)) throw new HttpError(409, `${root.name} ist bereits eine Systemeinheit`);
    const open = !this.store.incident(root.incidentId)?.closedAt;
    const units = this.store.units(root.incidentId);

    const ensure = (u: Unit): number => {
      if (u.sourceId !== null && known.has(u.sourceId)) return u.sourceId;
      const children = units.filter((c) => c.parentId === u.id && c.status !== 'entlassen');
      const members = children.map((c) => ({ unitId: ensure(c), role: c.role })).filter((m, i, all) => all.findIndex((x) => x.unitId === m.unitId) === i);
      const id = this.write(null, forceUnitInputSchema.parse({ ...u, members }));
      known.add(id);
      if (open) this.store.saveUnit({ ...u, sourceId: id });
      return id;
    };
    return this.get(this.db.transaction(() => ensure(root))());
  }

  // --- Import (CSV/Excel) ---

  /**
   * Was der Import mit jeder Zeile tut. Vorhanden ist eine Einheit mit gleichem Funkrufnamen, sonst mit gleichem Namen
   * (und gleicher Organisation, wenn angegeben). „Gehört zu“ verweist auf eine Einheit aus der Datei oder dem Katalog.
   */
  planImport(parsed: ParsedImportRow[], updateExisting: boolean, all = this.list()): ForceImportPlanRow[] {
    const ci = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
    const find = (row: ForceImportRow): ForceUnit[] => {
      if (row.callsign) {
        const byCallsign = all.filter((u) => u.callsign && ci(u.callsign) === ci(row.callsign));
        if (byCallsign.length) return byCallsign;
      }
      return all.filter((u) => ci(u.name) === ci(row.name) && (row.organization === null || ci(u.organization) === ci(row.organization)));
    };
    const fileNames = new Map<string, number[]>();
    for (const p of parsed) if (p.row) fileNames.set(ci(p.row.name), [...(fileNames.get(ci(p.row.name)) ?? []), p.line]);
    const seen = new Map<string, number>();

    return parsed.map((p): ForceImportPlanRow => {
      if (!p.row) return { row: null, line: p.line, name: p.name, action: 'error', matchId: null, messages: p.messages };
      const row = p.row;
      const messages = [...p.messages];
      const key = row.callsign ? `c:${ci(row.callsign)}` : `n:${ci(row.name)}|${ci(row.organization)}`;
      if (seen.has(key)) return { row, line: p.line, name: row.name, action: 'error', matchId: null, messages: [`Doppelt – schon in Zeile ${seen.get(key)}`] };
      seen.set(key, p.line);

      const matches = find(row);
      if (matches.length > 1) {
        return { row, line: p.line, name: row.name, action: 'error', matchId: null, messages: [`Mehrdeutig: ${matches.length} vorhandene Einheiten „${row.name}“ – Funkrufname oder Organisation angeben`] };
      }
      if (row.parent) {
        const inFile = fileNames.get(ci(row.parent)) ?? [];
        const inCatalog = all.filter((u) => ci(u.name) === ci(row.parent));
        if (ci(row.parent) === ci(row.name)) messages.push('Gehört zu: eine Einheit kann nicht zu sich selbst gehören');
        else if (inFile.length > 1) messages.push(`Gehört zu: „${row.parent}“ steht mehrfach in der Datei`);
        else if (!inFile.length && inCatalog.length > 1) messages.push(`Gehört zu: „${row.parent}“ gibt es mehrfach im Katalog`);
        else if (!inFile.length && !inCatalog.length) messages.push(`Gehört zu: „${row.parent}“ nicht gefunden`);
        if (messages.length) return { row, line: p.line, name: row.name, action: 'error', matchId: null, messages };
      }
      const match = matches[0];
      if (!match) return { row, line: p.line, name: row.name, action: 'create', matchId: null, messages };
      return { row, line: p.line, name: row.name, action: updateExisting ? 'update' : 'skip', matchId: match.id, messages: updateExisting ? messages : [...messages, 'Bereits vorhanden'] };
    });
  }

  /** Geplante Zeilen schreiben – alles oder nichts. Fehlerhafte Zeilen bleiben außen vor. */
  importRows(rows: ForceImportRow[], updateExisting: boolean): ForceImportResult {
    const all = this.list();
    const plan = this.planImport(rows.map((row) => ({ line: row.line, name: row.name, row, messages: [] })), updateExisting, all);
    const ci = (v: string) => v.trim().toLowerCase();
    let created = 0;
    let updated = 0;
    let linked = 0;

    this.db.transaction(() => {
      const ids = new Map<number, number>(); // Zeile → Systemeinheit
      for (const p of plan) {
        const row = p.row;
        if (!row || (p.action !== 'create' && p.action !== 'update')) continue;
        const base: ForceUnit | undefined = p.matchId !== null ? all.find((u) => u.id === p.matchId) : undefined;
        const sign = { ...(base?.sign ?? DEFAULT_UNIT_SIGN) };
        if (row.signText !== null) sign.text = row.signText;
        if (row.signOrg !== null) sign.org = row.signOrg;
        const input = forceUnitInputSchema.parse({
          name: row.name,
          callsign: row.callsign ?? base?.callsign ?? '',
          organization: row.organization ?? base?.organization ?? '',
          notes: row.notes ?? base?.notes ?? '',
          sign,
          strength: {
            leaders: row.leaders ?? base?.strength.leaders ?? 0,
            subLeaders: row.subLeaders ?? base?.strength.subLeaders ?? 0,
            crew: row.crew ?? base?.strength.crew ?? 0,
          },
          members: base?.members ?? [],
        });
        ids.set(p.line, this.write(base ? base.id : null, input));
        if (base) updated++;
        else created++;
      }

      // „Gehört zu“: Mitglieder je übergeordneter Einheit ergänzen, Zyklen ablehnen
      const graph = this.list();
      const byId = new Map(graph.map((u) => [u.id, u]));
      const changed = new Set<number>();
      for (const p of plan) {
        const row = p.row;
        const childId = ids.get(p.line);
        if (!row?.parent || childId === undefined) continue;
        const fromFile = plan.find((x) => x.row && ids.has(x.line) && ci(x.row.name) === ci(row.parent!));
        const parentId = fromFile ? ids.get(fromFile.line)! : graph.find((u) => ci(u.name) === ci(row.parent!))?.id;
        const parent = parentId !== undefined ? byId.get(parentId) : undefined;
        if (!parent) {
          p.messages.push(`Gehört zu: „${row.parent}“ nicht angelegt`);
          continue;
        }
        if (forceDescendants(graph, childId).has(parent.id)) {
          p.messages.push(`Gehört zu: ${parent.name} steckt bereits in ${row.name} – nicht verknüpft`);
          continue;
        }
        const existing = parent.members.find((m) => m.unitId === childId);
        if (existing) {
          if (row.role !== null && existing.role !== row.role) (existing.role = row.role), changed.add(parent.id);
          continue;
        }
        parent.members.push({ unitId: childId, role: row.role ?? '' });
        changed.add(parent.id);
        linked++;
      }
      for (const id of changed) {
        const parent = byId.get(id)!;
        this.write(id, forceUnitInputSchema.parse({ ...parent }));
      }
    })();

    return { created, updated, skipped: plan.filter((p) => p.action === 'skip').length, linked, rows: plan };
  }
}
