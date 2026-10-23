/**
 * Stationäres Gaußsches Fahnenmodell für die Lagebild-Orientierung bei Freisetzungen,
 * strukturell angelehnt an VDI 3783 Blatt 1 (Bodenreflexion, Ausbreitungsklassen, Windprofil).
 *
 * Grenzen – bewusst NICHT abgebildet: Gelände und Bebauung im Detail, Inversionsdeckel,
 * Schwergas, thermischer Auftrieb, zeitliche Entwicklung (Puff). Ergebnis ist eine
 * Orientierung, keine Grundlage für Grenzwertentscheidungen.
 *
 * Die Ausbreitungsparameter σy/σz sind die Briggs-Formeln (offenes Gelände bzw. städtisch,
 * Pasquill-Klassen A–F). Sie sind in SIGMA_PARAMETERS gekapselt und können durch die
 * Koeffizienten aus VDI 3783 Blatt 1 ersetzt werden.
 */

export type PasquillClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type KlugManierClass = 'I' | 'II' | 'III/1' | 'III/2' | 'IV' | 'V';
export type Terrain = 'rural' | 'urban';

export const KLUG_MANIER: Record<KlugManierClass, { label: string; pasquill: PasquillClass }> = {
  I: { label: 'sehr stabil', pasquill: 'F' },
  II: { label: 'stabil', pasquill: 'E' },
  'III/1': { label: 'neutral/stabil', pasquill: 'D' },
  'III/2': { label: 'neutral/labil', pasquill: 'C' },
  IV: { label: 'labil', pasquill: 'B' },
  V: { label: 'sehr labil', pasquill: 'A' },
};

const FROM_PASQUILL: Record<PasquillClass, KlugManierClass> = { F: 'I', E: 'II', D: 'III/1', C: 'III/2', B: 'IV', A: 'V' };

export const TERRAIN_LABELS: Record<Terrain, string> = {
  rural: 'Offenes Gelände',
  urban: 'Bebauung / Stadt',
};

// --- Sonnenstand ---

/** Sonnenhöhe in Grad (Näherung nach USNO, Genauigkeit ~0,5° – ausreichend für die Einstrahlungsklasse). */
export function sunElevationDeg(date: Date, latDeg: number, lonDeg: number): number {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmstDeg = (18.697374558 + 24.06570982441908 * d) * 15;
  const ha = (gmstDeg + lonDeg) * rad - ra;
  const lat = latDeg * rad;
  return Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)) / rad;
}

// --- Ausbreitungsklasse ---

export interface StabilityInput {
  /** Windgeschwindigkeit in 10 m Höhe. */
  windSpeedMs: number;
  /** Bedeckungsgrad in Achteln (0–8). */
  cloudOktas: number;
  sunElevationDeg: number;
}

/**
 * Ausbreitungsklasse nach dem Pasquill/Turner-Schema aus Wind, Einstrahlung und Bewölkung,
 * ausgegeben als Klug/Manier-Klasse. Bei Zwischenklassen (z. B. A–B) wird die stabilere
 * gewählt, weil sie die längere Fahne ergibt (konservativ für die Reichweite).
 */
export function estimateStability({ windSpeedMs: u, cloudOktas, sunElevationDeg: sun }: StabilityInput): KlugManierClass {
  if (cloudOktas >= 8) return FROM_PASQUILL.D;

  if (sun < 0) {
    const cloudy = cloudOktas >= 4;
    const cls: PasquillClass = u < 3 ? (cloudy ? 'E' : 'F') : u < 5 ? (cloudy ? 'D' : 'E') : 'D';
    return FROM_PASQUILL[cls];
  }
  // Dämmerung / tiefe Sonne: neutral
  if (sun < 15) return FROM_PASQUILL.D;

  let insolation: 0 | 1 | 2 = sun > 60 ? 2 : sun > 35 ? 1 : 0; // stark / mäßig / schwach
  if (cloudOktas >= 5 && insolation > 0) insolation = (insolation - 1) as 0 | 1;

  const table: [number, [PasquillClass, PasquillClass, PasquillClass]][] = [
    // [u-Obergrenze, [schwach, mäßig, stark]]
    [2, ['B', 'B', 'A']],
    [3, ['C', 'B', 'B']],
    [5, ['C', 'C', 'B']],
    [Infinity, ['D', 'D', 'C']],
  ];
  const row = table.find(([max]) => u < max)![1];
  return FROM_PASQUILL[row[insolation]];
}

// --- Ausbreitungsparameter ---

type SigmaFn = (x: number) => number;

/** Briggs (1973): offenes Gelände bzw. städtisch (nach McElroy-Pooler). x in m, Ergebnis in m. */
export const SIGMA_PARAMETERS: Record<Terrain, Record<PasquillClass, { sy: SigmaFn; sz: SigmaFn }>> = {
  rural: {
    A: { sy: (x) => 0.22 * x * (1 + 0.0001 * x) ** -0.5, sz: (x) => 0.2 * x },
    B: { sy: (x) => 0.16 * x * (1 + 0.0001 * x) ** -0.5, sz: (x) => 0.12 * x },
    C: { sy: (x) => 0.11 * x * (1 + 0.0001 * x) ** -0.5, sz: (x) => 0.08 * x * (1 + 0.0002 * x) ** -0.5 },
    D: { sy: (x) => 0.08 * x * (1 + 0.0001 * x) ** -0.5, sz: (x) => 0.06 * x * (1 + 0.0015 * x) ** -0.5 },
    E: { sy: (x) => 0.06 * x * (1 + 0.0001 * x) ** -0.5, sz: (x) => (0.03 * x) / (1 + 0.0003 * x) },
    F: { sy: (x) => 0.04 * x * (1 + 0.0001 * x) ** -0.5, sz: (x) => (0.016 * x) / (1 + 0.0003 * x) },
  },
  urban: {
    A: { sy: (x) => 0.32 * x * (1 + 0.0004 * x) ** -0.5, sz: (x) => 0.24 * x * (1 + 0.001 * x) ** 0.5 },
    B: { sy: (x) => 0.32 * x * (1 + 0.0004 * x) ** -0.5, sz: (x) => 0.24 * x * (1 + 0.001 * x) ** 0.5 },
    C: { sy: (x) => 0.22 * x * (1 + 0.0004 * x) ** -0.5, sz: (x) => 0.2 * x },
    D: { sy: (x) => 0.16 * x * (1 + 0.0004 * x) ** -0.5, sz: (x) => 0.14 * x * (1 + 0.0003 * x) ** -0.5 },
    E: { sy: (x) => 0.11 * x * (1 + 0.0004 * x) ** -0.5, sz: (x) => 0.08 * x * (1 + 0.0015 * x) ** -0.5 },
    F: { sy: (x) => 0.11 * x * (1 + 0.0004 * x) ** -0.5, sz: (x) => 0.08 * x * (1 + 0.0015 * x) ** -0.5 },
  },
};

/** Exponenten des Windprofils u(h) = u10 · (h/10)^p. */
const WIND_PROFILE_EXPONENT: Record<Terrain, Record<PasquillClass, number>> = {
  rural: { A: 0.07, B: 0.07, C: 0.1, D: 0.15, E: 0.35, F: 0.55 },
  urban: { A: 0.15, B: 0.15, C: 0.2, D: 0.25, E: 0.3, F: 0.3 },
};

/** Unterhalb dieser Windgeschwindigkeit ist ein stationäres Gaußmodell nicht belastbar. */
export const MIN_WIND_MS = 1;

export interface PlumeParams {
  stability: KlugManierClass;
  terrain: Terrain;
  windSpeed10mMs: number;
  /** Effektive Quellhöhe in m (0 = Bodenquelle). */
  sourceHeightM: number;
}

export function sigmas(x: number, stability: KlugManierClass, terrain: Terrain): { sy: number; sz: number } {
  const p = SIGMA_PARAMETERS[terrain][KLUG_MANIER[stability].pasquill];
  return { sy: p.sy(x), sz: p.sz(x) };
}

export function windAtSourceHeight(p: PlumeParams): number {
  const exp = WIND_PROFILE_EXPONENT[p.terrain][KLUG_MANIER[p.stability].pasquill];
  const u = p.windSpeed10mMs * (Math.max(p.sourceHeightM, 10) / 10) ** exp;
  return Math.max(MIN_WIND_MS, u);
}

/**
 * Bodennahe Konzentration je Freisetzungsrate c/Q in s/m³ am Punkt x (in Windrichtung) und y
 * (quer dazu), mit Totalreflexion am Boden.
 */
export function concentrationPerRate(x: number, y: number, p: PlumeParams): number {
  if (x <= 0) return 0;
  const { sy, sz } = sigmas(x, p.stability, p.terrain);
  const u = windAtSourceHeight(p);
  const h = p.sourceHeightM;
  return (1 / (Math.PI * sy * sz * u)) * Math.exp(-(y * y) / (2 * sy * sy)) * Math.exp(-(h * h) / (2 * sz * sz));
}

export interface PlumeContour {
  /** c/Q-Schwelle in s/m³. */
  threshold: number;
  /** Geschlossener Umriss in lokalen Koordinaten (x in Windrichtung, y nach links), in m. */
  outline: { x: number; y: number }[];
  /** Reichweite in Windrichtung in m. */
  maxDistanceM: number;
  /** Größte halbe Breite in m. */
  maxHalfWidthM: number;
  /** Die Isolinie reicht über die Rechengrenze hinaus. */
  truncated: boolean;
}

/**
 * Isolinie c/Q = threshold. Für jedes x ergibt sich die halbe Breite analytisch aus
 * c0(x)·exp(−y²/2σy²) = T, also y = σy·√(2·ln(c0/T)); die Enden werden per Bisektion bestimmt.
 */
export function plumeContour(p: PlumeParams, threshold: number, opts: { minX?: number; maxX?: number; samples?: number } = {}): PlumeContour | null {
  const minX = opts.minX ?? 5;
  const maxX = opts.maxX ?? 20_000;
  const n = opts.samples ?? 160;
  const c0 = (x: number) => concentrationPerRate(x, 0, p);
  const halfWidth = (x: number) => {
    const c = c0(x);
    return c > threshold ? sigmas(x, p.stability, p.terrain).sy * Math.sqrt(2 * Math.log(c / threshold)) : 0;
  };

  const xs = Array.from({ length: n }, (_, i) => minX * (maxX / minX) ** (i / (n - 1)));
  const inside = xs.map((x) => c0(x) > threshold);
  const first = inside.indexOf(true);
  if (first === -1) return null;
  const last = inside.lastIndexOf(true);

  const bisect = (a: number, b: number) => {
    // a außerhalb, b innerhalb (oder umgekehrt) – Grenze c0 = T
    const aIn = c0(a) > threshold;
    for (let i = 0; i < 50; i++) {
      const m = (a + b) / 2;
      if (c0(m) > threshold === aIn) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };

  const start = first === 0 ? minX : bisect(xs[first - 1]!, xs[first]!);
  const truncated = last === n - 1;
  const end = truncated ? maxX : bisect(xs[last]!, xs[last + 1]!);

  const inner = xs.filter((x) => x > start && x < end);
  const left = [{ x: start, y: 0 }, ...inner.map((x) => ({ x, y: halfWidth(x) })), { x: end, y: truncated ? halfWidth(end) : 0 }];
  const right = left
    .slice()
    .reverse()
    .map(({ x, y }) => ({ x, y: -y }));

  return {
    threshold,
    outline: [...left, ...right],
    maxDistanceM: end,
    maxHalfWidthM: Math.max(...left.map((pt) => pt.y)),
    truncated,
  };
}

/** Lokale Fahnenkoordinaten → geographische Koordinaten (ebene Näherung, gut bis ~20 km). */
export function plumeToLatLon(
  origin: { lat: number; lon: number },
  windFromDeg: number,
  pt: { x: number; y: number },
): [number, number] {
  const b = (((windFromDeg + 180) % 360) * Math.PI) / 180;
  const east = pt.x * Math.sin(b) - pt.y * Math.cos(b);
  const north = pt.x * Math.cos(b) + pt.y * Math.sin(b);
  const lat = origin.lat + north / 111_320;
  const lon = origin.lon + east / (111_320 * Math.cos((origin.lat * Math.PI) / 180));
  return [lat, lon];
}
