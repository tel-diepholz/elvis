import type { Role, RoleInfo, RoleInput } from '@elvis/shared';
import type { SessionStore } from '../auth/sessions.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';

interface RoleRow {
  id: number;
  name: string;
  description: string;
  sort: number;
}

const toRole = (r: RoleRow): Role => ({ id: r.id, name: r.name, description: r.description, sort: r.sort });

/**
 * Rollen im Einsatz (z. B. Einsatzleiter, Führungsassistent, Funker). Admins pflegen die Liste,
 * jede Sitzung kann mehrere Rollen übernehmen (session_roles). Besetzt ist eine Rolle,
 * solange eine gültige Sitzung sie hält – nach Abmeldung oder Ablauf wird sie wieder frei.
 */
export class RoleService {
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionStore,
  ) {}

  list(): Role[] {
    return (this.db.prepare('SELECT * FROM roles ORDER BY sort, name COLLATE NOCASE').all() as RoleRow[]).map(toRole);
  }

  /** Rollen samt aktuellen Inhabern */
  infos(): RoleInfo[] {
    const holders = this.sessions.roleHolders();
    return this.list().map((r) => ({ ...r, holders: holders.filter((h) => h.roleId === r.id).map((h) => h.name) }));
  }

  /** Rollen-ID → Benutzer, die sie gerade halten */
  holderIds(): Map<number, Set<number>> {
    const map = new Map<number, Set<number>>();
    for (const h of this.sessions.roleHolders()) map.set(h.roleId, (map.get(h.roleId) ?? new Set()).add(h.userId));
    return map;
  }

  find(id: number): Role | null {
    const r = this.db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined;
    return r ? toRole(r) : null;
  }

  get(id: number): Role {
    const r = this.find(id);
    if (!r) throw new HttpError(404, 'Rolle nicht gefunden');
    return r;
  }

  private assertUnique(name: string, exceptId = 0): void {
    const clash = this.db.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE AND id != ?').get(name, exceptId);
    if (clash) throw new HttpError(409, `Die Rolle „${name}“ gibt es bereits`);
  }

  create(input: RoleInput): Role {
    this.assertUnique(input.name);
    const sort = (this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM roles').get() as { n: number }).n;
    const info = this.db.prepare('INSERT INTO roles (name, description, sort) VALUES (?, ?, ?)').run(input.name, input.description, sort);
    return this.get(Number(info.lastInsertRowid));
  }

  update(id: number, input: RoleInput): Role {
    this.get(id);
    this.assertUnique(input.name, id);
    this.db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?').run(input.name, input.description, id);
    return this.get(id);
  }

  /** Sitzungen verlieren die Rolle (ON DELETE CASCADE), Aufgaben für sie gehen an alle (ON DELETE SET NULL) */
  remove(id: number): Role {
    const role = this.get(id);
    this.db.prepare('DELETE FROM roles WHERE id = ?').run(id);
    return role;
  }

  reorder(ids: number[]): Role[] {
    const update = this.db.prepare('UPDATE roles SET sort = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id, i) => update.run(i, id)))();
    return this.list();
  }
}
