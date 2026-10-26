/**
 * Overpass-Abfragen in der Karte: einfacher Tag-Filter oder Overpass QL, ausgeführt für den Kartenausschnitt.
 * Der Server fragt die lokale Overpass-API des Addons OSM-Daten, sonst einen öffentlichen Server, und wandelt die
 * Antwort (`out geom`) in Treffer mit GeoJSON-Geometrie um – Punkte, Linien und Flächen wie bei der Ortssuche.
 */
import { z } from 'zod';
import { mapColorSchema, mapIconNameSchema } from './mapobjects';

export type OverpassOp = '=' | '!=' | '~' | 'exists';

export const OVERPASS_OPS: { value: OverpassOp; label: string }[] = [
  { value: '=', label: '=' },
  { value: '!=', label: '≠' },
  { value: '~', label: '≈ (Regex)' },
  { value: 'exists', label: 'vorhanden' },
];

export const OVERPASS_ELEMENTS = [
  { value: 'nwr', label: 'Alles' },
  { value: 'node', label: 'Punkte' },
  { value: 'way', label: 'Wege' },
  { value: 'relation', label: 'Relationen' },
] as const;
export type OverpassElements = (typeof OVERPASS_ELEMENTS)[number]['value'];

const filterSchema = z.object({
  key: z.string().trim().min(1, 'Schlüssel fehlt').max(100),
  op: z.enum(['=', '!=', '~', 'exists']),
  value: z.string().trim().max(200).default(''),
});
export type OverpassFilter = z.infer<typeof filterSchema>;

export const overpassQuerySchema = z
  .object({
    name: z.string().trim().min(1, 'Name fehlt').max(80),
    mode: z.enum(['simple', 'ql']),
    elements: z.enum(['nwr', 'node', 'way', 'relation']).default('nwr'),
    filters: z.array(filterSchema).max(10).default([]),
    ql: z.string().max(10_000).default(''),
    /** Symbol der Treffer (Lucide-Name), null = Kreis */
    icon: mapIconNameSchema.nullable().default(null),
    /** Schild am Symbol mit Tag-Platzhaltern, z. B. „DN {fire_hydrant:diameter}“ */
    badge: z.string().trim().max(120).default(''),
    /** Farbe der Treffer und übernommener Objekte, null = Vorgabe */
    color: mapColorSchema.nullable().default(null),
  })
  .superRefine((q, ctx) => {
    if (q.mode === 'simple' && !q.filters.length) ctx.addIssue({ code: 'custom', path: ['filters'], message: 'Mindestens ein Filter nötig' });
    if (q.mode === 'simple' && q.filters.some((f) => f.op !== 'exists' && !f.value))
      ctx.addIssue({ code: 'custom', path: ['filters'], message: 'Wert fehlt' });
    if (q.mode === 'ql' && !q.ql.trim()) ctx.addIssue({ code: 'custom', path: ['ql'], message: 'Abfrage fehlt' });
  });
export type OverpassQuery = z.infer<typeof overpassQuerySchema>;
export type OverpassQueryInput = z.input<typeof overpassQuerySchema>;

export const overpassQueryListSchema = z.array(overpassQuerySchema).max(50);

/** Kartenausschnitt in Grad; größer als 3° je Richtung lehnt der Server ab (Laufzeit, Datenmenge) */
export const OVERPASS_MAX_SPAN = 3;
export const overpassBoundsSchema = z
  .object({ s: z.number().min(-90).max(90), w: z.number().min(-180).max(180), n: z.number().min(-90).max(90), e: z.number().min(-180).max(180) })
  .refine((b) => b.s < b.n && b.w < b.e, 'Ausschnitt ungültig')
  .refine((b) => b.n - b.s <= OVERPASS_MAX_SPAN && b.e - b.w <= OVERPASS_MAX_SPAN, 'Ausschnitt zu groß – bitte näher heranzoomen');
export type OverpassBounds = z.infer<typeof overpassBoundsSchema>;

export const overpassRunSchema = z.object({ query: overpassQuerySchema, bounds: overpassBoundsSchema });

/** Vorlagen in den Einstellungen (erscheinen im Menü „Objekte“) */
export interface OverpassQuerySettings {
  queries: OverpassQuery[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Im Einsatz gespeicherte Abfrage */
export type IncidentOverpassQuery = OverpassQuery & { id: number; incidentId: number; createdAt: string; createdBy: string };

export type OverpassGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

export interface OverpassFeature {
  /** OSM-Objekt wie bei der Ortssuche: „N…“, „W…“, „R…“ */
  id: string;
  name: string;
  detail: string;
  tags: Record<string, string>;
  /** Punkt bzw. Mitte der Ausdehnung */
  lat: number;
  lon: number;
  geometry: OverpassGeometry;
}

export interface OverpassResult {
  source: 'local' | 'online';
  /** z. B. „Overpass (lokal)“ oder „overpass-api.de“ */
  sourceName: string;
  features: OverpassFeature[];
  /** Mehr Treffer als angezeigt (OVERPASS_MAX_FEATURES) */
  truncated: boolean;
  /** Elemente ohne Geometrie (z. B. „out ids“) */
  skipped: number;
  /** Hinweis von Overpass, z. B. Zeitüberschreitung */
  remark: string | null;
}

export interface OverpassStatus {
  source: 'local' | 'online' | null;
  name: string | null;
}

export const OVERPASS_MAX_FEATURES = 2000;
/** Wie bei Flächen der Objektliste: mehr Positionen je Ring bzw. Linie werden ausgedünnt */
const MAX_POSITIONS = 20_000;

// --- Abfrage bauen ---

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function filterQl(f: OverpassFilter): string {
  if (f.op === 'exists') return `[${quote(f.key)}]`;
  return `[${quote(f.key)}${f.op}${quote(f.value)}]`;
}

/** Overpass QL aus dem einfachen Filter: alle Bedingungen müssen zutreffen */
export function buildOverpassQl(elements: OverpassElements, filters: OverpassFilter[]): string {
  return `[out:json][timeout:60];\n${elements}${filters.map(filterQl).join('')}({{bbox}});\nout geom;`;
}

/** Text der Abfrage, wie er an Overpass geht (noch mit {{bbox}}) */
export const overpassQl = (q: Pick<OverpassQuery, 'mode' | 'elements' | 'filters' | 'ql'>) => (q.mode === 'simple' ? buildOverpassQl(q.elements, q.filters) : q.ql);

/** {{bbox}} wie in overpass turbo: Süd, West, Nord, Ost */
export const applyBbox = (ql: string, b: OverpassBounds) => ql.replace(/\{\{\s*bbox\s*\}\}/g, [b.s, b.w, b.n, b.e].map((v) => +v.toFixed(6)).join(','));

// --- Darstellung ---

/** Höchstlänge des Schilds am Symbol */
export const OVERPASS_BADGE_MAX = 40;

/**
 * Schild am Symbol aus einer Vorlage mit Tag-Platzhaltern, z. B. „DN {fire_hydrant:diameter}“ → „DN 100“. Fehlen alle
 * verwendeten Tags, gibt es kein Schild (leere Zeichenkette).
 */
export function overpassBadge(template: string, tags: Record<string, string>): string {
  const keys = [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim());
  if (keys.length && keys.every((k) => !tags[k])) return '';
  return template
    .replace(/\{([^{}]+)\}/g, (_, k: string) => tags[k.trim()] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, OVERPASS_BADGE_MAX);
}

// --- Antwort umwandeln ---

interface LatLon {
  lat: number;
  lon: number;
}
interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  lat?: number;
  lon?: number;
  geometry?: (LatLon | null)[];
}
interface OverpassElement {
  type: 'node' | 'way' | 'relation' | string;
  id: number;
  lat?: number;
  lon?: number;
  center?: LatLon;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: (LatLon | null)[];
  members?: OverpassMember[];
  tags?: Record<string, string>;
}
export interface OverpassJson {
  elements?: OverpassElement[];
  remark?: string;
}

const PREFIX: Record<string, string> = { node: 'N', way: 'W', relation: 'R' };

/** Deutsche Bezeichnungen häufiger Objekte, wenn kein Name eingetragen ist */
const TAG_LABELS: Record<string, string> = {
  'amenity=fire_station': 'Feuerwehrhaus',
  'amenity=hospital': 'Krankenhaus',
  'amenity=clinic': 'Klinik',
  'amenity=doctors': 'Arztpraxis',
  'amenity=pharmacy': 'Apotheke',
  'amenity=police': 'Polizei',
  'amenity=school': 'Schule',
  'amenity=kindergarten': 'Kindergarten',
  'amenity=nursing_home': 'Pflegeheim',
  'social_facility=nursing_home': 'Pflegeheim',
  'amenity=fuel': 'Tankstelle',
  'amenity=parking': 'Parkplatz',
  'amenity=shelter': 'Unterstand',
  'emergency=fire_hydrant': 'Hydrant',
  'emergency=suction_point': 'Saugstelle',
  'emergency=water_tank': 'Löschwasserbehälter',
  'emergency=fire_water_pond': 'Löschteich',
  'emergency=ambulance_station': 'Rettungswache',
  'emergency=defibrillator': 'Defibrillator',
  'emergency=assembly_point': 'Sammelplatz',
  'aeroway=helipad': 'Hubschrauberlandeplatz',
  'aeroway=heliport': 'Hubschrauberlandeplatz',
};
const LABEL_KEYS = ['emergency', 'amenity', 'social_facility', 'aeroway', 'shop', 'tourism', 'leisure', 'building', 'landuse', 'natural', 'highway', 'railway', 'waterway', 'power', 'man_made'];

const HYDRANT_TYPES: Record<string, string> = { underground: 'Unterflur', pillar: 'Überflur', wall: 'Wand', pipe: 'Rohr' };

function typeLabel(tags: Record<string, string>): string | null {
  for (const k of LABEL_KEYS) {
    const v = tags[k];
    if (v) return TAG_LABELS[`${k}=${v}`] ?? `${k}=${v}`;
  }
  return null;
}

function nameOf(e: OverpassElement, tags: Record<string, string>): string {
  const n = tags.name ?? tags['name:de'] ?? tags.ref ?? tags.operator ?? typeLabel(tags) ?? `${PREFIX[e.type] ?? ''}${e.id}`;
  return n.slice(0, 120);
}

function detailOf(tags: Record<string, string>): string {
  const parts: string[] = [];
  const hasName = !!(tags.name ?? tags['name:de'] ?? tags.ref ?? tags.operator);
  const label = typeLabel(tags);
  if (hasName && label) parts.push(label);
  if (tags.emergency === 'fire_hydrant') {
    const t = tags['fire_hydrant:type'];
    const dn = tags['fire_hydrant:diameter'] ?? tags.diameter;
    const h = [t ? (HYDRANT_TYPES[t] ?? t) : null, dn ? `DN ${dn}` : null].filter(Boolean).join(' ');
    if (h) parts.push(h);
  }
  const street = [tags['addr:street'] ?? tags['addr:place'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ');
  const addr = [street, city].filter(Boolean).join(', ');
  if (addr) parts.push(addr);
  return parts.join(' · ').slice(0, 300);
}

/** Koordinaten [Länge, Breite]; null-Lücken (out geom mit Ausschnitt) trennen die Linie */
function pieces(geom: (LatLon | null)[] | undefined): number[][][] {
  const out: number[][][] = [];
  let cur: number[][] = [];
  for (const p of geom ?? []) {
    if (p) cur.push([p.lon, p.lat]);
    else if (cur.length) (out.push(cur), (cur = []));
  }
  if (cur.length) out.push(cur);
  return out.filter((l) => l.length >= 2);
}

const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
const closed = (l: number[][]) => l.length >= 4 && same(l[0]!, l[l.length - 1]!);

/** Zu viele Positionen gleichmäßig ausdünnen; Anfang und Ende bleiben */
function thin(l: number[][]): number[][] {
  if (l.length <= MAX_POSITIONS) return l;
  const step = Math.ceil(l.length / (MAX_POSITIONS - 1));
  const out = l.filter((_, i) => i % step === 0);
  if (!same(out[out.length - 1]!, l[l.length - 1]!)) out.push(l[l.length - 1]!);
  return out;
}

/** Geschlossene Wege mit diesen Tags sind Linien (Kreisverkehr, Zaun, Ringbahn), außer mit area=yes */
const LINEAR: Record<string, true | string[]> = {
  highway: true,
  barrier: true,
  railway: true,
  aerialway: true,
  route: true,
  waterway: true,
  power: ['line', 'minor_line', 'cable'],
  natural: ['coastline', 'tree_row', 'cliff', 'ridge', 'arete'],
  man_made: ['pipeline', 'embankment', 'breakwater', 'groyne'],
};
const AREA_WATERWAYS = ['riverbank', 'dock', 'boatyard'];

function isArea(tags: Record<string, string>): boolean {
  if (tags.area === 'yes') return true;
  if (tags.area === 'no') return false;
  for (const [k, v] of Object.entries(LINEAR)) {
    const t = tags[k];
    if (!t) continue;
    if (k === 'waterway' && AREA_WATERWAYS.includes(t)) continue;
    if (v === true || v.includes(t)) return false;
  }
  return true;
}

/** Wegstücke zu geschlossenen Ringen verbinden; offene Reste fallen weg */
function rings(segments: number[][][]): number[][][] {
  const rest = segments.map((s) => [...s]);
  const out: number[][][] = [];
  while (rest.length) {
    const ring = rest.shift()!;
    while (!closed(ring)) {
      const end = ring[ring.length - 1]!;
      const i = rest.findIndex((s) => same(s[0]!, end) || same(s[s.length - 1]!, end));
      if (i < 0) break;
      const s = rest.splice(i, 1)[0]!;
      ring.push(...(same(s[0]!, end) ? s : [...s].reverse()).slice(1));
    }
    if (closed(ring)) out.push(thin(ring));
  }
  return out;
}

function inside(p: number[], ring: number[][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > p[1]! !== yj! > p[1]! && p[0]! < ((xj! - xi!) * (p[1]! - yi!)) / (yj! - yi!) + xi!) hit = !hit;
  }
  return hit;
}

function multipolygon(members: OverpassMember[]): OverpassGeometry | null {
  const ways = (role: string) => members.filter((m) => m.type === 'way' && (role === 'outer' ? m.role !== 'inner' : m.role === 'inner')).flatMap((m) => pieces(m.geometry));
  const outer = rings(ways('outer'));
  if (!outer.length) return null;
  const polys: number[][][][] = outer.map((r) => [r]);
  for (const hole of rings(ways('inner'))) polys.find((p) => inside(hole[0]!, p[0]!))?.push(hole);
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0]! } : { type: 'MultiPolygon', coordinates: polys };
}

function geometryOf(e: OverpassElement, tags: Record<string, string>): OverpassGeometry | null {
  if (e.type === 'node') return e.lat != null && e.lon != null ? { type: 'Point', coordinates: [e.lon, e.lat] } : null;
  if (e.type === 'way' && e.geometry) {
    const parts = pieces(e.geometry);
    if (parts.length === 1 && closed(parts[0]!) && isArea(tags)) return { type: 'Polygon', coordinates: [thin(parts[0]!)] };
    if (parts.length === 1) return { type: 'LineString', coordinates: thin(parts[0]!) };
    if (parts.length > 1) return { type: 'MultiLineString', coordinates: parts.map(thin) };
  }
  if (e.type === 'relation' && e.members?.some((m) => m.geometry)) {
    if (tags.type === 'multipolygon' || tags.type === 'boundary') {
      const mp = multipolygon(e.members);
      if (mp) return mp;
    }
    const lines = e.members.filter((m) => m.type === 'way').flatMap((m) => pieces(m.geometry)).map(thin);
    if (lines.length) return { type: 'MultiLineString', coordinates: lines };
  }
  // „out center“ oder Relation nur aus Punkten: Mitte als Punkt
  const c = e.center ?? (e.bounds ? { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 } : null);
  return c ? { type: 'Point', coordinates: [c.lon, c.lat] } : null;
}

function centerOf(g: OverpassGeometry): { lat: number; lon: number } {
  if (g.type === 'Point') return { lon: g.coordinates[0]!, lat: g.coordinates[1]! };
  const all: number[][] = g.type === 'LineString' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : g.coordinates.flat();
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of all) [w, s, e, n] = [Math.min(w, x!), Math.min(s, y!), Math.max(e, x!), Math.max(n, y!)];
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

/**
 * Overpass-JSON → Treffer. Punkte ohne Tags (Stützpunkte von Wegen nach „>;“) werden ausgelassen, Elemente ohne
 * Geometrie gezählt.
 */
export function overpassToFeatures(json: OverpassJson, max = OVERPASS_MAX_FEATURES): { features: OverpassFeature[]; truncated: boolean; skipped: number } {
  const features: OverpassFeature[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let truncated = false;
  for (const e of json.elements ?? []) {
    const prefix = PREFIX[e.type];
    if (!prefix) continue;
    const tags = e.tags ?? {};
    if (e.type === 'node' && !Object.keys(tags).length) continue;
    const id = `${prefix}${e.id}`;
    if (seen.has(id)) continue;
    const geometry = geometryOf(e, tags);
    if (!geometry) {
      skipped++;
      continue;
    }
    if (features.length >= max) {
      truncated = true;
      break;
    }
    seen.add(id);
    features.push({ id, name: nameOf(e, tags), detail: detailOf(tags), tags, ...centerOf(geometry), geometry });
  }
  return { features, truncated, skipped };
}
