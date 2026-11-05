/**
 * Wasserversorgung über lange Wegstrecke: nächste Wasserentnahmestellen zum Einsatzort (Objektbibliothek, Typ
 * „Wasserentnahmestelle“), Schlauchweg zu Fuß über das lokale Valhalla, Höhenschnitt und Druckverlauf mit Vorschlag
 * für Verstärkerpumpen. Die Hydraulik ist bewusst einfach gehalten (Faustformeln der Feuerwehr-Ausbildung):
 *
 * - Reibungsverlust je 100 m Schlauch: Δp = k · Q² (Q in l/min), k je Schlauchgröße aus Tabellenwerten
 * - Höhenverlust: 1 bar je 10 m Steigung (Gefälle bringt entsprechend Druck)
 */
import { z } from 'zod';
import { distanceM } from './applink';
import type { LibraryObject } from './library';

/** Höchstzahl der Entnahmestellen, die geroutet werden */
export const WATER_SUPPLY_MAX_COUNT = 10;
export const WATER_SUPPLY_DEFAULT_COUNT = 5;
/** Weiter entfernte Entnahmestellen (Luftlinie) kommen für eine Förderstrecke nicht infrage */
export const WATER_SUPPLY_MAX_RADIUS_M = 10_000;

export const waterSupplyRequestSchema = z.object({
  lat: z.number().min(-85).max(85),
  lon: z.number().min(-180).max(180),
  count: z.number().int().min(1).max(WATER_SUPPLY_MAX_COUNT).default(WATER_SUPPLY_DEFAULT_COUNT),
});
export type WaterSupplyRequest = z.input<typeof waterSupplyRequestSchema>;

export interface WaterSupplyRoute {
  distanceM: number;
  /** Weg von der Entnahmestelle zum Einsatzort, [Länge, Breite] wie GeoJSON */
  path: [number, number][];
}

export interface WaterSupplyCandidate {
  object: LibraryObject;
  /** Luftlinie zum Einsatzort */
  airDistanceM: number;
  /** null, wenn keine Route gefunden wurde (dann steht der Grund in `error`) */
  route: WaterSupplyRoute | null;
  error: string | null;
}

export interface WaterSupplyResult {
  candidates: WaterSupplyCandidate[];
  /** Name des Routing-Diensts */
  source: string | null;
}

/** Höchstzahl der Punkte eines Wegs für den Höhenschnitt */
export const ELEVATION_MAX_PATH_POINTS = 20_000;
/** Abstand der Stützpunkte im Höhenschnitt */
export const ELEVATION_STEP_M = 20;
/** Höchstzahl der Stützpunkte (bei langen Wegen wird der Abstand größer) */
export const ELEVATION_MAX_SAMPLES = 1000;

export const elevationRequestSchema = z.object({
  path: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-85).max(85)])).min(2).max(ELEVATION_MAX_PATH_POINTS),
});
export type ElevationRequest = z.infer<typeof elevationRequestSchema>;

/** Stützpunkt eines Wegs: Strecke ab Start (m), Höhe über NN (m) */
export interface ProfilePoint {
  d: number;
  h: number;
  lat: number;
  lon: number;
}

export interface ElevationProfile {
  points: ProfilePoint[];
  /** Herkunft der Höhen, z. B. „Open-Meteo (Copernicus DEM)“ */
  source: string;
}

/** Ausdruck der Wasserversorgung (PDF): der Server rechnet Druckverlauf und Pumpen aus diesen Angaben nach */
export const waterSupplyPrintSchema = z.object({
  title: z.string().trim().min(1).max(120),
  sourceId: z.string(),
  incident: z.object({ lat: z.number().min(-85).max(85), lon: z.number().min(-180).max(180), name: z.string().max(200) }),
  water: z.object({ name: z.string().max(120), info: z.string().max(300), address: z.string().max(200), lat: z.number().min(-85).max(85), lon: z.number().min(-180).max(180) }),
  routeSource: z.string().max(120),
  path: z.array(z.tuple([z.number(), z.number()])).min(2).max(ELEVATION_MAX_PATH_POINTS),
  profile: z.array(z.object({ d: z.number().min(0), h: z.number(), lat: z.number(), lon: z.number() })).min(2).max(ELEVATION_MAX_SAMPLES + 10),
  /** Herkunft der Höhen; null = ohne Höhendaten gerechnet */
  elevationSource: z.string().max(120).nullable(),
  hydraulics: z.object({
    hose: z.enum(['B', 'A', 'F']),
    flowLpm: z.number().min(1).max(20_000),
    pumpOutBar: z.number().min(0).max(30),
    minInBar: z.number().min(0).max(20),
    endBar: z.number().min(0).max(20),
  }),
  pumpDs: z.array(z.number().min(0)).max(40),
});
export type WaterSupplyPrintRequest = z.infer<typeof waterSupplyPrintSchema>;

// --- Schläuche und Drücke ---

export type HoseType = 'B' | 'A' | 'F';

export interface HoseSpec {
  label: string;
  /** Reibungsbeiwert: Δp [bar/100 m] = k · Q² mit Q in l/min */
  k: number;
  /** Länge eines Schlauchs in m */
  lengthM: number;
  /** übliche Fördermenge als Vorgabe beim Umschalten */
  defaultFlowLpm: number;
}

/**
 * Tabellenwerte (Feuerwehr-Ausbildung, Druckverlust je 100 m Druckschlauch):
 * B 75: 800 l/min ≈ 1,0 bar · A 110: 800 l/min ≈ 0,17 bar · F 150: 2000 l/min ≈ 0,25 bar.
 * Daraus k = Δp / Q². Abweichungen durch Schlauchzustand, Knicke und Armaturen deckt der Mindesteingangsdruck ab.
 */
export const HOSE_TYPES: Record<HoseType, HoseSpec> = {
  B: { label: 'B-Schlauch (75 mm)', k: 1.0 / 800 ** 2, lengthM: 20, defaultFlowLpm: 800 },
  A: { label: 'A-Schlauch (110 mm)', k: 0.17 / 800 ** 2, lengthM: 20, defaultFlowLpm: 1600 },
  F: { label: 'F-Schlauch (150 mm)', k: 0.25 / 2000 ** 2, lengthM: 20, defaultFlowLpm: 2000 },
};

export interface HydraulicsInput {
  hose: HoseType;
  /** Fördermenge l/min */
  flowLpm: number;
  /** Ausgangsdruck jeder Pumpe (bar) */
  pumpOutBar: number;
  /** Mindesteingangsdruck an Verstärkerpumpen (bar) */
  minInBar: number;
  /** Mindestdruck bei der Übergabe am Einsatzort (bar) */
  endBar: number;
}

export const DEFAULT_HYDRAULICS: HydraulicsInput = { hose: 'B', flowLpm: 800, pumpOutBar: 8, minInBar: 1.5, endBar: 1.5 };

/** Reibungsverlust in bar je 100 m */
export function pressureLossPer100m(hose: HoseType, flowLpm: number): number {
  return HOSE_TYPES[hose].k * flowLpm ** 2;
}

/** Schläuche für eine Strecke, mit Reserve für Bögen und Durchhang (Vorgabe 10 %) */
export function hoseCount(lengthM: number, hose: HoseType, reserve = 0.1): number {
  return Math.ceil((lengthM * (1 + reserve)) / HOSE_TYPES[hose].lengthM);
}

// --- Wege ---

/** Weg [Länge, Breite] gleichmäßig abtasten; der letzte Punkt ist immer das Wegende */
export function resamplePath(path: [number, number][], stepM = ELEVATION_STEP_M, maxPoints = ELEVATION_MAX_SAMPLES): { d: number; lat: number; lon: number }[] {
  if (!path.length) return [];
  const pts = path.map(([lon, lat]) => ({ lat, lon }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + distanceM(pts[i - 1]!, pts[i]!));
  const total = cum[cum.length - 1]!;
  const step = Math.max(stepM, total / Math.max(1, maxPoints - 1));
  const out: { d: number; lat: number; lon: number }[] = [];
  let seg = 0;
  for (let d = 0; d < total; d += step) {
    while (seg < pts.length - 2 && cum[seg + 1]! < d) seg++;
    const len = cum[seg + 1]! - cum[seg]!;
    const t = len > 0 ? (d - cum[seg]!) / len : 0;
    const a = pts[seg]!;
    const b = pts[seg + 1] ?? a;
    out.push({ d, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
  }
  const last = pts[pts.length - 1]!;
  out.push({ d: total, lat: last.lat, lon: last.lon });
  return out;
}

/** Punkt bei Strecke d (linear zwischen den Stützpunkten) */
export function pointAt(profile: ProfilePoint[], d: number): ProfilePoint {
  if (!profile.length) return { d, h: 0, lat: 0, lon: 0 };
  if (d <= profile[0]!.d) return { ...profile[0]!, d: Math.max(d, profile[0]!.d) };
  for (let i = 1; i < profile.length; i++) {
    const b = profile[i]!;
    if (d <= b.d) {
      const a = profile[i - 1]!;
      const t = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
      return { d, h: a.h + (b.h - a.h) * t, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
  }
  return { ...profile[profile.length - 1]! };
}

/** Strecke d des Wegpunkts, der (lat, lon) am nächsten liegt (Fußpunkt auf dem nächsten Abschnitt) */
export function projectOnProfile(profile: ProfilePoint[], lat: number, lon: number): number {
  if (profile.length < 2) return profile[0]?.d ?? 0;
  // lokal eben rechnen: Längengrade mit cos(Breite) stauchen
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = { dist: Infinity, d: 0 };
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!;
    const b = profile[i]!;
    const ax = a.lon * kx;
    const bx = b.lon * kx;
    const px = lon * kx;
    const vx = bx - ax;
    const vy = b.lat - a.lat;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (lat - a.lat) * vy) / len2)) : 0;
    const dx = ax + vx * t - px;
    const dy = a.lat + vy * t - lat;
    const dist = dx * dx + dy * dy;
    if (dist < best.dist) best = { dist, d: a.d + (b.d - a.d) * t };
  }
  return best.d;
}

// --- Druckverlauf ---

export interface PressurePoint {
  d: number;
  h: number;
  /** Druck im Schlauch (bar); an Pumpen erscheinen Eingangs- und Ausgangsdruck als zwei Punkte */
  p: number;
}

export interface PumpState {
  d: number;
  h: number;
  lat: number;
  lon: number;
  /** Eingangsdruck; null an der Entnahmestelle (Saug- bzw. Hydrantenbetrieb) */
  inBar: number | null;
  outBar: number;
}

export interface SupplyResult {
  lengthM: number;
  points: PressurePoint[];
  pumps: PumpState[];
  /** Druck am Einsatzort */
  endBar: number;
  /** Höhenunterschied Einsatzort − Entnahmestelle und größte Höhe über der Entnahmestelle */
  climbM: number;
  maxRiseM: number;
  warnings: string[];
}

const km = (d: number) => `km ${(d / 1000).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bar = (p: number) => `${p.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} bar`;

/** Druck unter einer Grenze, mit Toleranz für Rundungsfehler (1,4999… bar zählt als 1,5 bar) */
export function belowBar(p: number, limit: number): boolean {
  return p < limit - 1e-6;
}

/** Druck bei Strecke d hinter einer Pumpe bei `from` */
function pressureFrom(from: ProfilePoint, at: ProfilePoint, out: number, lossPerM: number): number {
  return out - lossPerM * (at.d - from.d) - (at.h - from.h) / 10;
}

/**
 * Druckverlauf mit Pumpen an den Stellen `pumpDs` (Strecke ab Entnahmestelle). Die erste Pumpe steht immer an der
 * Entnahmestelle (d = 0), weitere Positionen werden sortiert und auf den Weg begrenzt.
 */
export function computeSupply(profile: ProfilePoint[], pumpDs: number[], input: HydraulicsInput): SupplyResult {
  const lengthM = profile.length ? profile[profile.length - 1]!.d : 0;
  const lossPerM = pressureLossPer100m(input.hose, input.flowLpm) / 100;
  const ds = [0, ...pumpDs.filter((d) => d > 0 && d < lengthM).sort((a, b) => a - b)];
  const stations = ds.map((d) => pointAt(profile, d));
  const pumps: PumpState[] = [];
  const points: PressurePoint[] = [];
  const warnings: string[] = [];
  let current = stations[0]!;
  let next = 1;
  pumps.push({ d: 0, h: current.h, lat: current.lat, lon: current.lon, inBar: null, outBar: input.pumpOutBar });
  points.push({ d: 0, h: current.h, p: input.pumpOutBar });
  const visit = (pt: ProfilePoint) => pressureFrom(current, pt, input.pumpOutBar, lossPerM);
  for (const pt of profile) {
    while (next < stations.length && stations[next]!.d <= pt.d) {
      const s = stations[next]!;
      const inBar = visit(s);
      points.push({ d: s.d, h: s.h, p: inBar });
      points.push({ d: s.d, h: s.h, p: input.pumpOutBar });
      pumps.push({ d: s.d, h: s.h, lat: s.lat, lon: s.lon, inBar, outBar: input.pumpOutBar });
      if (belowBar(inBar, input.minInBar)) warnings.push(`Pumpe ${pumps.length} (${km(s.d)}): Eingangsdruck ${bar(inBar)} unter ${bar(input.minInBar)}`);
      current = s;
      next++;
    }
    if (pt.d > current.d) points.push({ d: pt.d, h: pt.h, p: visit(pt) });
  }
  const endBar = points.length ? points[points.length - 1]!.p : input.pumpOutBar;
  if (belowBar(endBar, input.endBar)) warnings.push(`Am Einsatzort nur ${bar(endBar)} statt ${bar(input.endBar)}`);
  const below = points.find((x) => belowBar(x.p, 0));
  if (below) warnings.push(`Unterdruck im Schlauch bei ${km(below.d)} (Hochpunkt) – Pumpe davor setzen`);
  const h0 = profile[0]?.h ?? 0;
  return {
    lengthM,
    points,
    pumps,
    endBar,
    climbM: (profile[profile.length - 1]?.h ?? h0) - h0,
    maxRiseM: Math.max(0, ...profile.map((x) => x.h - h0)),
    warnings,
  };
}

/** Höchstzahl vorgeschlagener Pumpen (Schutz vor Endlosschleifen bei unmöglichen Vorgaben) */
const MAX_PUMPS = 40;

/**
 * Verstärkerpumpen vorschlagen: von der Entnahmestelle aus den Weg entlanggehen und die nächste Pumpe dort setzen,
 * wo der Druck auf den Mindesteingangsdruck gefallen ist. Reicht der Druck am Einsatzort nicht, kommt eine Pumpe an
 * die letzte Stelle, an der noch der Übergabedruck anliegt. Liefert die Positionen ohne die Pumpe an der
 * Entnahmestelle.
 */
export function suggestPumps(profile: ProfilePoint[], input: HydraulicsInput): { pumpDs: number[]; warnings: string[] } {
  const warnings: string[] = [];
  const pumpDs: number[] = [];
  if (profile.length < 2) return { pumpDs, warnings };
  const lossPerM = pressureLossPer100m(input.hose, input.flowLpm) / 100;
  const lengthM = profile[profile.length - 1]!.d;
  if (input.pumpOutBar <= input.minInBar) return { pumpDs, warnings: ['Ausgangsdruck muss über dem Mindesteingangsdruck liegen'] };
  let from = profile[0]!;
  for (let guard = 0; guard < MAX_PUMPS; guard++) {
    const p = (pt: ProfilePoint) => pressureFrom(from, pt, input.pumpOutBar, lossPerM);
    const rest = profile.filter((x) => x.d > from.d);
    let place: number | null = null;
    // erster Punkt, an dem der Druck unter den Mindesteingangsdruck fällt
    const failIdx = rest.findIndex((x) => belowBar(p(x), input.minInBar));
    if (failIdx >= 0) {
      const b = rest[failIdx]!;
      const a = failIdx > 0 ? rest[failIdx - 1]! : from;
      place = crossing(a, b, p(a), p(b), input.minInBar);
    } else {
      const end = profile[profile.length - 1]!;
      if (!belowBar(p(end), input.endBar)) return { pumpDs, warnings };
      // letzte Stelle, an der noch der Übergabedruck anliegt
      const target = Math.max(input.endBar, input.minInBar);
      let k = rest.length - 1;
      while (k >= 0 && belowBar(p(rest[k]!), target)) k--;
      const a = k >= 0 ? rest[k]! : from;
      const b = rest[k + 1]!;
      place = crossing(a, b, p(a), p(b), target);
    }
    // Pumpen dichter als eine Schlauchlänge sind keine Lösung mehr
    if (place < lengthM && place - from.d < HOSE_TYPES[input.hose].lengthM) {
      warnings.push(`Mit ${bar(input.pumpOutBar)} Ausgangsdruck ist die Strecke ab ${km(from.d)} nicht zu schaffen – Fördermenge senken oder größeren Schlauch wählen`);
      return { pumpDs, warnings };
    }
    if (place >= lengthM) return { pumpDs, warnings };
    // abrunden: die Pumpe steht eher etwas früher, der Eingangsdruck reicht dann sicher
    pumpDs.push(Math.floor(place));
    from = pointAt(profile, Math.floor(place));
  }
  warnings.push(`Mehr als ${MAX_PUMPS} Pumpen nötig – Vorgaben prüfen`);
  return { pumpDs, warnings };
}

/** Strecke zwischen a und b, an der der Druck linear auf `target` fällt */
function crossing(a: ProfilePoint, b: ProfilePoint, pa: number, pb: number, target: number): number {
  if (pa <= target) return a.d;
  const t = pa === pb ? 0 : (pa - target) / (pa - pb);
  return a.d + (b.d - a.d) * Math.max(0, Math.min(1, t));
}

/** Profil ohne Höhendaten (alle Höhen 0), damit die Rechnung auch offline nur mit Reibung läuft */
export function flatProfile(path: [number, number][]): ProfilePoint[] {
  return resamplePath(path).map((p) => ({ ...p, h: 0 }));
}
