import {
  applyBbox,
  overpassQl,
  overpassQueryListSchema,
  overpassToFeatures,
  type OverpassBounds,
  type OverpassJson,
  type OverpassQuery,
  type OverpassQuerySettings,
  type OverpassResult,
  type OverpassStatus,
} from '@elvis/shared';
import { isMapIcon } from '@elvis/shared/mapIcons';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { Throttle } from './geocoder.js';

/** Overpass-API eines Addons (OSM-Daten) */
export interface OverpassProvision {
  id: string;
  name: string;
  /** Basisadresse; die Abfrage geht an <url>/api/interpreter */
  url: string;
}

export interface OverpassOptions {
  /** Öffentlicher Overpass-Server als Rückfall, solange kein Addon bereit ist; null = nur lokal */
  onlineUrl: string | null;
  userAgent: string;
  /** Wartezeiten vor erneuten Versuchen, wenn der öffentliche Server ausgelastet ist (502–504) */
  retryDelaysMs?: number[];
}

/** overpass-api.de meldet „at capacity … request queue is full“ als 502, Zeitüberschreitung als 504 */
const busy = (e: unknown) => e instanceof OverpassError && e.status !== null && e.status >= 502 && e.status <= 504;
const RETRY_DELAYS_MS = [2_000, 5_000];

/** Fehlerantwort von Overpass mit HTTP-Status (400 = Abfrage fehlerhaft, 429 = zu viele Anfragen, 504 = überlastet) */
export class OverpassError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export type OverpassFetch = (url: string, ql: string, opts: { timeoutMs: number; userAgent: string }) => Promise<unknown>;

/** Fehlermeldungen stehen in der HTML-Antwort als „<strong …>Error</strong>: line 2: parse error: …“ */
export function overpassErrorText(html: string): string | null {
  const lines = [...html.matchAll(/<strong[^>]*>Error<\/strong>:\s*([^<]+)/g)].map((m) => m[1]!.trim().replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  return lines.length ? lines.slice(0, 3).join(' · ') : null;
}

const defaultFetch: OverpassFetch = async (url, ql, { timeoutMs, userAgent }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'user-agent': userAgent, 'content-type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(ql)}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new OverpassError(overpassErrorText(await res.text().catch(() => '')) ?? `HTTP ${res.status}`, res.status);
  // Laufzeitfehler vor der Abfrage (z. B. Dispatcher nicht erreichbar) kommen trotz [out:json] als HTML mit 200
  const text = await res.text();
  if (!text.trimStart().startsWith('{')) throw new OverpassError(overpassErrorText(text) ?? 'Antwort ist kein JSON', null);
  return JSON.parse(text);
};

const SETTINGS_KEY = 'map:overpassQueries';
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 180;
/** Öffentliche Server erlauben nur wenige Anfragen gleichzeitig */
const ONLINE_GAP_MS = 1_000;

const interpreter = (url: string) => (/\/api\/interpreter\/?$/.test(url) ? url : `${url.replace(/\/+$/, '')}/api/interpreter`);

/** JSON-Ausgabe erzwingen und die Laufzeit begrenzen; Kartenausschnitt einsetzen */
export function prepareQl(ql: string, bounds: OverpassBounds): string {
  let q = applyBbox(ql.trim(), bounds).replace(/\[out:[^\]]*\]/g, '[out:json]');
  if (!q.includes('[out:json]')) q = q.startsWith('[') ? `[out:json]${q}` : `[out:json];\n${q}`;
  if (/\[timeout:\s*\d+\s*\]/.test(q)) q = q.replace(/\[timeout:\s*(\d+)\s*\]/g, (_, n: string) => `[timeout:${Math.min(Number(n), MAX_TIMEOUT_S)}]`);
  else q = q.replace('[out:json]', `[out:json][timeout:${DEFAULT_TIMEOUT_S}]`);
  return q;
}

const timeoutOf = (ql: string) => (Number(/\[timeout:(\d+)\]/.exec(ql)?.[1]) || DEFAULT_TIMEOUT_S) * 1000 + 10_000;

/**
 * Overpass-Abfragen der Karte: zuerst die Overpass-API laufender Addons (offline, nur deren Regionen), sonst bzw.
 * bei Ausfall der öffentliche Server. Dazu die Standardabfragen aus den Einstellungen.
 */
export class OverpassService {
  private providers: OverpassProvision[] = [];
  private readonly online: Throttle;

  constructor(
    private readonly opts: OverpassOptions,
    private readonly db: Db,
    private readonly fetchJson: OverpassFetch = defaultFetch,
    now: () => number = Date.now,
  ) {
    this.online = new Throttle(ONLINE_GAP_MS, now);
  }

  /** Overpass-APIs laufender Addons; liefert true bei Änderung */
  setProvisions(list: OverpassProvision[]): boolean {
    if (JSON.stringify(list) === JSON.stringify(this.providers)) return false;
    this.providers = list;
    return true;
  }

  status(): OverpassStatus {
    const local = this.providers[0];
    if (local) return { source: 'local', name: local.name };
    if (this.opts.onlineUrl) return { source: 'online', name: new URL(this.opts.onlineUrl).host };
    return { source: null, name: null };
  }

  async run(query: OverpassQuery, bounds: OverpassBounds): Promise<OverpassResult> {
    const ql = prepareQl(overpassQl(query), bounds);
    const opts = { timeoutMs: timeoutOf(ql), userAgent: this.opts.userAgent };
    const errors: string[] = [];
    for (const p of this.providers) {
      try {
        return this.result(await this.fetchJson(interpreter(p.url), ql, opts), 'local', p.name);
      } catch (e) {
        if (e instanceof OverpassError && e.status === 400) throw new HttpError(400, `Abfrage fehlerhaft: ${e.message}`);
        errors.push(`${p.name}: ${(e as Error).message}`);
      }
    }
    if (this.opts.onlineUrl) {
      const host = new URL(this.opts.onlineUrl).host;
      const ask = () => this.online.run(() => this.fetchJson(interpreter(this.opts.onlineUrl!), ql, opts));
      try {
        // Ausgelastet: die Warteschlange ist meist nach wenigen Sekunden wieder frei
        const waits = [0, ...(this.opts.retryDelaysMs ?? RETRY_DELAYS_MS)];
        let json: unknown;
        for (const [i, wait] of waits.entries()) {
          if (wait) await new Promise((r) => setTimeout(r, wait));
          try {
            json = await ask();
            break;
          } catch (e) {
            if (!busy(e) || i === waits.length - 1) throw e;
          }
        }
        return this.result(json, 'online', host);
      } catch (e) {
        if (e instanceof OverpassError && e.status === 400) throw new HttpError(400, `Abfrage fehlerhaft: ${e.message}`);
        if (e instanceof OverpassError && e.status === 429) errors.push(`${host}: zu viele Anfragen, bitte kurz warten`);
        else if (busy(e)) errors.push(`${host}: öffentlicher Server ausgelastet, bitte in einer Minute erneut versuchen`);
        else errors.push(`${host}: ${(e as Error).message}`);
      }
    }
    throw new HttpError(502, errors.length ? `Overpass nicht erreichbar (${errors.join('; ')})` : 'Kein Overpass-Server eingerichtet');
  }

  private result(json: unknown, source: OverpassResult['source'], sourceName: string): OverpassResult {
    const data = (json ?? {}) as OverpassJson;
    if (!Array.isArray(data.elements)) throw new Error('Antwort ohne Elemente');
    return { source, sourceName, ...overpassToFeatures(data), remark: data.remark?.trim() || null };
  }

  // --- Vorlagen (Einstellungen, erscheinen im Menü „Objekte“) ---

  settings(): OverpassQuerySettings {
    const r = this.db.prepare('SELECT value, updated_at, updated_by FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
    const parsed = r ? overpassQueryListSchema.safeParse(JSON.parse(r.value)) : null;
    return { queries: parsed?.success ? parsed.data : [], updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
  }

  setQueries(queries: OverpassQuery[], actor: string): OverpassQuerySettings {
    for (const q of queries) checkOverpassIcon(q);
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(SETTINGS_KEY, JSON.stringify(queries), new Date().toISOString(), actor);
    return this.settings();
  }
}

/** Unbekannte Symbole abweisen (das Schema prüft nur die Form des Namens) */
export function checkOverpassIcon(q: OverpassQuery): void {
  if (q.icon && !isMapIcon(q.icon)) throw new HttpError(400, `„${q.name}“: Symbol „${q.icon}“ gibt es nicht`);
}
