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

  /** Liefert die Benutzer-ID einer gültigen Sitzung und verlängert sie (gleitend). */
  resolve(token: string | undefined): number | null {
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
    return row.user_id;
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
  }

  revokeUser(userId: number, exceptToken?: string): void {
    if (exceptToken) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hash(exceptToken));
    else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}
