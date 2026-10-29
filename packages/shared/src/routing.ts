/**
 * Routenplanung auf der Karte: Halte (Objekte, Suchtreffer, eigenes Fahrzeug) in Reihenfolge, berechnet vom lokalen
 * Valhalla des Addons OSM-Daten. Die Route lässt sich als Linie in die Objektliste übernehmen oder mit Abbiegehinweisen
 * drucken.
 */
import { z } from 'zod';

export type RouteProfile = 'auto' | 'truck';

export const ROUTE_PROFILE_LABELS: Record<RouteProfile, string> = { auto: 'PKW', truck: 'LKW' };

/** Höchstzahl der Halte (Start, Zwischenziele, Ziel) */
export const MAX_ROUTE_STOPS = 20;

export const routeStopSchema = z.object({
  lat: z.number().min(-85).max(85),
  lon: z.number().min(-180).max(180),
  name: z.string().trim().max(120),
});
export type RouteStop = z.infer<typeof routeStopSchema>;

export const routeRequestSchema = z.object({
  profile: z.enum(['auto', 'truck']).default('auto'),
  stops: z.array(routeStopSchema).min(2, 'Mindestens Start und Ziel nötig').max(MAX_ROUTE_STOPS),
});
export type RouteRequest = z.infer<typeof routeRequestSchema>;

/** Ein Fahrhinweis („Rechts abbiegen auf Lange Straße“) an der Stelle (lat, lon) */
export interface RouteManeuver {
  /** Valhalla-Manövertyp (1–3 Start, 4–6 Ziel, 9–17 Abbiegen, 26/27 Kreisverkehr …) */
  type: number;
  instruction: string;
  /** Strecke und Fahrzeit bis zum nächsten Hinweis */
  distanceM: number;
  durationS: number;
  street: string | null;
  lat: number;
  lon: number;
  /** Fahrtrichtung vor und nach dem Hinweis in Grad (0 = Norden) */
  bearingBefore: number | null;
  bearingAfter: number | null;
}

export interface RouteResult {
  profile: RouteProfile;
  /** Name des Routing-Diensts, z. B. „Routing (lokal)“ */
  source: string;
  distanceM: number;
  durationS: number;
  /** Streckenverlauf [Länge, Breite] wie GeoJSON */
  path: [number, number][];
  /** Teilstrecken zwischen aufeinanderfolgenden Halten */
  legs: { distanceM: number; durationS: number }[];
  maneuvers: RouteManeuver[];
}

export interface RouterStatus {
  available: boolean;
  name: string | null;
}

const maneuverSchema = z.object({
  type: z.number().int(),
  instruction: z.string().max(400),
  distanceM: z.number().min(0),
  durationS: z.number().min(0),
  street: z.string().max(200).nullable(),
  lat: z.number(),
  lon: z.number(),
  bearingBefore: z.number().nullable(),
  bearingAfter: z.number().nullable(),
});

export const routeResultSchema: z.ZodType<RouteResult> = z.object({
  profile: z.enum(['auto', 'truck']),
  source: z.string().max(120),
  distanceM: z.number().min(0),
  durationS: z.number().min(0),
  path: z.array(z.tuple([z.number(), z.number()])).min(2).max(20_000),
  legs: z.array(z.object({ distanceM: z.number().min(0), durationS: z.number().min(0) })).max(MAX_ROUTE_STOPS),
  maneuvers: z.array(maneuverSchema).max(300),
});

/** Routenausdruck: Übersichtskarte und je Hinweis ein Kartenausschnitt */
export const routePrintSchema = z.object({
  title: z.string().trim().min(1).max(120),
  sourceId: z.string(),
  stops: z.array(routeStopSchema).min(2).max(MAX_ROUTE_STOPS),
  route: routeResultSchema,
});
export type RoutePrintRequest = z.infer<typeof routePrintSchema>;

/** „850 m“, „12,3 km“, „128 km“ */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return `${km.toLocaleString('de-DE', { maximumFractionDigits: km < 100 ? 1 : 0, minimumFractionDigits: km < 100 ? 1 : 0 })} km`;
}

/** „45 s“, „15 min“, „1 h 05 min“ */
export function formatDuration(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Kurzbeschreibung für die Objektliste: „12,3 km · 15 min · LKW“ */
export function routeSummary(r: Pick<RouteResult, 'distanceM' | 'durationS' | 'profile'>): string {
  return `${formatDistance(r.distanceM)} · ${formatDuration(r.durationS)} · ${ROUTE_PROFILE_LABELS[r.profile]}`;
}
