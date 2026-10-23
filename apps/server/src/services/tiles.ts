import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MapSource } from '@elvis/shared';
import type { ElvisConfig, MapSourceConfig } from '../config.js';
import { HttpError } from '../errors.js';

export interface Tile {
  data: Buffer;
  contentType: string;
}

const MAX_PARALLEL_FETCHES = 4;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Kachel-Proxy mit Festplatten-Cache: Einmal geladene Kacheln stehen offline zur Verfügung,
 * und der Server meldet sich mit eigenem User-Agent (Tile-Usage-Policy von OSM).
 */
export class TileService {
  private readonly sources: Map<string, MapSourceConfig>;
  private addonSources = new Map<string, MapSourceConfig>();
  private readonly cacheDir: string | null;
  private readonly maxAgeMs: number;
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<Tile | null>>();

  constructor(
    private readonly config: ElvisConfig['map'],
    dataDir: string,
  ) {
    this.sources = new Map(config.sources.map((s) => [s.id, s]));
    this.cacheDir = dataDir === ':memory:' ? null : join(dataDir, 'tiles');
    this.maxAgeMs = config.cacheMaxAgeDays * 86_400_000;
  }

  list(): MapSource[] {
    return [...this.config.sources, ...this.addonSources.values()].map(({ id, name, attribution, maxZoom, variant }) => ({ id, name, attribution, maxZoom, ...(variant && { variant }) }));
  }

  /** Kartenquellen laufender Addons (provides.mapSources). Liefert true, wenn sich etwas geändert hat. */
  setAddonSources(sources: MapSourceConfig[]): boolean {
    const key = (list: Iterable<MapSourceConfig>) => JSON.stringify([...list]);
    if (key(sources) === key(this.addonSources.values())) return false;
    this.addonSources = new Map(sources.map((s) => [s.id, s]));
    return true;
  }

  source(id: string): MapSourceConfig {
    const s = this.sources.get(id) ?? this.addonSources.get(id);
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
    const sub = src.subdomains[(x + y) % src.subdomains.length] ?? '';
    const url = src.url
      .replace('{s}', sub)
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y))
      .replace('{r}', src.pixelRatio === 2 ? '@2x' : '');
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': this.config.userAgent },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') ?? 'image/png';
      if (!contentType.startsWith('image/')) return null;
      return { data: Buffer.from(await res.arrayBuffer()), contentType };
    } catch {
      return null;
    }
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
