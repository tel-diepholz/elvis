import type { RouteManeuver, RouteRequest, RouteResult, RouterStatus } from '@elvis/shared';
import { HttpError } from '../errors.js';

/** Routing-Dienst eines Addons (OSM-Daten: Valhalla) */
export interface RouterProvision {
  id: string;
  name: string;
  type: 'valhalla';
  /** Basisadresse; die Anfrage geht an <url>/route */
  url: string;
}

/** Antwort mit HTTP-Status; Valhalla meldet „keine Route“ als 400 mit JSON-Fehler */
export type RouterFetch = (url: string, body: unknown, opts: { timeoutMs: number }) => Promise<{ status: number; json: unknown }>;

const defaultFetch: RouterFetch = async (url, body, { timeoutMs }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const TIMEOUT_MS = 30_000;

/** Valhalla-Fehlercodes, bei denen keine Route existiert (statt Dienstausfall) */
const NO_ROUTE = new Set([170, 171, 442, 443]);

interface ValhallaManeuver {
  type: number;
  instruction: string;
  street_names?: string[];
  length: number;
  time: number;
  begin_shape_index: number;
  bearing_before?: number;
  bearing_after?: number;
}

interface ValhallaLeg {
  shape: string;
  summary: { length: number; time: number };
  maneuvers: ValhallaManeuver[];
}

interface ValhallaRoute {
  trip?: { summary: { length: number; time: number }; legs: ValhallaLeg[] };
  error_code?: number;
  error?: string;
}

/** Valhalla-Polyline mit 6 Nachkommastellen → [Länge, Breite] */
export function decodePolyline6(s: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

/** Routen über den lokalen Valhalla-Dienst des Addons OSM-Daten; ohne Addon gibt es kein Routing. */
export class RouterService {
  private providers: RouterProvision[] = [];

  constructor(private readonly fetchJson: RouterFetch = defaultFetch) {}

  /** Routing-Dienste laufender Addons; liefert true bei Änderung */
  setProvisions(list: RouterProvision[]): boolean {
    if (JSON.stringify(list) === JSON.stringify(this.providers)) return false;
    this.providers = list;
    return true;
  }

  status(): RouterStatus {
    const p = this.providers[0];
    return { available: !!p, name: p?.name ?? null };
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    if (!this.providers.length) throw new HttpError(503, 'Routing nicht verfügbar – Addon „OSM-Daten“ installieren');
    const body = {
      locations: req.stops.map((s) => ({ lat: s.lat, lon: s.lon, type: 'break' })),
      costing: req.profile,
      directions_options: { language: 'de-DE', units: 'kilometers' },
    };
    const errors: string[] = [];
    for (const p of this.providers) {
      let res: Awaited<ReturnType<RouterFetch>>;
      try {
        res = await this.fetchJson(`${p.url.replace(/\/+$/, '')}/route`, body, { timeoutMs: TIMEOUT_MS });
      } catch (e) {
        errors.push(`${p.name}: ${(e as Error).message}`);
        continue;
      }
      const data = (res.json ?? {}) as ValhallaRoute;
      if (data.error_code !== undefined && NO_ROUTE.has(data.error_code)) {
        throw new HttpError(422, data.error_code === 171 || data.error_code === 170 ? 'Ein Halt liegt zu weit von einer befahrbaren Straße entfernt' : 'Keine Route zwischen den Halten gefunden');
      }
      if (res.status !== 200 || !data.trip) {
        errors.push(`${p.name}: ${data.error ?? `HTTP ${res.status}`}`);
        continue;
      }
      return toResult(data.trip, req.profile, p.name);
    }
    throw new HttpError(502, `Routing fehlgeschlagen (${errors.join('; ')})`);
  }
}

function toResult(trip: NonNullable<ValhallaRoute['trip']>, profile: RouteRequest['profile'], source: string): RouteResult {
  const path: [number, number][] = [];
  const maneuvers: RouteManeuver[] = [];
  for (const leg of trip.legs) {
    const shape = decodePolyline6(leg.shape);
    for (const m of leg.maneuvers) {
      const [lon, lat] = shape[Math.min(m.begin_shape_index, shape.length - 1)] ?? [0, 0];
      maneuvers.push({
        type: m.type,
        instruction: m.instruction,
        distanceM: Math.round(m.length * 1000),
        durationS: Math.round(m.time),
        street: m.street_names?.join(', ') || null,
        lat,
        lon,
        bearingBefore: m.bearing_before ?? null,
        bearingAfter: m.bearing_after ?? null,
      });
    }
    // Teilstrecken stoßen am Halt aneinander: den doppelten Punkt nur einmal übernehmen
    path.push(...(path.length ? shape.slice(1) : shape));
  }
  return {
    profile,
    source,
    distanceM: Math.round(trip.summary.length * 1000),
    durationS: Math.round(trip.summary.time),
    path,
    legs: trip.legs.map((l) => ({ distanceM: Math.round(l.summary.length * 1000), durationS: Math.round(l.summary.time) })),
    maneuvers,
  };
}
