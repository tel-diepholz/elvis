import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fullName, type User, type Workstation, type WorkstationIncident, type WorkstationInstaller, type WorkstationState, type WorkstationUser } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';

/** Registrierung eines Addons (provides.workstations): der Installer meldet neue Arbeitsplätze mit diesem Token an */
export interface WorkstationProvision {
  id: string;
  name: string;
  token: string;
  installerIso?: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

interface Row {
  id: string;
  name: string;
  hostname: string;
  mac: string;
  token_hash: string;
  enrolled_at: string;
  last_seen_at: string | null;
  last_user: string | null;
  version: string;
}

const toWorkstation = (r: Row): Workstation => ({
  id: r.id,
  name: r.name,
  hostname: r.hostname,
  mac: r.mac,
  enrolledAt: r.enrolled_at,
  lastSeenAt: r.last_seen_at,
  lastUser: r.last_user,
  version: r.version,
});

/**
 * Arbeitsplätze aus dem Addon „ELVIS Arbeitsplatz“. Der Installer registriert das Gerät mit dem Addon-Token und
 * bekommt ein eigenes Gerätetoken (gespeichert wird nur der Hash). Damit liest der Client-Dienst Benutzer und Einsatz
 * und prüft PINs – ohne Web-Sitzung. Entfernen sperrt das Gerät.
 */
export class WorkstationService {
  private provisions: WorkstationProvision[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  setProvisions(list: WorkstationProvision[]): void {
    const changed = JSON.stringify(list.map((p) => p.installerIso)) !== JSON.stringify(this.provisions.map((p) => p.installerIso));
    this.provisions = list;
    if (changed) this.changed();
  }

  /** Download-Adressen der Installer-ISO (ohne Registrierungstoken) */
  installers(): WorkstationInstaller[] {
    return this.provisions.filter((p) => p.installerIso).map((p) => ({ id: p.id, name: p.name, isoUrl: p.installerIso! }));
  }

  list(): Workstation[] {
    return (this.db.prepare('SELECT * FROM workstations ORDER BY name COLLATE NOCASE').all() as Row[]).map(toWorkstation);
  }

  get(id: string): Workstation {
    return toWorkstation(this.row(id));
  }

  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM workstations WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'Arbeitsplatz nicht gefunden');
    return r;
  }

  /** Arbeitsplatz zum Gerätetoken (Authorization: Bearer) */
  resolve(token: string | undefined): Workstation | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT * FROM workstations WHERE token_hash = ?').get(hash(token)) as Row | undefined;
    return r ? toWorkstation(r) : null;
  }

  /** Wie resolve, aber 401 ohne gültiges Token */
  require(token: string | undefined): Workstation {
    const w = this.resolve(token);
    if (!w) throw new HttpError(401, 'Arbeitsplatz nicht registriert');
    return w;
  }

  /** Neuinstallation (gleiche MAC) ersetzt den bisherigen Eintrag samt Token, der Name bleibt */
  enroll(secret: string, input: { hostname: string; mac: string }): { workstation: Workstation; token: string } {
    if (!secret || !this.provisions.some((p) => sameSecret(secret, p.token))) throw new HttpError(401, 'Unbekanntes Registrierungstoken – läuft das Addon „ELVIS Arbeitsplatz“?');
    const token = randomBytes(32).toString('base64url');
    const at = new Date(this.now()).toISOString();
    const existing = this.db.prepare('SELECT * FROM workstations WHERE mac = ?').get(input.mac) as Row | undefined;
    let id: string;
    if (existing) {
      id = existing.id;
      this.db
        .prepare('UPDATE workstations SET hostname = ?, token_hash = ?, enrolled_at = ?, last_seen_at = NULL, last_user = NULL WHERE id = ?')
        .run(input.hostname, hash(token), at, id);
    } else {
      id = `ws-${randomBytes(4).toString('hex')}`;
      this.db
        .prepare('INSERT INTO workstations (id, name, hostname, mac, token_hash, enrolled_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.hostname, input.hostname, input.mac, hash(token), at);
    }
    this.changed();
    return { workstation: this.get(id), token };
  }

  /**
   * Stempel der PIN je Gerät: ändert sich mit jeder neuen PIN, damit der Client seinen Offline-Verifier verwirft.
   * Schlüssel ist der Token-Hash des Geräts – der Stempel taugt nicht zum Raten und ist auf anderen Geräten anders.
   */
  private stamp(ws: Row, pinHash: string): string {
    return createHmac('sha256', ws.token_hash).update(pinHash).digest('base64url').slice(0, 22);
  }

  private users(ws: Row): WorkstationUser[] {
    const rows = this.db.prepare('SELECT id, first_name, last_name, pin_hash FROM users ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE').all() as {
      id: number;
      first_name: string;
      last_name: string;
      pin_hash: string;
    }[];
    return rows.map((u) => ({ id: u.id, firstName: u.first_name, lastName: u.last_name, pinStamp: this.stamp(ws, u.pin_hash) }));
  }

  private incident(): WorkstationIncident | null {
    const i = this.store.activeIncident();
    return i ? { id: i.id, keyword: i.keyword, title: i.title } : null;
  }

  state(id: string): WorkstationState {
    const ws = this.row(id);
    return { workstation: { id: ws.id, name: ws.name }, users: this.users(ws), incident: this.incident(), serverTime: new Date(this.now()).toISOString() };
  }

  /** Nach erfolgreicher PIN-Prüfung: Benutzer mit Stempel und aktueller Einsatz */
  loggedIn(id: string, user: User): { user: WorkstationUser; incident: WorkstationIncident | null } {
    const ws = this.row(id);
    const entry = this.users(ws).find((u) => u.id === user.id)!;
    this.db.prepare('UPDATE workstations SET last_user = ?, last_seen_at = ? WHERE id = ?').run(fullName(user), new Date(this.now()).toISOString(), id);
    this.changed();
    return { user: entry, incident: this.incident() };
  }

  touch(id: string, info: { version?: string; user?: string | null }): void {
    const before = this.row(id);
    const version = info.version ?? before.version;
    const user = info.user === undefined ? before.last_user : info.user;
    this.db.prepare('UPDATE workstations SET last_seen_at = ?, version = ?, last_user = ? WHERE id = ?').run(new Date(this.now()).toISOString(), version, user, id);
    if (version !== before.version || user !== before.last_user || !before.last_seen_at) this.changed();
  }

  rename(id: string, name: string): Workstation {
    this.row(id);
    this.db.prepare('UPDATE workstations SET name = ? WHERE id = ?').run(name.trim(), id);
    this.changed();
    return this.get(id);
  }

  remove(id: string): Workstation {
    const w = this.get(id);
    this.db.prepare('DELETE FROM workstations WHERE id = ?').run(id);
    this.changed();
    return w;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    this.listeners.forEach((l) => l());
  }
}
