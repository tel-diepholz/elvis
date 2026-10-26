import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mapSourceInputSchema, mapSourceListSchema, type MapSource, type MapSourceInput, type MapSourceSettings, type MapSourceTestResult } from '@elvis/shared';
import type { ElvisConfig, MapSourceConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';

export interface Tile {
  data: Buffer;
  contentType: string;
}

const MAX_PARALLEL_FETCHES = 4;
const FETCH_TIMEOUT_MS = 10_000;
const SETTINGS_KEY = 'map:sources';
/** Halber Erdumfang in EPSG:3857 (Meter) */
const MERC_HALF = 20_037_508.342789244;

/** Ausschnitt einer XYZ-Kachel in EPSG:3857 als minx,miny,maxx,maxy (für WMS-Abfragen). */
export function tileBbox3857(z: number, x: number, y: number): [number, number, number, number] {
  const size = (2 * MERC_HALF) / 2 ** z;
  const minx = -MERC_HALF + x * size;
  const maxy = MERC_HALF - y * size;
  return [minx, maxy - size, minx + size, maxy];
}

/** Kachel, in der ein Punkt bei Zoomstufe z liegt. */
export function tileAt(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}

const toConfig = (s: MapSourceInput): MapSourceConfig => ({ ...s, subdomains: 'abc' });

/**
 * Kachel-Proxy mit Festplatten-Cache: Einmal geladene Kacheln stehen offline zur Verfügung,
 * und der Server meldet sich mit eigenem User-Agent (Tile-Usage-Policy von OSM).
 */
export class TileService {
  private readonly sources: Map<string, MapSourceConfig>;
  /** In den Einstellungen gepflegte Quellen (Datenbank) */
  private settingsSources = new Map<string, MapSourceConfig>();
  private addonSources = new Map<string, MapSourceConfig>();
  private readonly cacheDir: string | null;
  private readonly maxAgeMs: number;
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<Tile | null>>();

  constructor(
    private readonly config: ElvisConfig['map'],
    dataDir: string,
    private readonly db: Db,
  ) {
    this.sources = new Map(config.sources.map((s) => [s.id, s]));
    this.cacheDir = dataDir === ':memory:' ? null : join(dataDir, 'tiles');
    this.maxAgeMs = config.cacheMaxAgeDays * 86_400_000;
    this.settingsSources = new Map(this.storedSources().map((s) => [s.id, toConfig(s)]));
  }

  list(): MapSource[] {
    return [...this.config.sources, ...this.settingsSources.values(), ...this.addonSources.values()].map(({ id, name, attribution, maxZoom, variant }) => ({
      id,
      name,
      attribution,
      maxZoom,
      ...(variant && { variant }),
    }));
  }

  private storedSources(): MapSourceInput[] {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
    const parsed = r ? mapSourceListSchema.safeParse(JSON.parse(r.value)) : null;
    return parsed?.success ? parsed.data : [];
  }

  /** Alle Quellen mit Herkunft für die Einstellungen */
  settings(): MapSourceSettings {
    const r = this.db.prepare('SELECT updated_at, updated_by FROM settings WHERE key = ?').get(SETTINGS_KEY) as { updated_at: string; updated_by: string } | undefined;
    const entry = (s: MapSourceConfig, origin: 'config' | 'settings' | 'addon') => ({
      id: s.id,
      name: s.name,
      url: s.url,
      attribution: s.attribution,
      maxZoom: s.maxZoom,
      pixelRatio: s.pixelRatio,
      ...(s.variant && { variant: s.variant }),
      cache: s.cache,
      origin,
    });
    return {
      sources: [
        ...this.config.sources.map((s) => entry(s, 'config')),
        ...[...this.settingsSources.values()].map((s) => entry(s, 'settings')),
        ...[...this.addonSources.values()].map((s) => entry(s, 'addon')),
      ],
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.updated_by ?? null,
    };
  }

  /** Speichert die Quellen der Einstellungen; Kacheln geänderter oder entfernter Quellen werden verworfen. */
  async setSettingsSources(input: MapSourceInput[], actor: string): Promise<MapSourceSettings> {
    const parsed = mapSourceListSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    for (const s of parsed.data) {
      if (this.sources.has(s.id) || this.addonSources.has(s.id)) throw new HttpError(400, `Kennung „${s.id}“ ist schon vergeben`);
    }
    const before = this.settingsSources;
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(SETTINGS_KEY, JSON.stringify(parsed.data), new Date().toISOString(), actor);
    this.settingsSources = new Map(parsed.data.map((s) => [s.id, toConfig(s)]));
    if (this.cacheDir) {
      const stale = [...before.values()].filter((s) => this.settingsSources.get(s.id)?.url !== s.url || this.settingsSources.get(s.id)?.pixelRatio !== s.pixelRatio);
      await Promise.all(stale.map((s) => rm(join(this.cacheDir!, s.id), { recursive: true, force: true })));
    }
    return this.settings();
  }

  /** Lädt eine Kachel einer (noch nicht gespeicherten) Quelle ohne Cache, um den Dienst zu prüfen. */
  async test(input: MapSourceInput, at: { lat: number; lon: number }): Promise<MapSourceTestResult> {
    const parsed = mapSourceInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, contentType: null, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    const z = Math.min(14, parsed.data.maxZoom);
    const { x, y } = tileAt(at.lat, at.lon, z);
    try {
      const tile = await this.withSlot(() => this.request(toConfig(parsed.data), z, x, y));
      return { ok: true, contentType: tile.contentType, error: null };
    } catch (err) {
      return { ok: false, contentType: null, error: (err as Error).message };
    }
  }

  /** Kartenquellen laufender Addons (provides.mapSources). Liefert true, wenn sich etwas geändert hat. */
  setAddonSources(sources: MapSourceConfig[]): boolean {
    const key = (list: Iterable<MapSourceConfig>) => JSON.stringify([...list]);
    if (key(sources) === key(this.addonSources.values())) return false;
    this.addonSources = new Map(sources.map((s) => [s.id, s]));
    return true;
  }

  source(id: string): MapSourceConfig {
    const s = this.sources.get(id) ?? this.settingsSources.get(id) ?? this.addonSources.get(id);
    if (!s) throw new HttpError(404, `Unbekannte Kartenquelle ${id}`);
    return s;
  }

  /** Liefert die Kachel oder null, wenn sie weder im Cache noch online verfügbar ist. */
  async get(sourceId: string, z: number, x: number, y: number): Promise<Tile | null> {
    const src = this.source(sourceId);
    const max = 2 ** z;
    if (z < 0 || z > src.maxZoom || y < 0 || y >= max) return null;
    const wx = ((x % max) + max) % max; // Datumsgrenze
    const key = `${sourceId}/${z}/${wx}/${y}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job = this.load(src, z, wx, y, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async load(src: MapSourceConfig, z: number, x: number, y: number, key: string): Promise<Tile | null> {
    const file = this.cacheDir && src.cache ? join(this.cacheDir, key) : null;
    let cached: Tile | null = null;
    if (file) {
      try {
        const [data, info, type] = await Promise.all([readFile(file), stat(file), readFile(`${file}.type`, 'utf8')]);
        cached = { data, contentType: type };
        if (Date.now() - info.mtimeMs < this.maxAgeMs) return cached;
      } catch {
        /* nicht im Cache */
      }
    }

    const fresh = await this.withSlot(() => this.fetchTile(src, z, x, y));
    if (!fresh) return cached; // offline: veralteten Stand verwenden
    if (file) {
      await mkdir(dirname(file), { recursive: true });
      await Promise.all([writeFile(file, fresh.data), writeFile(`${file}.type`, fresh.contentType)]);
    }
    return fresh;
  }

  private async fetchTile(src: MapSourceConfig, z: number, x: number, y: number): Promise<Tile | null> {
    try {
      return await this.request(src, z, x, y);
    } catch {
      return null;
    }
  }

  /** Lädt eine Kachel; wirft mit lesbarer Meldung, wenn der Dienst kein Bild liefert. */
  private async request(src: MapSourceConfig, z: number, x: number, y: number): Promise<Tile> {
    const sub = src.subdomains[(x + y) % src.subdomains.length] ?? '';
    const px = String(256 * src.pixelRatio);
    const url = src.url
      .replace('{s}', sub)
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y))
      .replace('{r}', src.pixelRatio === 2 ? '@2x' : '')
      .replace('{bbox}', tileBbox3857(z, x, y).map((v) => v.toFixed(2)).join(','))
      .replace('{width}', px)
      .replace('{height}', px);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': this.config.userAgent },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      throw new Error(e.name === 'TimeoutError' ? 'Zeitüberschreitung' : `Nicht erreichbar (${(e.cause as Error | undefined)?.message ?? e.message})`);
    }
    const contentType = res.headers.get('content-type') ?? 'image/png';
    if (!res.ok || !contentType.startsWith('image/')) {
      // WMS meldet Fehler als XML (ServiceException) – den Text mitgeben
      const text = (await res.text().catch(() => '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new Error(`${res.ok ? `Kein Bild (${contentType})` : `HTTP ${res.status}`}${text ? `: ${text}` : ''}`);
    }
    return { data: Buffer.from(await res.arrayBuffer()), contentType };
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_PARALLEL_FETCHES) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
