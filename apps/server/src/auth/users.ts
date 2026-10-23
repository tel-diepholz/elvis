import { fullName, PIN_PATTERN, type LoginCandidate, type NewUser, type User, type UserPatch } from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { hashPin, verifyPin } from './pin.js';

interface UserRow {
  id: number;
  first_name: string;
  last_name: string;
  pin_hash: string;
  is_admin: number;
  created_at: string;
  created_by: string;
  last_login_at: string | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  firstName: r.first_name,
  lastName: r.last_name,
  isAdmin: r.is_admin === 1,
  createdAt: r.created_at,
  createdBy: r.created_by,
  lastLoginAt: r.last_login_at,
});

const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

function assertPin(pin: string): void {
  if (!PIN_PATTERN.test(pin)) throw new HttpError(400, 'Die PIN muss aus genau 4 Ziffern bestehen');
}

/**
 * Benutzer mit Admin-Flag. Regeln: Jeder Benutzer darf Benutzer anlegen, nur Admins vergeben
 * das Admin-Flag, bearbeiten oder löschen andere. Der letzte Admin bleibt immer erhalten.
 */
export class UserService {
  constructor(private readonly db: Db) {}

  hasUsers(): boolean {
    return !!this.db.prepare('SELECT 1 FROM users LIMIT 1').get();
  }

  list(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE').all() as UserRow[]).map(toUser);
  }

  candidates(): LoginCandidate[] {
    return this.list().map(({ id, firstName, lastName }) => ({ id, firstName, lastName }));
  }

  get(id: number): User {
    return toUser(this.row(id));
  }

  find(id: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  private row(id: number): UserRow {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!r) throw new HttpError(404, 'Benutzer nicht gefunden');
    return r;
  }

  private adminCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
  }

  private assertUniqueName(first: string, last: string, exceptId?: number): void {
    const clash = this.db.prepare('SELECT id FROM users WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)').get(first, last) as { id: number } | undefined;
    if (clash && clash.id !== exceptId) throw new HttpError(409, `„${first} ${last}“ gibt es bereits – zur Unterscheidung z. B. einen zweiten Vornamen ergänzen`);
  }

  /** Erster Benutzer beim allerersten Start – immer Admin. */
  async setupFirstAdmin(input: NewUser): Promise<User> {
    if (this.hasUsers()) throw new HttpError(409, 'Es gibt bereits Benutzer');
    const user = await this.insert({ ...input, isAdmin: true }, 'Ersteinrichtung');
    // Die Ersteinrichtung meldet direkt an.
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    return this.get(user.id);
  }

  async create(input: NewUser, actor: User): Promise<User> {
    if (input.isAdmin && !actor.isAdmin) throw new HttpError(403, 'Nur Admins können Admin-Rechte vergeben');
    return this.insert(input, fullName(actor));
  }

  private async insert(input: NewUser, createdBy: string): Promise<User> {
    const first = cleanName(input.firstName);
    const last = cleanName(input.lastName);
    if (!first || !last) throw new HttpError(400, 'Vor- und Nachname sind erforderlich');
    assertPin(input.pin);
    this.assertUniqueName(first, last);
    const info = this.db
      .prepare('INSERT INTO users (first_name, last_name, pin_hash, is_admin, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(first, last, await hashPin(input.pin), input.isAdmin ? 1 : 0, new Date().toISOString(), createdBy);
    return this.get(Number(info.lastInsertRowid));
  }

  async update(id: number, patch: UserPatch, actor: User): Promise<User> {
    const current = this.row(id);
    const self = actor.id === id;
    if (!actor.isAdmin && !self) throw new HttpError(403, 'Nur Admins können andere Benutzer bearbeiten');
    if (patch.isAdmin !== undefined && patch.isAdmin !== (current.is_admin === 1)) {
      if (!actor.isAdmin) throw new HttpError(403, 'Nur Admins können Admin-Rechte vergeben');
      if (!patch.isAdmin && this.adminCount() <= 1) throw new HttpError(409, 'Der letzte Admin kann nicht herabgestuft werden');
    }
    if (patch.pin !== undefined && self && !actor.isAdmin) throw new HttpError(403, 'Die eigene PIN wird über „PIN ändern“ mit der aktuellen PIN geändert');

    const first = patch.firstName !== undefined ? cleanName(patch.firstName) : current.first_name;
    const last = patch.lastName !== undefined ? cleanName(patch.lastName) : current.last_name;
    if (!first || !last) throw new HttpError(400, 'Vor- und Nachname sind erforderlich');
    this.assertUniqueName(first, last, id);
    let pinHash = current.pin_hash;
    if (patch.pin !== undefined) {
      assertPin(patch.pin);
      pinHash = await hashPin(patch.pin);
    }
    this.db
      .prepare('UPDATE users SET first_name = ?, last_name = ?, is_admin = ?, pin_hash = ? WHERE id = ?')
      .run(first, last, (patch.isAdmin ?? current.is_admin === 1) ? 1 : 0, pinHash, id);
    return this.get(id);
  }

  async changeOwnPin(id: number, currentPin: string, newPin: string): Promise<void> {
    const r = this.row(id);
    if (!(await verifyPin(currentPin, r.pin_hash))) throw new HttpError(403, 'Aktuelle PIN ist falsch');
    assertPin(newPin);
    this.db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(await hashPin(newPin), id);
  }

  remove(id: number, actor: User): User {
    if (!actor.isAdmin) throw new HttpError(403, 'Nur Admins können Benutzer löschen');
    const user = this.get(id);
    if (user.isAdmin && this.adminCount() <= 1) throw new HttpError(409, 'Der letzte Admin kann nicht gelöscht werden');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return user;
  }

  /** Prüft die PIN; bei Erfolg wird der Anmeldezeitpunkt vermerkt. */
  async checkPin(id: number, pin: string): Promise<User | null> {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    // Auch für unbekannte IDs rechnen, damit die Antwortzeit nichts verrät.
    const ok = await verifyPin(pin, r?.pin_hash ?? 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!r || !ok) return null;
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    return this.get(id);
  }
}
