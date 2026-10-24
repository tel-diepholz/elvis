import { forceDescendants, forceUnitInputSchema, tacticalSignSchema, type ForceUnit, type ForceUnitInput, type Unit } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';

interface ForceRow {
  id: number;
  name: string;
  callsign: string;
  organization: string;
  notes: string;
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
          `INSERT INTO force_units (name, callsign, organization, notes, sign, leaders, sub_leaders, crew, created_at, updated_at)
           VALUES (@name, @callsign, @organization, @notes, @sign, @leaders, @subLeaders, @crew, @ts, @ts)`,
        )
        .run(params);
      target = Number(info.lastInsertRowid);
    } else {
      this.db
        .prepare(
          `UPDATE force_units SET name=@name, callsign=@callsign, organization=@organization, notes=@notes, sign=@sign,
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
}
