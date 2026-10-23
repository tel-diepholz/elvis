import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCoordinates, toMgrs, type GeoOutline, type GeocodeKind, type GeocodeResponse, type GeocodeResult } from '@elvis/shared';

/** Suchdienst eines Addons: Photon (https://github.com/komoot/photon) oder Nominatim (https://nominatim.org) */
export interface GeocoderProvision {
  id: string;
  name: string;
  type: 'photon' | 'nominatim';
  url: string;
}

export interface GeocoderOptions {
  /** Öffentlicher Photon-Dienst als Rückfall für die Suche, null = nur lokal */
  onlineUrl: string | null;
  /** Öffentlicher Nominatim-Dienst als Rückfall für Umrisse, null = nur lokal */
  outlineUrl?: string | null;
  /** Ablage geladener Umrisse; ohne Angabe nur im Speicher */
  dataDir?: string;
  userAgent: string;
}

export interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_type?: string;
    osm_id?: number;
    type?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    locality?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    /** [West, Nord, Ost, Süd] */
    extent?: [number, number, number, number];
  };
}

/** Treffer von Nominatim (format=jsonv2, addressdetails=1) */
export interface NominatimPlace {
  osm_type?: 'node' | 'way' | 'relation';
  osm_id?: number;
  lat?: string;
  lon?: string;
  category?: string;
  addresstype?: string;
  place_rank?: number;
  name?: string;
  /** [Süd, Nord, West, Ost] */
  boundingbox?: [string, string, string, string];
  address?: Record<string, string>;
}

export type GeocodeFetch = (url: string, opts: { timeoutMs: number; userAgent: string }) => Promise<unknown>;

const defaultFetch: GeocodeFetch = async (url, { timeoutMs, userAgent }) => {
  const res = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const KINDS: GeocodeKind[] = ['house', 'street', 'locality', 'district', 'city', 'county', 'state', 'country', 'other'];
const LIMIT = 8;
const CACHE_MAX = 500;
const CACHE_MS = 24 * 3600_000;
/** Abstand zwischen zwei Anfragen an den öffentlichen Suchdienst (Fair Use) */
const ONLINE_GAP_MS = 250;
/** Öffentliches Nominatim: höchstens eine Anfrage je Sekunde (Nutzungsbedingungen) */
const OUTLINE_GAP_MS = 1_100;
/** Gespeicherte Umrisse gelten 90 Tage, danach wird – falls möglich – neu geladen */
const OUTLINE_MAX_AGE_MS = 90 * 24 * 3600_000;
/** Linien auf etwa 5 m vereinfachen (Grad) – reicht für die Karte und hält die Antworten klein */
const OUTLINE_THRESHOLD = 0.00005;

const OSM_PREFIX: Record<string, string> = { node: 'N', way: 'W', relation: 'R', N: 'N', W: 'W', R: 'R' };

const detailLine = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');

/** Photon-Treffer → Ergebnis mit Haupt- und Detailzeile */
export function toResult(f: PhotonFeature): GeocodeResult | null {
  const p = f.properties ?? {};
  const [lon, lat] = f.geometry?.coordinates ?? [];
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const kind = KINDS.includes(p.type as GeocodeKind) ? (p.type as GeocodeKind) : 'other';
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name = p.name ?? (street || p.city || p.county || '');
  if (!name) return null;
  const place = [p.postcode, p.city].filter(Boolean).join(' ');
  const detail = detailLine([
    p.name && street && street !== p.name && street,
    place && place !== name && place,
    p.district && p.district !== p.city && p.district !== name && p.district,
    p.county && p.county !== name && p.county,
    p.countrycode && p.countrycode !== 'DE' && p.country,
  ]);
  const e = p.extent;
  const prefix = OSM_PREFIX[p.osm_type ?? ''];
  return {
    id: `${p.osm_type ?? 'X'}${p.osm_id ?? `${lat},${lon}`}`,
    kind,
    name,
    detail,
    lat,
    lon,
    bounds: e ? [[Math.min(e[1], e[3]), Math.min(e[0], e[2])], [Math.max(e[1], e[3]), Math.max(e[0], e[2])]] : null,
    osm: prefix && p.osm_id ? `${prefix}${p.osm_id}` : null,
  };
}

const CITY_TYPES = ['city', 'town', 'village', 'municipality'];
const DISTRICT_TYPES = ['suburb', 'quarter', 'city_district', 'borough', 'neighbourhood'];
const LOCALITY_TYPES = ['hamlet', 'isolated_dwelling', 'farm', 'locality', 'allotments'];

function nominatimKind(r: NominatimPlace): GeocodeKind {
  const t = r.addresstype ?? '';
  if (CITY_TYPES.includes(t)) return 'city';
  if (DISTRICT_TYPES.includes(t)) return 'district';
  if (LOCALITY_TYPES.includes(t)) return 'locality';
  if (t === 'county' || t === 'state' || t === 'country') return t;
  const rank = r.place_rank ?? 0;
  if (r.category === 'highway' || t === 'road' || rank === 26 || rank === 27) return 'street';
  if (rank >= 28) return 'house';
  return 'other';
}

/** Nominatim-Treffer → Ergebnis mit Haupt- und Detailzeile */
export function nominatimResult(r: NominatimPlace): GeocodeResult | null {
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const a = r.address ?? {};
  const kind = nominatimKind(r);
  const street = [a.road, a.house_number].filter(Boolean).join(' ');
  const name = r.name || street || '';
  if (!name) return null;
  const town = a.city ?? a.town ?? a.village ?? a.municipality;
  const place = [a.postcode, town].filter(Boolean).join(' ');
  const quarter = a.suburb ?? a.quarter ?? a.hamlet ?? a.city_district;
  const detail = detailLine([
    street && street !== name && street,
    place && place !== name && place,
    quarter && quarter !== town && quarter !== name && quarter,
    a.county && a.county !== name && a.county,
    a.country_code && a.country_code !== 'de' && a.country,
  ]);
  const b = r.boundingbox?.map(Number);
  const prefix = OSM_PREFIX[r.osm_type ?? ''];
  return {
    id: `${prefix ?? 'X'}${r.osm_id ?? `${lat},${lon}`}`,
    kind,
    name,
    detail,
    lat,
    lon,
    bounds: b && b.every(Number.isFinite) ? [[b[0]!, b[2]!], [b[1]!, b[3]!]] : null,
    osm: prefix && r.osm_id ? `${prefix}${r.osm_id}` : null,
  };
}

/** Ein Umriss aus einer Nominatim-Antwort (format=geojson, polygon_geojson=1) */
function outlineOf(json: unknown): GeoOutline | null {
  const g = (json as { features?: { geometry?: GeoOutline }[] })?.features?.[0]?.geometry;
  return g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates) ? g : null;
}

/** Nacheinander mit Mindestabstand – für öffentliche Dienste mit Nutzungsbedingungen */
class Throttle {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly gapMs: number,
    private readonly now: () => number,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const wait = this.last + this.gapMs - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = this.now();
      return task();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/**
 * Ortssuche: erkennt Koordinaten selbst und fragt sonst die Suchdienste – zuerst lokale aus Addons (offline),
 * dann den öffentlichen. Findet ein lokaler Dienst nichts, darf der öffentliche es versuchen (Nominatim findet
 * halb getippte Wörter oft nicht). Online-Treffer bleiben einen Tag im Speicher und helfen auch bei Ausfällen.
 * Umrisse von Orten kommen von Nominatim (lokal, sonst öffentlich) und bleiben im Datenverzeichnis.
 */
export class GeocoderService {
  private providers: GeocoderProvision[] = [];
  private readonly cache = new Map<string, { at: number; results: GeocodeResult[]; source: string }>();
  private readonly online: Throttle;
  private readonly outlineOnline: Throttle;
  private readonly outlineDir: string | null;

  constructor(
    private readonly opts: GeocoderOptions,
    private readonly fetchJson: GeocodeFetch = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {
    this.online = new Throttle(ONLINE_GAP_MS, now);
    this.outlineOnline = new Throttle(OUTLINE_GAP_MS, now);
    this.outlineDir = opts.dataDir ? join(opts.dataDir, 'outlines') : null;
  }

  /** Suchdienste laufender Addons; liefert true bei Änderung */
  setProvisions(list: GeocoderProvision[]): boolean {
    if (JSON.stringify(list) === JSON.stringify(this.providers)) return false;
    this.providers = list;
    this.cache.clear(); // lokale Daten haben Vorrang vor zwischengespeicherten Online-Treffern
    return true;
  }

  async search(q: string, focus: { lat: number; lon: number } | null): Promise<GeocodeResponse> {
    const query = q.trim();
    const coord = parseCoordinates(query);
    if (coord) {
      const mgrs = toMgrs(coord.lat, coord.lon);
      const result: GeocodeResult = {
        id: `coord:${coord.lat.toFixed(6)},${coord.lon.toFixed(6)}`,
        kind: 'coordinate',
        name: `${coord.lat.toFixed(5)}, ${coord.lon.toFixed(5)}`,
        detail: coord.format === 'UTMREF' ? `UTMREF ${mgrs}` : `${coord.format} · UTMREF ${mgrs}`,
        lat: coord.lat,
        lon: coord.lon,
        bounds: null,
        osm: null,
      };
      return { results: [result], source: null, problem: null };
    }
    if (query.length < 2) return { results: [], source: null, problem: null };

    const errors: string[] = [];
    let emptyFrom: string | null = null;
    for (const p of this.providers) {
      try {
        const results = await this.ask(p.type, p.url, query, focus, 3_000);
        if (results.length) return { results, source: p.name, problem: null };
        emptyFrom ??= p.name;
      } catch (e) {
        errors.push(`${p.name}: ${(e as Error).message}`);
      }
    }

    if (this.opts.onlineUrl) {
      const source = new URL(this.opts.onlineUrl).host;
      // Kartenmitte auf ~1 km runden, damit kleine Verschiebungen den Cache treffen
      const key = `${query.toLowerCase()}|${focus ? `${focus.lat.toFixed(2)},${focus.lon.toFixed(2)}` : ''}`;
      const hit = this.cache.get(key);
      if (hit && this.now() - hit.at < CACHE_MS) return { results: hit.results, source: hit.source, problem: null };
      try {
        const results = await this.online.run(() => this.ask('photon', this.opts.onlineUrl!, query, focus, 5_000));
        this.remember(key, results, source);
        return { results, source, problem: null };
      } catch (e) {
        errors.push(`${source}: ${(e as Error).message}`);
        // Offline: lieber ältere Treffer als keine
        if (hit) return { results: hit.results, source: `${hit.source} (zwischengespeichert)`, problem: null };
      }
    }

    // Ein lokaler Dienst hat geantwortet, nur ohne Treffer – das ist kein Ausfall
    if (emptyFrom) return { results: [], source: emptyFrom, problem: null };
    const problem = errors.length
      ? `Ortssuche nicht erreichbar (${errors.join('; ')}). Koordinaten und UTMREF funktionieren trotzdem.`
      : 'Keine Ortssuche eingerichtet. Koordinaten und UTMREF funktionieren trotzdem.';
    return { results: [], source: null, problem };
  }

  /**
   * Umriss eines Orts oder Gebiets (OSM-Relation „R…“ oder -Weg „W…“): gespeichert, vom lokalen Nominatim oder
   * vom öffentlichen; null, wenn es keinen gibt oder kein Dienst erreichbar ist.
   */
  async outline(osm: string): Promise<GeoOutline | null> {
    if (!/^[RW]\d{1,12}$/.test(osm)) return null;
    const saved = this.savedOutline(osm);
    if (saved && this.now() - saved.at < OUTLINE_MAX_AGE_MS) return saved.outline;

    const lookup = (base: string) => `${base.replace(/\/+$/, '')}/lookup?osm_ids=${osm}&format=geojson&polygon_geojson=1&polygon_threshold=${OUTLINE_THRESHOLD}`;
    const sources = [
      ...this.providers.filter((p) => p.type === 'nominatim').map((p) => () => this.fetchJson(lookup(p.url), { timeoutMs: 5_000, userAgent: this.opts.userAgent })),
      ...(this.opts.outlineUrl ? [() => this.outlineOnline.run(() => this.fetchJson(lookup(this.opts.outlineUrl!), { timeoutMs: 8_000, userAgent: this.opts.userAgent }))] : []),
    ];
    for (const source of sources) {
      try {
        const outline = outlineOf(await source());
        if (outline) {
          this.saveOutline(osm, outline);
          return outline;
        }
      } catch {
        // nächster Dienst
      }
    }
    return saved?.outline ?? null; // veraltet ist besser als nichts
  }

  private async ask(type: GeocoderProvision['type'], url: string, query: string, focus: { lat: number; lon: number } | null, timeoutMs: number): Promise<GeocodeResult[]> {
    const base = url.replace(/\/+$/, '');
    if (type === 'nominatim') {
      const params = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: String(LIMIT), 'accept-language': 'de' });
      // Treffer in der Nähe bevorzugen: Suchfenster von etwa 40 × 40 km, ohne andere auszuschließen
      if (focus) params.set('viewbox', [focus.lon - 0.3, focus.lat + 0.18, focus.lon + 0.3, focus.lat - 0.18].map((v) => v.toFixed(4)).join(','));
      const json = await this.fetchJson(`${base}/search?${params}`, { timeoutMs, userAgent: this.opts.userAgent });
      return this.dedupe((Array.isArray(json) ? (json as NominatimPlace[]) : []).map(nominatimResult));
    }
    const params = new URLSearchParams({ q: query, limit: String(LIMIT), lang: 'de' });
    // Treffer in der Nähe bevorzugen (Kartenmitte bzw. Fahrzeug). Photons Vorgaben (zoom 12, Gewichtung 0,4) bringen
    // die Straße im Nachbarort nach vorn, ohne bekannte Orte zu verdrängen; schwächer (zoom 10) verliert die Nähe,
    // stärker (Gewichtung 0,2) findet „München“ von Niedersachsen aus nicht mehr als Stadt.
    if (focus) {
      params.set('lat', focus.lat.toFixed(4));
      params.set('lon', focus.lon.toFixed(4));
      params.set('zoom', '12');
    }
    const json = (await this.fetchJson(`${base}/api?${params}`, { timeoutMs, userAgent: this.opts.userAgent })) as { features?: PhotonFeature[] };
    return this.dedupe((json?.features ?? []).map(toResult));
  }

  /** Gleiche Straße in Abschnitten (mehrere OSM-Wege) nur einmal zeigen */
  private dedupe(list: (GeocodeResult | null)[]): GeocodeResult[] {
    const seen = new Set<string>();
    const out: GeocodeResult[] = [];
    for (const r of list) {
      const key = `${r?.kind}|${r?.name}|${r?.detail}`;
      if (!r || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  private remember(key: string, results: GeocodeResult[], source: string): void {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), results, source });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
  }

  private savedOutline(osm: string): { at: number; outline: GeoOutline } | null {
    if (!this.outlineDir) return null;
    try {
      const file = join(this.outlineDir, `${osm}.json`);
      return { at: statSync(file).mtimeMs, outline: JSON.parse(readFileSync(file, 'utf8')) as GeoOutline };
    } catch {
      return null;
    }
  }

  private saveOutline(osm: string, outline: GeoOutline): void {
    if (!this.outlineDir) return;
    mkdirSync(this.outlineDir, { recursive: true });
    writeFileSync(join(this.outlineDir, `${osm}.json`), JSON.stringify(outline));
  }
}
