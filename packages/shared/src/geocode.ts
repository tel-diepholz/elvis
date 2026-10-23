/**
 * Ortssuche in der Karte: Ergebnisse des Suchdienstes (Photon) und Koordinaten, die ELVIS selbst erkennt –
 * Dezimalgrad, Grad/Minuten/Sekunden, UTM und UTMREF (MGRS), wie bei der Feuerwehr üblich.
 */

export type GeocodeKind = 'coordinate' | 'house' | 'street' | 'locality' | 'district' | 'city' | 'county' | 'state' | 'country' | 'other';

export interface GeocodeResult {
  id: string;
  kind: GeocodeKind;
  /** Hauptzeile, z. B. „Lange Straße“ oder „Lange Straße 3“ */
  name: string;
  /** Zweite Zeile, z. B. „49406 Barnstorf · Landkreis Diepholz“ */
  detail: string;
  lat: number;
  lon: number;
  /** Ausdehnung (Straße, Ort) als [[Süd, West], [Nord, Ost]], sonst null */
  bounds: [[number, number], [number, number]] | null;
  /** OSM-Objekt, z. B. „R1461203“ (Relation), „W…“ (Weg), „N…“ (Punkt); Grundlage für den Umriss */
  osm: string | null;
}

/** Umriss eines Orts oder Verwaltungsgebiets (GeoJSON-Geometrie, Koordinaten [Länge, Breite]) */
export type GeoOutline = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

/** Treffer, deren Umriss die Karte zeigt (Flächen statt Punkten) */
export const OUTLINE_KINDS: GeocodeKind[] = ['city', 'district', 'locality', 'county', 'state'];

export const hasOutline = (r: GeocodeResult) => OUTLINE_KINDS.includes(r.kind) && /^[RW]\d+$/.test(r.osm ?? '');

export interface GeocodeResponse {
  results: GeocodeResult[];
  /** Woher die Treffer stammen, z. B. „Ortssuche (lokal)“ oder „photon.komoot.io“; null = nur erkannte Koordinaten */
  source: string | null;
  /** Hinweis, wenn kein Suchdienst erreichbar war */
  problem: string | null;
}

export const GEOCODE_KIND_LABELS: Record<GeocodeKind, string> = {
  coordinate: 'Koordinate',
  house: 'Adresse',
  street: 'Straße',
  locality: 'Ortsteil',
  district: 'Ortsteil',
  city: 'Ort',
  county: 'Landkreis',
  state: 'Bundesland',
  country: 'Land',
  other: 'Ort',
};

// --- UTM (WGS84, Formeln nach Snyder, genau auf wenige Zentimeter innerhalb einer Zone) ---

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Breitenbänder C … X, je 8° ab 80° S (X reicht bis 84° N) */
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
/** Spaltenbuchstaben der 100-km-Quadrate je Zonensatz, Zeilenbuchstaben (20er-Zyklus) */
const MGRS_COLUMNS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const MGRS_ROWS = 'ABCDEFGHJKLMNPQRSTUV';

export interface Utm {
  zone: number;
  band: string;
  easting: number;
  northing: number;
}

/** Meridianbogenlänge vom Äquator bis zur Breite phi (Bogenmaß) */
function meridianArc(phi: number): number {
  return (
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi))
  );
}

function utmZone(lat: number, lon: number): number {
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32; // Südnorwegen
  if (lat >= 72 && lat < 84 && lon >= 0 && lon < 42) return lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : 37; // Spitzbergen
  return Math.min(60, Math.floor((lon + 180) / 6) + 1);
}

const bandOf = (lat: number) => BANDS[Math.min(19, Math.max(0, Math.floor((lat + 80) / 8)))]!;
const centralMeridian = (zone: number) => (zone - 1) * 6 - 180 + 3;

export function latLonToUtm(lat: number, lon: number, forceZone?: number): Utm {
  const zone = forceZone ?? utmZone(lat, lon);
  const phi = rad(lat);
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const t = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * s * s);
  const tt = t * t;
  const cc = EP2 * c * c;
  const a = c * rad(lon - centralMeridian(zone));
  const easting = K0 * n * (a + ((1 - tt + cc) * a ** 3) / 6 + ((5 - 18 * tt + tt * tt + 72 * cc - 58 * EP2) * a ** 5) / 120) + 500000;
  let northing = K0 * (meridianArc(phi) + n * t * ((a * a) / 2 + ((5 - tt + 9 * cc + 4 * cc * cc) * a ** 4) / 24 + ((61 - 58 * tt + tt * tt + 600 * cc - 330 * EP2) * a ** 6) / 720));
  if (lat < 0) northing += 10_000_000;
  return { zone, band: bandOf(lat), easting, northing };
}

export function utmToLatLon(zone: number, northern: boolean, easting: number, northing: number): { lat: number; lon: number } {
  const x = easting - 500000;
  const y = northern ? northing : northing - 10_000_000;
  const mu = y / K0 / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1);
  const c = Math.cos(phi1);
  const t = Math.tan(phi1);
  const n1 = A / Math.sqrt(1 - E2 * s * s);
  const r1 = (A * (1 - E2)) / (1 - E2 * s * s) ** 1.5;
  const tt = t * t;
  const cc = EP2 * c * c;
  const d = x / (n1 * K0);
  const lat =
    phi1 -
    ((n1 * t) / r1) *
      ((d * d) / 2 - ((5 + 3 * tt + 10 * cc - 4 * cc * cc - 9 * EP2) * d ** 4) / 24 + ((61 + 90 * tt + 298 * cc + 45 * tt * tt - 252 * EP2 - 3 * cc * cc) * d ** 6) / 720);
  const lon = (d - ((1 + 2 * tt + cc) * d ** 3) / 6 + ((5 - 2 * cc + 28 * tt - 3 * cc * cc + 8 * EP2 + 24 * tt * tt) * d ** 5) / 120) / c;
  return { lat: deg(lat), lon: centralMeridian(zone) + deg(lon) };
}

/** UTMREF/MGRS mit 1 m Auflösung, z. B. „32U MD 66507 40110“ */
export function toMgrs(lat: number, lon: number): string {
  const u = latLonToUtm(lat, lon);
  const col = MGRS_COLUMNS[(u.zone - 1) % 3]![Math.floor(u.easting / 100000) - 1] ?? '?';
  let row = Math.floor(u.northing / 100000) % 20;
  if (u.zone % 2 === 0) row = (row + 5) % 20;
  const five = (v: number) => String(Math.floor(v % 100000)).padStart(5, '0');
  return `${u.zone}${u.band} ${col}${MGRS_ROWS[row]} ${five(u.easting)} ${five(u.northing)}`;
}

/** UTMREF/MGRS → Mitte des bezeichneten Quadrats (bei 4 Ziffern je Achse also 10 m) */
function fromMgrs(zone: number, band: string, col: string, rowLetter: string, e: string, n: string): { lat: number; lon: number } | null {
  const ci = MGRS_COLUMNS[(zone - 1) % 3]!.indexOf(col);
  let ri = MGRS_ROWS.indexOf(rowLetter);
  if (ci < 0 || ri < 0) return null;
  if (zone % 2 === 0) ri = (ri + 15) % 20; // gerade Zonen beginnen fünf Buchstaben später
  const scale = 10 ** (5 - e.length);
  const easting = (ci + 1) * 100000 + (Number(e) + 0.5) * scale;
  let northing = ri * 100000 + (Number(n) + 0.5) * scale;
  // Die Zeilenbuchstaben wiederholen sich alle 2000 km; das Breitenband legt fest, welcher Zyklus gemeint ist
  const bandLat = -80 + BANDS.indexOf(band) * 8;
  const northern = band >= 'N';
  let minNorthing = K0 * meridianArc(rad(bandLat));
  if (!northern) minNorthing += 10_000_000;
  while (northing < minNorthing - 100000) northing += 2_000_000;
  return utmToLatLon(zone, northern, easting, northing);
}

// --- Koordinaten in Suchtexten erkennen ---

export interface ParsedCoordinate {
  lat: number;
  lon: number;
  /** Erkanntes Format, z. B. „UTMREF“ */
  format: string;
}

const valid = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const num = (s: string | undefined) => (s ? Number(s.replace(',', '.')) : 0);

const MGRS_RE = /^(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d{1,10})\s*(\d{0,5})$/;
const UTM_RE = /^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d{6}(?:[.,]\d+)?)\s*[EO]?\s+(\d{7}(?:[.,]\d+)?)\s*N?$/;
const DECIMAL_RE = /^([-+]?\d{1,3}(?:[.,]\d+)?)\s*(?:[,;]\s*|\s+)([-+]?\d{1,3}(?:[.,]\d+)?)$/;
/** Eine Koordinate mit Halbkugel und/oder Gradzeichen: N 52° 42.591' · 52°42'35.5"N · N52.7098 */
const DMS_RE =
  /([NSEWO])?\s*(\d{1,3}(?:[.,]\d+)?)\s*(°)?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*['′’]\s*)?(?:(\d{1,2}(?:[.,]\d+)?)\s*(?:["″”]|'')\s*)?([NSEWO])?/gi;

/** Koordinate aus einem Suchtext; null, wenn der Text keine ist */
export function parseCoordinates(input: string): ParsedCoordinate | null {
  const q = input.trim().toUpperCase();
  if (!q) return null;

  const m = MGRS_RE.exec(q);
  if (m) {
    let [e, n] = [m[5]!, m[6]!];
    if (!n) {
      if (e.length % 2) return null;
      [e, n] = [e.slice(0, e.length / 2), e.slice(e.length / 2)];
    }
    const zone = Number(m[1]);
    if (zone < 1 || zone > 60 || e.length !== n.length || e.length > 5) return null;
    const p = fromMgrs(zone, m[2]!, m[3]!, m[4]!, e, n);
    return p && valid(p.lat, p.lon) ? { ...p, format: 'UTMREF' } : null;
  }

  const u = UTM_RE.exec(q);
  if (u) {
    const zone = Number(u[1]);
    if (zone < 1 || zone > 60) return null;
    const p = utmToLatLon(zone, u[2]! >= 'N', num(u[3]), num(u[4]));
    return valid(p.lat, p.lon) ? { ...p, format: 'UTM' } : null;
  }

  const d = DECIMAL_RE.exec(q);
  if (d) {
    const [lat, lon] = [num(d[1]), num(d[2])];
    return valid(lat, lon) ? { lat, lon, format: 'Dezimalgrad' } : null;
  }

  // Grad/Minuten/Sekunden oder Dezimalgrad mit Halbkugel: genau zwei Angaben, mindestens eine mit ° oder N/S/E/W
  const parts = [...q.matchAll(DMS_RE)].filter((x) => x[2]);
  const rest = q.replace(DMS_RE, '').replace(/[\s,;]/g, '');
  if (parts.length !== 2 || rest) return null;
  if (!parts.some((x) => x[1] || x[3]?.includes('°') || x[6])) return null;
  const values = parts.map((x) => {
    const hemi = x[1] ?? x[6] ?? '';
    const v = num(x[2]) + num(x[4]) / 60 + num(x[5]) / 3600;
    return { v: hemi === 'S' || hemi === 'W' ? -v : v, axis: /[NS]/.test(hemi) ? 'lat' : /[EWO]/.test(hemi) ? 'lon' : '' };
  });
  const [first, second] = values as [(typeof values)[0], (typeof values)[0]];
  const swap = first.axis === 'lon' || second.axis === 'lat';
  const [lat, lon] = swap ? [second.v, first.v] : [first.v, second.v];
  return valid(lat, lon) ? { lat, lon, format: 'Grad/Minuten' } : null;
}
