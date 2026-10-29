import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';

export const SESSION_COOKIE = 'elvis_session';
/** Abmeldung nach Inaktivität bzw. spätestens nach der Höchstdauer. */
export const SESSION_IDLE_MS = 12 * 3600_000;
export const SESSION_MAX_MS = 7 * 86_400_000;
const TOUCH_INTERVAL_MS = 60_000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

interface SessionRow {
  token_hash: string;
  user_id: number;
  created_at: string;
  last_seen_at: string;
  role_chosen: number;
}

export interface SessionInfo {
  userId: number;
  /** Übernommene Rollen (siehe services/roles.ts) */
  roleIds: number[];
  /** false direkt nach der Anmeldung, bis der Benutzer Rollen (oder keine) gewählt hat */
  roleChosen: boolean;
}

/** Sitzungen in SQLite (überstehen Neustarts); gespeichert wird nur der Hash des Tokens. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(userId: number, userAgent: string): string {
    const token = randomBytes(32).toString('base64url');
    const ts = new Date(this.now()).toISOString();
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)').run(hash(token), userId, ts, ts, userAgent.slice(0, 200));
    return token;
  }

  /** Liefert Benutzer und Rollen einer gültigen Sitzung und verlängert sie (gleitend). */
  resolve(token: string | undefined): SessionInfo | null {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash(token)) as SessionRow | undefined;
    if (!row) return null;
    const t = this.now();
    const lastSeen = Date.parse(row.last_seen_at);
    if (t - lastSeen > SESSION_IDLE_MS || t - Date.parse(row.created_at) > SESSION_MAX_MS) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    if (t - lastSeen > TOUCH_INTERVAL_MS) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(t).toISOString(), row.token_hash);
    const roleIds = (this.db.prepare('SELECT role_id FROM session_roles WHERE token_hash = ? ORDER BY role_id').all(row.token_hash) as { role_id: number }[]).map((r) => r.role_id);
    return { userId: row.user_id, roleIds, roleChosen: row.role_chosen === 1 };
  }

  /** Rollen der Sitzung ersetzen; leere Liste = ohne Rolle */
  setRoles(token: string, roleIds: number[]): void {
    const h = hash(token);
    const add = this.db.prepare('INSERT OR IGNORE INTO session_roles (token_hash, role_id) VALUES (?, ?)');
    const remember = this.db.prepare('INSERT OR IGNORE INTO user_last_roles (user_id, role_id) VALUES (?, ?)');
    this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET role_chosen = 1 WHERE token_hash = ?').run(h);
      this.db.prepare('DELETE FROM session_roles WHERE token_hash = ?').run(h);
      for (const id of roleIds) add.run(h, id);
      // Für die Vorauswahl bei der nächsten Anmeldung merken
      const session = this.db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(h) as { user_id: number } | undefined;
      if (!session) return;
      this.db.prepare('DELETE FROM user_last_roles WHERE user_id = ?').run(session.user_id);
      for (const id of roleIds) remember.run(session.user_id, id);
    })();
  }

  /** Zuletzt gewählte Rollen des Benutzers (Vorauswahl nach der Anmeldung) */
  lastRoles(userId: number): number[] {
    return (this.db.prepare('SELECT role_id FROM user_last_roles WHERE user_id = ? ORDER BY role_id').all(userId) as { role_id: number }[]).map((r) => r.role_id);
  }

  /** Wer welche Rollen in einer noch gültigen Sitzung übernommen hat */
  roleHolders(): { roleId: number; userId: number; name: string }[] {
    const t = this.now();
    return this.db
      .prepare(
        `SELECT DISTINCT sr.role_id AS roleId, u.id AS userId, u.first_name || ' ' || u.last_name AS name
         FROM session_roles sr JOIN sessions s ON s.token_hash = sr.token_hash JOIN users u ON u.id = s.user_id
         WHERE s.last_seen_at > ? AND s.created_at > ?
         ORDER BY u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE`,
      )
      .all(new Date(t - SESSION_IDLE_MS).toISOString(), new Date(t - SESSION_MAX_MS).toISOString()) as { roleId: number; userId: number; name: string }[];
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
  }

  revokeUser(userId: number, exceptToken?: string): void {
    if (exceptToken) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hash(exceptToken));
    else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}
