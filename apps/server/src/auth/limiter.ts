import { HttpError } from '../errors.js';

const USER_FREE_ATTEMPTS = 3;
const USER_BASE_LOCK_MS = 30_000;
const USER_MAX_LOCK_MS = 15 * 60_000;
const CLIENT_WINDOW_MS = 10 * 60_000;
const CLIENT_MAX_FAILURES = 10;
const CLIENT_LOCK_MS = 10 * 60_000;

interface UserState {
  failures: number;
  lockedUntil: number;
}

interface ClientState {
  failures: number[];
  lockedUntil: number;
}

/**
 * Bremst PIN-Raten aus: je Benutzer wachsende Sperre nach Fehlversuchen,
 * je Gerät (IP) eine Sperre nach vielen Fehlversuchen über mehrere Benutzer.
 */
export class LoginLimiter {
  private readonly users = new Map<number, UserState>();
  private readonly clients = new Map<string, ClientState>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Wirft 429, wenn Benutzer oder Gerät gesperrt sind. */
  assertAllowed(userId: number, client: string): void {
    const t = this.now();
    const c = this.clients.get(client);
    if (c && c.lockedUntil > t) throw lockedError(c.lockedUntil - t, 'Zu viele Fehlversuche von diesem Gerät');
    const u = this.users.get(userId);
    if (u && u.lockedUntil > t) throw lockedError(u.lockedUntil - t, 'Zu viele falsche PINs für diesen Benutzer');
  }

  /** Verbleibende Versuche bis zur nächsten Sperre. */
  failure(userId: number, client: string): number {
    const t = this.now();
    const u = this.users.get(userId) ?? { failures: 0, lockedUntil: 0 };
    u.failures++;
    if (u.failures >= USER_FREE_ATTEMPTS) {
      const exp = u.failures - USER_FREE_ATTEMPTS;
      u.lockedUntil = t + Math.min(USER_MAX_LOCK_MS, USER_BASE_LOCK_MS * 2 ** exp);
    }
    this.users.set(userId, u);

    const c = this.clients.get(client) ?? { failures: [], lockedUntil: 0 };
    c.failures = [...c.failures.filter((f) => t - f < CLIENT_WINDOW_MS), t];
    if (c.failures.length >= CLIENT_MAX_FAILURES) c.lockedUntil = t + CLIENT_LOCK_MS;
    this.clients.set(client, c);

    return Math.max(0, USER_FREE_ATTEMPTS - u.failures);
  }

  success(userId: number): void {
    this.users.delete(userId);
  }
}

function lockedError(ms: number, reason: string): HttpError {
  const s = Math.ceil(ms / 1000);
  return new HttpError(429, `${reason} – erneut möglich in ${s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`}`);
}
