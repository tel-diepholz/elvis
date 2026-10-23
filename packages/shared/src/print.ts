/**
 * Druckgeometrie für Lagekarten. Client (Vorschau-Rahmen) und Server (PDF) rechnen mit
 * denselben Funktionen, damit der gewählte Ausschnitt exakt dem Druck entspricht.
 */

export type PaperFormat = 'A3' | 'A2' | 'A1';
export type Orientation = 'portrait' | 'landscape';

/** Papiermaße hochkant in mm. */
export const PAPER_MM: Record<PaperFormat, { width: number; height: number }> = {
  A3: { width: 297, height: 420 },
  A2: { width: 420, height: 594 },
  A1: { width: 594, height: 841 },
};

export const PRINT_MARGIN_MM = 10;

/**
 * Druckgröße eines Kartenpixels. 0,25 mm (~100 dpi) hält die Beschriftung der Rasterkacheln
 * aus ~1 m Betrachtungsabstand lesbar.
 */
export const PRINT_MM_PER_PX = 0.25;

export const TILE_SIZE = 256;
export const MIN_PRINT_ZOOM = 10;
export const MAX_PRINT_ZOOM = 19;

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

export interface WorldPoint {
  x: number;
  y: number;
}

/** WGS84 → Web-Mercator-Weltpixel bei Zoomstufe z. */
export function project(lat: number, lon: number, zoom: number): WorldPoint {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

export function unproject(p: WorldPoint, zoom: number): { lat: number; lon: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const lon = (p.x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * p.y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lon };
}

export function metersPerPixel(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom);
}

export interface PrintFrame {
  /** Kartenfläche (Seite ohne Ränder) in mm. */
  mapWidthMm: number;
  mapHeightMm: number;
  /** Kartenfläche in Kartenpixeln bei der gewählten Zoomstufe. */
  widthPx: number;
  heightPx: number;
  /** Weltpixel der linken oberen Ecke. */
  origin: WorldPoint;
  bounds: { north: number; south: number; west: number; east: number };
  /** Maßstabszahl, z. B. 7500 für 1:7.500 (in Kartenmitte). */
  scale: number;
  /** Abgedeckte Fläche in m. */
  widthM: number;
  heightM: number;
}

export function printFrame(
  center: { lat: number; lon: number },
  zoom: number,
  paper: PaperFormat,
  orientation: Orientation,
): PrintFrame {
  const p = PAPER_MM[paper];
  const [pw, ph] = orientation === 'portrait' ? [p.width, p.height] : [p.height, p.width];
  const mapWidthMm = pw - 2 * PRINT_MARGIN_MM;
  const mapHeightMm = ph - 2 * PRINT_MARGIN_MM;
  const widthPx = Math.round(mapWidthMm / PRINT_MM_PER_PX);
  const heightPx = Math.round(mapHeightMm / PRINT_MM_PER_PX);
  const c = project(center.lat, center.lon, zoom);
  const origin = { x: c.x - widthPx / 2, y: c.y - heightPx / 2 };
  const nw = unproject(origin, zoom);
  const se = unproject({ x: origin.x + widthPx, y: origin.y + heightPx }, zoom);
  const mpp = metersPerPixel(center.lat, zoom);
  return {
    mapWidthMm,
    mapHeightMm,
    widthPx,
    heightPx,
    origin,
    bounds: { north: nw.lat, west: nw.lon, south: se.lat, east: se.lon },
    scale: mpp / (PRINT_MM_PER_PX / 1000),
    widthM: widthPx * mpp,
    heightM: heightPx * mpp,
  };
}

/** Rundet eine Maßstabszahl auf zwei geltende Ziffern (z. B. 5991 → 6000, 7514 → 7500). */
export function niceScale(scale: number): number {
  const mag = 10 ** (Math.floor(Math.log10(scale)) - 1);
  return Math.round(scale / mag) * mag;
}

// --- Druckauftrag ---

export interface MapSource {
  id: string;
  name: string;
  attribution: string;
  maxZoom: number;
  /** Verwendungszweck: Standard, Dunkelmodus oder Druck. */
  variant?: 'light' | 'dark' | 'print';
}

export interface PrintMarker {
  kind: 'vehicle' | 'incident';
  lat: number;
  lon: number;
  label: string;
}

export interface PrintPolygon {
  points: [number, number][];
  stroke: string;
  fill: string;
  fillOpacity: number;
  dashed?: boolean;
}

export interface PrintLegendItem {
  color: string;
  label: string;
}

export interface MapPrintRequest {
  paper: PaperFormat;
  orientation: Orientation;
  zoom: number;
  center: { lat: number; lon: number };
  sourceId: string;
  title: string;
  subtitle?: string;
  markers: PrintMarker[];
  polygons: PrintPolygon[];
  legend: PrintLegendItem[];
  notes: string[];
}
