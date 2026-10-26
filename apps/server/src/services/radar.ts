import { RADAR_HISTORY_MS, type RadarFrames } from '@elvis/shared';
import { HttpError } from '../errors.js';
import { tileBbox3857, type Tile } from './tiles.js';

export interface RadarOptions {
  /** WMS-Endpunkt (GeoServer); null = Regenradar aus */
  wmsUrl: string | null;
  layer: string;
  attribution: string;
  userAgent: string;
}

export interface RadarResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export type RadarFetch = (url: string, opts: { timeoutMs: number; userAgent: string }) => Promise<RadarResponse>;

const defaultFetch: RadarFetch = async (url, { timeoutMs, userAgent }) => {
  const res = await fetch(url, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) };
};

const FETCH_TIMEOUT_MS = 15_000;
/** Der DWD rechnet alle 5 Minuten neu; öfter als jede Minute lohnt kein Nachsehen */
const FRAMES_TTL_MS = 60_000;
const STEP_MS = 5 * 60_000;
const MAX_TILES = 2000;
const MAX_PARALLEL_FETCHES = 4;
/** Das 1-km-Raster des DWD gibt mehr Details nicht her; die Karte vergrößert darüber */
export const RADAR_MAX_ZOOM = 10;

interface TimeAxis {
  start: number;
  end: number;
  stepMs: number;
  reference: number;
}

/** ISO-8601-Dauer wie PT5M oder PT1H in Millisekunden */
function durationMs(iso: string): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso.trim());
  if (!m || (!m[1] && !m[2])) return null;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
}

/** Zeitachse der Ebene aus den Capabilities: <Dimension name="time">start/ende/PT5M</Dimension> und REFERENCE_TIME */
export function parseRadarCapabilities(xml: string): TimeAxis {
  const time = /<Dimension[^>]*name="time"[^>]*>([^<]+)<\/Dimension>/i.exec(xml)?.[1]?.trim();
  if (!time) throw new Error('Keine Zeitachse in den Capabilities');
  // Entweder Intervall „start/ende/schritt“ oder Liste einzelner Zeitpunkte
  const parts = time.split('/');
  let start: number;
  let end: number;
  let stepMs = STEP_MS;
  if (parts.length === 3) {
    start = Date.parse(parts[0]!);
    end = Date.parse(parts[1]!);
    stepMs = durationMs(parts[2]!) ?? STEP_MS;
  } else {
    const list = time.split(',').map((t) => Date.parse(t.trim()));
    start = list[0]!;
    end = list[list.length - 1]!;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Zeitachse nicht lesbar: ${time.slice(0, 80)}`);
  const ref = /<Dimension[^>]*name="REFERENCE_TIME"[^>]*default="([^"]+)"/i.exec(xml)?.[1];
  const reference = ref ? Date.parse(ref) : NaN;
  return { start, end, stepMs, reference: Number.isFinite(reference) ? Math.min(reference, end) : end };
}

/** Zeitschritte von RADAR_HISTORY_MS vor der letzten Messung bis zum Ende der Vorhersage */
export function radarFrames(axis: TimeAxis): string[] {
  const frames: string[] = [];
  const first = Math.max(axis.start, axis.reference - RADAR_HISTORY_MS);
  // Auf das Raster der Achse ausrichten
  const from = axis.start + Math.ceil((first - axis.start) / axis.stepMs) * axis.stepMs;
  for (let t = from; t <= axis.end; t += axis.stepMs) frames.push(new Date(t).toISOString());
  return frames;
}

/**
 * Regenradar des DWD (WMS mit Zeitachse: Messung und zwei Stunden Vorhersage) als Kachel-Proxy.
 * Kacheln bleiben im Speicher; Vorhersagekacheln gelten nur bis zur nächsten Messung.
 */
export class RadarService {
  private axis: { value: TimeAxis; at: number } | null = null;
  private axisJob: Promise<TimeAxis> | null = null;
  private readonly tiles = new Map<string, Tile>();
  private readonly inflight = new Map<string, Promise<Tile | null>>();
  private legendTile: Tile | null = null;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly opts: RadarOptions,
    private readonly fetchRaw: RadarFetch = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {}

  private get wmsUrl(): string {
    if (!this.opts.wmsUrl) throw new HttpError(404, 'Regenradar ist abgeschaltet');
    return this.opts.wmsUrl;
  }

  /** GeoServer liefert die Capabilities einer einzelnen Ebene unter <workspace>/<ebene>/ows – klein statt ~1 MB */
  private capabilitiesUrl(): string {
    const base = this.wmsUrl.replace(/\/(wms|ows)\/?$/, '');
    return `${base}/${encodeURIComponent(this.opts.layer)}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
  }

  private async loadAxis(): Promise<TimeAxis> {
    if (this.axis && this.now() - this.axis.at < FRAMES_TTL_MS) return this.axis.value;
    const url = this.capabilitiesUrl();
    this.axisJob ??= (async () => {
      try {
        const res = await this.request(url);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const value = parseRadarCapabilities(res.body.toString('utf8'));
        if (this.axis && this.axis.value.reference !== value.reference) this.dropForecasts();
        this.axis = { value, at: this.now() };
        return value;
      } catch (err) {
        // offline: letzten bekannten Stand weiter verwenden
        if (this.axis) return this.axis.value;
        throw new HttpError(503, `Regenradar nicht erreichbar (${(err as Error).message})`);
      } finally {
        this.axisJob = null;
      }
    })();
    return this.axisJob;
  }

  async frames(): Promise<RadarFrames> {
    const axis = await this.loadAxis();
    return { reference: new Date(axis.reference).toISOString(), frames: radarFrames(axis), attribution: this.opts.attribution };
  }

  /** Vorhersagekacheln, deren Zeit nach der letzten Messung liegt, verwerfen (neuer Nowcast) */
  private dropForecasts(): void {
    for (const key of this.tiles.keys()) if (key.startsWith('f/')) this.tiles.delete(key);
  }

  /** true für Messungen: diese Kacheln ändern sich nicht mehr */
  async isMeasured(time: string): Promise<boolean> {
    return Date.parse(time) <= (await this.loadAxis()).reference;
  }

  /** Liefert die Kachel oder null, wenn der DWD nicht erreichbar ist; Zeiten außerhalb der Achse ergeben 404. */
  async tile(time: string, z: number, x: number, y: number): Promise<Tile | null> {
    const axis = await this.loadAxis();
    const t = Date.parse(time);
    // Nur Zeitpunkte auf dem Raster der Achse (sonst antwortet der WMS mit einem Fehler) – kein offener Proxy
    if (!Number.isFinite(t) || t < axis.reference - RADAR_HISTORY_MS - 30 * 60_000 || t > axis.end || (t - axis.start) % axis.stepMs !== 0) {
      throw new HttpError(404, 'Unbekannter Radar-Zeitpunkt');
    }
    const max = 2 ** z;
    if (z < 0 || z > RADAR_MAX_ZOOM || y < 0 || y >= max) throw new HttpError(404, 'Kachel nicht verfügbar');
    const wx = ((x % max) + max) % max;
    const iso = new Date(t).toISOString();
    const key = `${t > axis.reference ? 'f' : 'm'}/${iso}/${z}/${wx}/${y}`;
    const hit = this.tiles.get(key);
    if (hit) {
      // zuletzt benutzt ans Ende (LRU)
      this.tiles.delete(key);
      this.tiles.set(key, hit);
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job = this.withSlot(() => this.fetchTile(iso, z, wx, y))
      .then((tile) => {
        if (tile) {
          this.tiles.set(key, tile);
          if (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!);
        }
        return tile;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async fetchTile(time: string, z: number, x: number, y: number): Promise<Tile | null> {
    const q = new URLSearchParams({
      service: 'WMS',
      version: '1.3.0',
      request: 'GetMap',
      layers: this.opts.layer,
      styles: '',
      format: 'image/png',
      transparent: 'true',
      crs: 'EPSG:3857',
      width: '256',
      height: '256',
      bbox: tileBbox3857(z, x, y).map((v) => v.toFixed(2)).join(','),
      time,
    });
    return this.image(`${this.wmsUrl}?${q}`);
  }

  async legend(): Promise<Tile | null> {
    if (this.legendTile) return this.legendTile;
    const q = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetLegendGraphic', format: 'image/png', width: '20', height: '20', layer: this.opts.layer });
    this.legendTile = await this.image(`${this.wmsUrl}?${q}`);
    return this.legendTile;
  }

  /** Bild laden; WMS meldet Fehler als XML mit Status 200 – das zählt als nicht verfügbar */
  private async image(url: string): Promise<Tile | null> {
    try {
      const res = await this.request(url);
      if (res.status !== 200 || !res.contentType.startsWith('image/')) return null;
      return { data: res.body, contentType: res.contentType };
    } catch {
      return null;
    }
  }

  private request(url: string): Promise<RadarResponse> {
    return this.fetchRaw(url, { timeoutMs: FETCH_TIMEOUT_MS, userAgent: this.opts.userAgent });
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
