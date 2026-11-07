import { resamplePath, type ElevationProfile, type ProfilePoint } from '@elvis/shared';
import { HttpError } from '../errors.js';

/** GET mit HTTP-Status und JSON-Antwort (Tests ersetzen den Abruf) */
export type ElevationFetch = (url: string, opts: { timeoutMs: number; userAgent: string }) => Promise<{ status: number; json: unknown }>;

const defaultFetch: ElevationFetch = async (url, { timeoutMs, userAgent }) => {
  const res = await fetch(url, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

export interface ElevationOptions {
  /** Open-Meteo Elevation API (Copernicus DEM, 90 m); null = keine Höhendaten */
  url: string | null;
  userAgent: string;
}

/** Open-Meteo nimmt höchstens 100 Koordinaten je Anfrage */
export const ELEVATION_BATCH = 100;
const TIMEOUT_MS = 15_000;
const CACHE_MAX = 50_000;

/**
 * Geländehöhen für den Höhenschnitt der Wasserversorgung. Vorerst online über Open-Meteo; ein lokaler Dienst
 * (SRTM/DGM im Addon OSM-Daten) kann später dieselbe Schnittstelle bedienen.
 */
export class ElevationService {
  private readonly cache = new Map<string, number>();

  constructor(
    private readonly opts: ElevationOptions,
    private readonly fetchJson: ElevationFetch = defaultFetch,
  ) {}

  get available(): boolean {
    return !!this.opts.url;
  }

  /** Höhenschnitt entlang eines Wegs [Länge, Breite], gleichmäßig abgetastet */
  async profile(path: [number, number][]): Promise<ElevationProfile> {
    if (!this.opts.url) throw new HttpError(503, 'Höhendaten nicht verfügbar (abgeschaltet)');
    const samples = resamplePath(path);
    const heights = await this.heights(samples);
    const points: ProfilePoint[] = samples.map((s, i) => ({ ...s, d: Math.round(s.d * 10) / 10, h: heights[i]! }));
    return { points, source: 'Open-Meteo (Copernicus DEM)' };
  }

  private async heights(points: { lat: number; lon: number }[]): Promise<number[]> {
    const key = (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    const missing = [...new Set(points.map(key).filter((k) => !this.cache.has(k)))];
    for (let i = 0; i < missing.length; i += ELEVATION_BATCH) {
      const batch = missing.slice(i, i + ELEVATION_BATCH);
      const lats = batch.map((k) => k.split(',')[0]).join(',');
      const lons = batch.map((k) => k.split(',')[1]).join(',');
      let res: Awaited<ReturnType<ElevationFetch>>;
      try {
        res = await this.fetchJson(`${this.opts.url!.replace(/\/+$/, '')}?latitude=${lats}&longitude=${lons}`, { timeoutMs: TIMEOUT_MS, userAgent: this.opts.userAgent });
      } catch (e) {
        throw new HttpError(503, `Höhendaten nicht verfügbar (offline?): ${(e as Error).message}`);
      }
      const elevation = (res.json as { elevation?: unknown } | null)?.elevation;
      if (res.status !== 200 || !Array.isArray(elevation) || elevation.length !== batch.length) {
        const reason = (res.json as { reason?: string } | null)?.reason;
        throw new HttpError(503, `Höhendaten nicht verfügbar (${reason ?? `HTTP ${res.status}`})`);
      }
      if (this.cache.size + batch.length > CACHE_MAX) this.cache.clear();
      batch.forEach((k, j) => this.cache.set(k, Number(elevation[j]) || 0));
    }
    return points.map((p) => this.cache.get(key(p)) ?? 0);
  }
}
