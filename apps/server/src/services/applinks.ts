import {
  formatDeviceId,
  type AppLink,
  type AppRelayStatus,
  type ElwPositionBatch,
  type ElwRegistration,
  type PairInput,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { IncidentService } from './incidents.js';

/** Antwort des Relays: Status und JSON-Inhalt (oder null ohne Inhalt) */
export type RelayFetch = (url: string, init: { method: string; token?: string; body?: unknown; timeoutMs: number }) => Promise<{ status: number; body: unknown }>;

const defaultFetch: RelayFetch = async (url, { method, token, body, timeoutMs }) => {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const SETTINGS_KEY = 'app:relay';
const TIMEOUT_MS = 10_000;
/** So oft fragt ELVIS beim Relay nach neuen Positionen, solange Apps gekoppelt sind */
export const APP_POLL_MS = 15_000;

interface Credentials {
  elwId: string;
  token: string;
  /** Letzte abgeholte Position (seq) */
  cursor: number;
}

interface LinkRow {
  id: number;
  unit_id: number;
  incident_id: number;
  device_id: string;
  paired_at: string;
  paired_by: string;
  ended_at: string | null;
  relay_pending: number;
  last_position_at: string | null;
  accuracy_m: number | null;
  battery: number | null;
}

const toLink = (r: LinkRow): AppLink => ({
  unitId: r.unit_id,
  deviceId: r.device_id,
  pairedAt: r.paired_at,
  pairedBy: r.paired_by,
  lastPositionAt: r.last_position_at,
  accuracyM: r.accuracy_m,
  battery: r.battery,
});

class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * App-Anbindung: Apps von Einsatzkräften werden über das Cloud-Relay (apps/relay) mit einer Einheit im
 * Einsatz gekoppelt; ELVIS holt ihre Positionen ausgehend ab und setzt die Einheit auf der Karte. Die
 * Kopplung endet beim Entkoppeln, beim Entlassen der Einheit und mit dem Einsatz – die App hört dann auf
 * zu orten. Kann das Relay beim Entkoppeln nicht erreicht werden, holt der nächste Lauf das nach.
 */
export class AppLinkService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly incidents: IncidentService,
    private readonly notify: (topics: Topic[]) => void,
    private readonly relayUrl: string | null,
    private readonly relayFetch: RelayFetch = defaultFetch,
  ) {}

  start(): void {
    if (!this.relayUrl) return;
    void this.poll();
    this.schedule();
  }

  /** Regelmäßig abrufen, solange Kopplungen bestehen oder Entkopplungen ausstehen (der Lauf hält sich sonst selbst an) */
  private schedule(): void {
    if (this.relayUrl && !this.timer) this.timer = setInterval(() => void this.poll(), APP_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): AppRelayStatus {
    return {
      enabled: this.relayUrl !== null,
      relayUrl: this.relayUrl,
      registered: this.credentials() !== null,
      activeLinks: this.activeRows().length,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
    };
  }

  /** Aktive Kopplungen eines Einsatzes */
  list(incidentId: number): AppLink[] {
    return (this.db.prepare('SELECT * FROM app_links WHERE incident_id = ? AND ended_at IS NULL ORDER BY id').all(incidentId) as LinkRow[]).map(toLink);
  }

  async pair(unitId: number, input: { deviceId: string; code: string }, operator: string): Promise<AppLink> {
    const unit = this.store.unit(unitId);
    if (!unit) throw new HttpError(404, `Einheit ${unitId} nicht gefunden`);
    const incident = this.store.incident(unit.incidentId)!;
    if (incident.closedAt) throw new HttpError(409, 'Einsatz ist abgeschlossen und kann nicht mehr geändert werden');
    if (unit.status === 'entlassen') throw new HttpError(409, `${unit.name} ist bereits entlassen`);
    const other = this.activeRows().find((r) => r.device_id === input.deviceId && r.unit_id !== unitId);
    if (other) throw new HttpError(409, `Diese App ist bereits mit ${this.store.unit(other.unit_id)?.name ?? 'einer anderen Einheit'} gekoppelt`);

    const label = [unit.name, [incident.keyword, incident.title].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    try {
      await this.call('POST', '/v1/elws/me/pairings', { deviceId: input.deviceId, code: input.code, label } satisfies PairInput & { label: string });
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) throw new HttpError(400, 'App-ID nicht gefunden – ist die App beim Relay angemeldet?');
      if (e instanceof RelayError && e.status === 403) throw new HttpError(400, 'Code falsch – bitte den aktuellen Code aus der App eingeben');
      if (e instanceof RelayError && e.status === 409) throw new HttpError(409, 'Diese App ist bereits mit einem anderen ELW gekoppelt');
      if (e instanceof RelayError && e.status === 429) throw new HttpError(429, 'Zu viele Fehlversuche – die App zeigt jetzt einen neuen Code');
      if (e instanceof RelayError) throw new HttpError(502, e.message);
      throw e;
    }

    const ts = new Date().toISOString();
    const previous = this.activeRows().find((r) => r.unit_id === unitId);
    const link = this.store.transaction(() => {
      // Eine Einheit hat höchstens eine App; die bisherige wird beim Relay entkoppelt (nachgeholt im nächsten Lauf)
      if (previous && previous.device_id !== input.deviceId) this.end(previous.id, ts, true);
      else if (previous) this.db.prepare('DELETE FROM app_links WHERE id = ?').run(previous.id);
      const info = this.db
        .prepare('INSERT INTO app_links (unit_id, incident_id, device_id, paired_at, paired_by) VALUES (?, ?, ?, ?, ?)')
        .run(unitId, unit.incidentId, input.deviceId, ts, operator);
      this.incidents.unitEvent(unitId, `App ${formatDeviceId(input.deviceId)} gekoppelt`, operator);
      return toLink(this.db.prepare('SELECT * FROM app_links WHERE id = ?').get(info.lastInsertRowid) as LinkRow);
    });
    this.notify(['appLinks']);
    this.schedule();
    return link;
  }

  async unpair(unitId: number, operator: string): Promise<void> {
    const row = this.activeRows().find((r) => r.unit_id === unitId);
    if (!row) throw new HttpError(404, 'Keine App mit dieser Einheit gekoppelt');
    this.store.transaction(() => {
      this.end(row.id, new Date().toISOString(), true);
      this.incidents.unitEvent(unitId, `App ${formatDeviceId(row.device_id)} entkoppelt`, operator);
    });
    this.notify(['appLinks']);
    // Relay nicht erreichbar: der regelmäßige Lauf holt das Entkoppeln nach
    this.schedule();
    await this.release(row).catch(() => undefined);
  }

  /** Ein Lauf: beendete Kopplungen aufräumen, beim Relay entkoppeln, neue Positionen übernehmen */
  poll(): Promise<void> {
    this.running ??= this.run()
      .then(() => {
        this.lastError = null;
      })
      .catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run(): Promise<void> {
    if (!this.relayUrl) return;
    const ts = new Date().toISOString();
    let changed = false;
    for (const r of this.activeRows()) {
      const unit = this.store.unit(r.unit_id);
      if (!unit || unit.status === 'entlassen' || this.store.incident(r.incident_id)?.closedAt) {
        this.end(r.id, ts, true);
        changed = true;
      }
    }
    if (changed) this.notify(['appLinks']);

    for (const r of this.db.prepare('SELECT * FROM app_links WHERE relay_pending = 1').all() as LinkRow[]) await this.release(r);

    const active = this.activeRows();
    if (active.length === 0) {
      if (this.timer && !this.pendingCount()) this.stop();
      return;
    }
    const creds = await this.ensureCredentials();
    const batch = (await this.call('GET', `/v1/elws/me/positions?after=${creds.cursor}`)) as ElwPositionBatch;
    this.lastPollAt = new Date().toISOString();
    const latest = new Map<string, ElwPositionBatch['items'][number]>();
    for (const item of batch.items) {
      const prev = latest.get(item.deviceId);
      if (!prev || prev.ts < item.ts) latest.set(item.deviceId, item);
    }
    let updated = false;
    for (const [deviceId, pos] of latest) {
      const link = active.find((r) => r.device_id === deviceId);
      if (!link) continue;
      this.incidents.setUnitPositionFromApp(link.unit_id, pos);
      this.db
        .prepare('UPDATE app_links SET last_position_at = ?, accuracy_m = ?, battery = ? WHERE id = ? AND (last_position_at IS NULL OR last_position_at < ?)')
        .run(pos.ts, pos.accuracyM, pos.battery, link.id, pos.ts);
      updated = true;
    }
    if (batch.next !== creds.cursor) this.saveCredentials({ ...creds, cursor: batch.next });
    if (updated) this.notify(['appLinks']);
    // Mehr als ein Paket wartet: gleich weiter abholen
    if (batch.items.length >= 500) await this.run();
  }

  private activeRows(): LinkRow[] {
    return this.db.prepare('SELECT * FROM app_links WHERE ended_at IS NULL').all() as LinkRow[];
  }

  private pendingCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM app_links WHERE relay_pending = 1').get() as { n: number }).n;
  }

  private end(id: number, ts: string, pending: boolean): void {
    this.db.prepare('UPDATE app_links SET ended_at = COALESCE(ended_at, ?), relay_pending = ? WHERE id = ?').run(ts, pending ? 1 : 0, id);
  }

  /** Beim Relay entkoppeln – nur, wenn das Gerät nicht inzwischen wieder (mit einer anderen Einheit) gekoppelt ist */
  private async release(r: LinkRow): Promise<void> {
    if (!this.activeRows().some((a) => a.device_id === r.device_id)) {
      try {
        await this.call('DELETE', `/v1/elws/me/pairings/${r.device_id}`);
      } catch (e) {
        if (!(e instanceof RelayError && e.status === 404)) throw e;
      }
    }
    this.db.prepare('UPDATE app_links SET relay_pending = 0 WHERE id = ?').run(r.id);
  }

  private credentials(): Credentials | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Credentials) : null;
  }

  private saveCredentials(c: Credentials): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(SETTINGS_KEY, JSON.stringify(c), new Date().toISOString());
  }

  /** Beim ersten Bedarf meldet sich der ELW beim Relay an */
  private async ensureCredentials(): Promise<Credentials> {
    const existing = this.credentials();
    if (existing) return existing;
    const reg = (await this.call('POST', '/v1/elws', {}, false)) as ElwRegistration;
    const creds = { elwId: reg.elwId, token: reg.token, cursor: 0 };
    this.saveCredentials(creds);
    return creds;
  }

  private async call(method: string, path: string, body?: unknown, auth = true): Promise<unknown> {
    if (!this.relayUrl) throw new HttpError(503, 'App-Anbindung ist nicht eingerichtet (app.relayUrl in config/elvis.json)');
    const token = auth ? (await this.ensureCredentials()).token : undefined;
    let res: { status: number; body: unknown };
    try {
      res = await this.relayFetch(`${this.relayUrl.replace(/\/$/, '')}${path}`, { method, token, body, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      throw new HttpError(502, `App-Relay nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401 && auth) {
      // Zugang beim Relay verloren (z. B. Relay neu aufgesetzt): neu anmelden, Cursor beginnt von vorn
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(SETTINGS_KEY);
      throw new RelayError(401, 'ELW beim App-Relay nicht mehr bekannt – neu angemeldet, bitte Apps neu koppeln');
    }
    if (res.status >= 400) {
      const msg = (res.body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new RelayError(res.status, `App-Relay: ${msg}`);
    }
    return res.body;
  }
}
