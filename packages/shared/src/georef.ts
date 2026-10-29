/**
 * Georeferenzierung von PDF-Seiten (Dokumente → Tools → „PDF in Karte integrieren“): Passpunkte verbinden Bildpixel
 * mit Kartenpositionen, eine affine Abbildung (kleinste Quadrate in Web-Mercator) legt die Seite auf die Karte. Der
 * Browser zeigt damit Vorschau und Restfehler, der Server leitet Zoomstufen und Ausdehnung der Kacheln ab.
 */
import { z } from 'zod';

/** Passpunkt: Bildpixel (x nach rechts, y nach unten, Ursprung oben links) ↔ Kartenposition */
export interface Gcp {
  x: number;
  y: number;
  lat: number;
  lon: number;
}

/** Bildpixel → Web-Mercator-Meter: X = a·x + b·y + c, Y = d·x + e·y + f */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface AffineFit {
  t: Affine;
  /** Abweichung je Passpunkt in Metern am Boden */
  residualsM: number[];
  /** Mittlerer Restfehler (RMS) in Metern; bei genau 3 Punkten immer 0 */
  rmsM: number;
}

/** Weggeschnittener Bereich der Seite (Legende, Schriftfeld) als Rechteck in Bildpixeln [x0, y0, x1, y1] */
export type GeorefCut = [number, number, number, number];

/** Punkt der Seite in Bildpixeln [x, y] */
export type GeorefPoint = [number, number];

/** Hintergrund (Papierfarbe), der außerhalb des Gebäudeumrisses transparent wird */
export interface GeorefBackground {
  color: string;
  /** Größte Abweichung je Farbkanal (0–255), die noch als Hintergrund gilt */
  tolerance: number;
}

/** Strich des Radierers; wirkt nur außerhalb des Gebäudeumrisses */
export interface GeorefStroke {
  /** Pinselbreite in Bildpixeln */
  width: number;
  points: GeorefPoint[];
}

/** Vorgabe der Toleranz: Papierweiß samt leichter Vergilbung und Kompressionsrauschen */
export const GEOREF_DEFAULT_TOLERANCE = 40;

/**
 * Wird ein Pixel transparent? Rechtecke immer, Hintergrundfarbe und Radierer nur außerhalb des Gebäudes (ohne Umriss:
 * überall). Gleiche Regel im Browser (Vorschau) und auf dem Server (Python im GDAL-Container).
 */
export function isBackground(r: number, g: number, b: number, bg: { r: number; g: number; b: number }, tolerance: number): boolean {
  return Math.max(Math.abs(r - bg.r), Math.abs(g - bg.g), Math.abs(b - bg.b)) <= tolerance;
}

export function hexRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** So viele Seiten rendert das Werkzeug höchstens */
export const GEOREF_MAX_PAGES = 50;
/** Ab so vielen Passpunkten ist eine Entzerrung 2. Ordnung (Polynom) möglich */
export const GEOREF_ORDER2_MIN_GCPS = 6;
/** Feinste Zoomstufe der Kacheln */
export const GEOREF_MAX_ZOOM = 20;
/** So viele Zoomstufen unter der feinsten werden noch gekachelt */
export const GEOREF_ZOOM_LEVELS = 8;

const R = 6378137;
/** Kantenlänge der Welt in Web-Mercator-Metern */
const WORLD_M = 2 * Math.PI * R;

export function mercator(lat: number, lon: number): [number, number] {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return [(lon * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

export function inverseMercator(x: number, y: number): { lat: number; lon: number } {
  return { lat: (Math.atan(Math.sinh(y / R)) * 180) / Math.PI, lon: (x / R) * (180 / Math.PI) };
}

export function applyAffine(t: Affine, x: number, y: number): { lat: number; lon: number } {
  return inverseMercator(t.a * x + t.b * y + t.c, t.d * x + t.e * y + t.f);
}

/** 3×3-Gleichungssystem (Cramer); null, wenn es keine eindeutige Lösung gibt */
function solve3(m: number[][], v: number[]): [number, number, number] | null {
  const det = (q: number[][]) =>
    q[0]![0]! * (q[1]![1]! * q[2]![2]! - q[1]![2]! * q[2]![1]!) - q[0]![1]! * (q[1]![0]! * q[2]![2]! - q[1]![2]! * q[2]![0]!) + q[0]![2]! * (q[1]![0]! * q[2]![1]! - q[1]![1]! * q[2]![0]!);
  const d = det(m);
  const scale = Math.abs(m[0]![0]! * m[1]![1]! * m[2]![2]!) || 1;
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12 * scale) return null;
  const col = (i: number) => m.map((row, r) => row.map((cell, c) => (c === i ? v[r]! : cell)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/**
 * Affine Abbildung aus mindestens 3 Passpunkten (Ausgleich nach kleinsten Quadraten). null bei zu wenigen oder
 * (fast) auf einer Linie liegenden Punkten.
 */
export function fitAffine(gcps: Gcp[]): AffineFit | null {
  if (gcps.length < 3) return null;
  // Bildkoordinaten zentrieren, damit die Normalgleichungen gut konditioniert bleiben
  const mx = gcps.reduce((s, p) => s + p.x, 0) / gcps.length;
  const my = gcps.reduce((s, p) => s + p.y, 0) / gcps.length;
  const pts = gcps.map((p) => ({ u: p.x - mx, v: p.y - my, m: mercator(p.lat, p.lon) }));
  const n = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];
  for (const p of pts) {
    const row = [p.u, p.v, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) n[i]![j]! += row[i]! * row[j]!;
      bx[i]! += row[i]! * p.m[0];
      by[i]! += row[i]! * p.m[1];
    }
  }
  // Kollinear: die Punkte spannen im Bild keine Fläche auf
  const spread = n[0]![0]! * n[1]![1]! - n[0]![1]! * n[1]![0]!;
  if (spread <= 1e-6 * (n[0]![0]! + n[1]![1]!) ** 2) return null;
  const sx = solve3(n, bx);
  const sy = solve3(n, by);
  if (!sx || !sy) return null;
  const t: Affine = { a: sx[0], b: sx[1], c: sx[2] - sx[0] * mx - sx[1] * my, d: sy[0], e: sy[1], f: sy[2] - sy[0] * mx - sy[1] * my };
  if (Math.abs(t.a * t.e - t.b * t.d) < 1e-12) return null;
  const residualsM = gcps.map((p) => {
    const [X, Y] = mercator(p.lat, p.lon);
    const dx = t.a * p.x + t.b * p.y + t.c - X;
    const dy = t.d * p.x + t.e * p.y + t.f - Y;
    // Mercator-Meter → Meter am Boden
    return Math.hypot(dx, dy) * Math.cos((p.lat * Math.PI) / 180);
  });
  const rmsM = gcps.length === 3 ? 0 : Math.sqrt(residualsM.reduce((s, r) => s + r * r, 0) / residualsM.length);
  return { t, residualsM: gcps.length === 3 ? residualsM.map(() => 0) : residualsM, rmsM };
}

/** Ausdehnung der entzerrten Seite als [[Süd, West], [Nord, Ost]] */
export function overlayBounds(t: Affine, width: number, height: number): [[number, number], [number, number]] {
  const corners = [applyAffine(t, 0, 0), applyAffine(t, width, 0), applyAffine(t, 0, height), applyAffine(t, width, height)];
  const lats = corners.map((c) => c.lat);
  const lons = corners.map((c) => c.lon);
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}

/** Zoomstufen der Kacheln: die feinste zeigt die Seite etwa in ihrer gerenderten Auflösung */
export function overlayZoom(t: Affine): { minZoom: number; maxZoom: number } {
  const metersPerPixel = Math.sqrt(Math.abs(t.a * t.e - t.b * t.d));
  const exact = Math.log2(WORLD_M / 256 / metersPerPixel);
  const maxZoom = Math.max(0, Math.min(GEOREF_MAX_ZOOM, Math.ceil(exact)));
  return { minZoom: Math.max(0, maxZoom - GEOREF_ZOOM_LEVELS), maxZoom };
}

// --- Prüfung (Server) ---

export const gcpSchema = z.object({
  x: z.number().min(0).max(100_000),
  y: z.number().min(0).max(100_000),
  lat: z.number().min(-85).max(85),
  lon: z.number().min(-180).max(180),
});

const px = z.number().int().min(0).max(100_000);
export const georefCutSchema = z
  .tuple([px, px, px, px])
  .refine(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0, 'Bereich ist leer');

export const georefRequestSchema = z
  .object({
    page: z.number().int().min(1).max(GEOREF_MAX_PAGES),
    name: z.string().trim().min(1, 'Name fehlt').max(120),
    gcps: z.array(gcpSchema).min(3, 'Mindestens 3 Passpunkte').max(30),
    /** Bereiche, die nicht in die Karte sollen (werden transparent) */
    cuts: z.array(georefCutSchema).max(30).default([]),
    /** Gebäudeumriss; außerhalb wirken Hintergrund und Radierer */
    outline: z.array(z.tuple([z.number().min(0).max(100_000), z.number().min(0).max(100_000)])).min(3).max(500).nullable().default(null),
    background: z
      .object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe im Format #rrggbb'), tolerance: z.number().int().min(0).max(255) })
      .nullable()
      .default(null),
    erase: z
      .array(z.object({ width: z.number().min(1).max(2_000), points: z.array(z.tuple([z.number().min(0).max(100_000), z.number().min(0).max(100_000)])).min(1).max(5_000) }))
      .max(500)
      .default([]),
    order: z.union([z.literal(1), z.literal(2)]).default(1),
  })
  .refine((r) => r.order === 1 || r.gcps.length >= GEOREF_ORDER2_MIN_GCPS, { message: `Entzerrung 2. Ordnung braucht mindestens ${GEOREF_ORDER2_MIN_GCPS} Passpunkte`, path: ['order'] });
export type GeorefRequest = z.input<typeof georefRequestSchema>;

/** Gerenderte Seite eines PDFs */
export interface GeorefPage {
  page: number;
  width: number;
  height: number;
}

export interface GeorefStatus {
  available: boolean;
  /** Warum das Werkzeug gerade nicht geht */
  reason: string | null;
}

export type GeorefJobKind = 'pages' | 'overlay';

export interface GeorefJob {
  id: string;
  kind: GeorefJobKind;
  documentId: number;
  state: 'queued' | 'running' | 'done' | 'failed';
  /** Aktueller Schritt bzw. Fehlermeldung */
  message: string;
  percent: number | null;
  /** Fertiges Overlay (Kartenobjekt) */
  objectId: number | null;
}
