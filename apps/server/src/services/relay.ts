import type { ElwRegistration } from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';

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

interface Credentials {
  elwId: string;
  token: string;
  /** Letzte abgeholte Position (seq) */
  cursor: number;
  /** Letzter abgeholter Personalbogen (seq) */
  sheetCursor?: number;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Zugang zum Cloud-Relay (tel-diepholz/elvis-relay): Der ELW meldet sich beim ersten Bedarf an; App-Anbindung
 * (Positionen) und Online-Formular (Personalbögen) teilen sich den Zugang. Die Cursor der Abrufe liegen mit
 * den Zugangsdaten in den Einstellungen.
 */
export class RelayClient {
  private registering: Promise<Credentials> | null = null;

  constructor(
    private readonly db: Db,
    readonly url: string | null,
    private readonly relayFetch: RelayFetch = defaultFetch,
  ) {}

  get enabled(): boolean {
    return this.url !== null;
  }

  credentials(): Credentials | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Credentials) : null;
  }

  /** Cursor fortschreiben (nur, wenn der Zugang noch derselbe ist) */
  saveCursor(elwId: string, patch: Pick<Credentials, 'cursor'> | Pick<Credentials, 'sheetCursor'>): void {
    const c = this.credentials();
    if (c?.elwId === elwId) this.save({ ...c, ...patch });
  }

  private save(c: Credentials): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(SETTINGS_KEY, JSON.stringify(c), new Date().toISOString());
  }

  /** Beim ersten Bedarf meldet sich der ELW beim Relay an */
  async ensureCredentials(): Promise<Credentials> {
    const existing = this.credentials();
    if (existing) return existing;
    this.registering ??= (async () => {
      const reg = (await this.call('POST', '/v1/elws', {}, false)) as ElwRegistration;
      const creds = { elwId: reg.elwId, token: reg.token, cursor: 0, sheetCursor: 0 };
      this.save(creds);
      return creds;
    })().finally(() => {
      this.registering = null;
    });
    return this.registering;
  }

  async call(method: string, path: string, body?: unknown, auth = true): Promise<unknown> {
    if (!this.url) throw new HttpError(503, 'Cloud-Anbindung ist nicht eingerichtet (app.relayUrl in config/elvis.json)');
    const token = auth ? (await this.ensureCredentials()).token : undefined;
    let res: { status: number; body: unknown };
    try {
      res = await this.relayFetch(`${this.url.replace(/\/$/, '')}${path}`, { method, token, body, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      throw new HttpError(502, `Cloud-Anbindung nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401 && auth) {
      // Zugang beim Relay verloren (z. B. Relay neu aufgesetzt): neu anmelden, Cursor beginnen von vorn
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(SETTINGS_KEY);
      throw new RelayError(401, 'ELW in der Cloud nicht mehr bekannt – neu angemeldet, bitte Apps neu koppeln und Cloud-Personalabfrage neu starten');
    }
    if (res.status >= 400) {
      const msg = (res.body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new RelayError(res.status, `Cloud: ${msg}`);
    }
    return res.body;
  }
}
