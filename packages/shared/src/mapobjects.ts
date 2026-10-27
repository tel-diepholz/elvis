/**
 * Kartenobjekte eines Einsatzes: übernommene Such- und Overpass-Treffer (Punkt, Fläche mit Umriss, Linie), Ausbreitungen
 * (Gauß-Fahne, Sektor 60°) und verfolgte Flugzeuge bzw. Schiffe (Position kommt live vom Server). Sie gehören zum Einsatz, alle Arbeitsplätze und Bildschirme sehen sie, und sie
 * bleiben im Einsatzarchiv. Der Einsatzort selbst ist Teil des Einsatzes (lat/lon) und kein Kartenobjekt.
 */
import { z } from 'zod';
import type { KlugManierClass, Terrain } from './dispersion';
import type { GeoOutline } from './geocode';
import { tacticalSignSchema, type TacticalSign } from './tactical';
import type { Unit } from './forces';

/** Verlauf einer Linie (Straße, Gewässer, Leitung), GeoJSON mit Koordinaten [Länge, Breite] */
export type GeoPath = { type: 'LineString'; coordinates: number[][] } | { type: 'MultiLineString'; coordinates: number[][][] };

export type MapObjectKind = 'point' | 'sign' | 'area' | 'line' | 'gauss' | 'sector' | 'aircraft' | 'ship';

export const MAP_OBJECT_LABELS: Record<MapObjectKind, string> = {
  point: 'Punkt',
  sign: 'Zeichen',
  area: 'Fläche',
  line: 'Linie',
  gauss: 'Gauß-Fahne',
  sector: 'Sektor 60°',
  aircraft: 'Flugzeug',
  ship: 'Schiff',
};

/** Beschriftung eines Kartenobjekts: keine, nur Name oder Name mit Angaben (Koordinate, Fläche, Radius, Länge) */
export const MAP_LABELS = ['off', 'name', 'details'] as const;
export type MapLabel = (typeof MAP_LABELS)[number];

/** Verfolgte Ziele: der Server setzt Position, Spur und letzten Stand */
export type TrackedKind = 'aircraft' | 'ship';
export const TRACKED_KINDS: MapObjectKind[] = ['aircraft', 'ship'];
export const isTracked = (kind: MapObjectKind): kind is TrackedKind => kind === 'aircraft' || kind === 'ship';
/** So viele Punkte behält die Spur (bei 10 s Abstand rund 20 Minuten) */
export const TRAIL_MAX_POINTS = 120;
/** Ohne neue Position gilt ein Ziel danach als verloren */
export const TRACK_LOST_MS = 3 * 60_000;

export interface TrackedData {
  /** ICAO-Adresse (Flugzeug) bzw. MMSI (Schiff) */
  id: string;
  /** Typ, Kennzeichen o. Ä. für die Liste */
  detail: string;
  /** Flugzeuge: ADS-B-Kategorie und ICAO-Typ für das Kartensymbol */
  category?: string | null;
  aircraftType?: string | null;
  /** Bisherige Positionen [lat, lon], älteste zuerst */
  trail: [number, number][];
  /** Letzter empfangener Stand */
  last: { at: string; altFt: number | null; onGround: boolean; speedKt: number | null; track: number | null } | null;
  /** Seit wann keine Position mehr kam (ISO); null = Signal da */
  lostSince: string | null;
}

/** Einstellungen einer Gauß-Fahne; Wind kommt immer aktuell von der Wetterstation */
export interface GaussSettings {
  stability: 'auto' | KlugManierClass;
  cloudOktas: number;
  terrain: Terrain;
  sourceHeightM: number;
  /** Optionale Freisetzungsrate in kg/s, nur für die Umrechnung in mg/m³ */
  releaseRateKgS: number | null;
}

export const DEFAULT_GAUSS: GaussSettings = { stability: 'auto', cloudOktas: 4, terrain: 'rural', sourceHeightM: 0, releaseRateKgS: null };

export const SECTOR_LENGTHS = [250, 500, 1000, 2000, 5000];

/** Wählbare Farben (lesbar auf hellen und dunklen Karten und im Druck); Gauß-Fahnen behalten ihre Stufenfarben */
export const MAP_OBJECT_COLORS = [
  { value: '#4ea1ff', label: 'Blau' },
  { value: '#e53935', label: 'Rot' },
  { value: '#f57c00', label: 'Orange' },
  { value: '#e3a008', label: 'Gelb' },
  { value: '#43a047', label: 'Grün' },
  { value: '#00acc1', label: 'Türkis' },
  { value: '#8e24aa', label: 'Violett' },
  { value: '#d81b60', label: 'Magenta' },
  { value: '#6d4c41', label: 'Braun' },
  { value: '#455a64', label: 'Grau' },
] as const;

/** Vorgabe je Objektart, solange keine eigene Farbe gewählt ist */
export const DEFAULT_OBJECT_COLORS: Record<MapObjectKind, string> = { point: '#4ea1ff', sign: '#e53935', area: '#4ea1ff', line: '#4ea1ff', gauss: '#e53935', sector: '#e3a008', aircraft: '#f57c00', ship: '#00acc1' };

export const COLORABLE_KINDS: MapObjectKind[] = ['point', 'area', 'line', 'sector', 'aircraft', 'ship'];

export const objectColor = (o: { kind: MapObjectKind; color: string | null }) => o.color ?? DEFAULT_OBJECT_COLORS[o.kind];

export interface MapObjectData {
  /** osm: übernommenes OSM-Objekt (Overpass, Ortssuche) */
  /** icon: Lucide-Name („Flame“), sonst Punkt (siehe mapIcons); badge: Schild am Symbol, z. B. „DN 100“ */
  point: { detail: string; osm?: string | null; icon?: string | null; badge?: string | null };
  /**
   * Lagezeichen nach DV 102: entweder fertiges Zeichen (sign = Kennung aus dv102.ts, „Gefahren/Gefahr_durch_Gas“) oder
   * Zeichen aus dem Zeichengenerator (tactical, alle Grundzeichen außer Fahrzeug)
   */
  sign: { detail: string; sign: string; tactical?: undefined } | { detail: string; tactical: TacticalSign; sign?: undefined };
  area: { detail: string; osm: string | null; outline: GeoOutline };
  line: { detail: string; osm: string | null; path: GeoPath };
  gauss: GaussSettings;
  sector: { sectorM: number };
  aircraft: TrackedData;
  ship: TrackedData;
}

interface MapObjectBase<K extends MapObjectKind> {
  id: number;
  incidentId: number;
  kind: K;
  name: string;
  /** Bezugspunkt: Fundort bzw. Quelle der Ausbreitung */
  lat: number;
  lon: number;
  visible: boolean;
  /** Beschriftung auf der Karte (verfolgte Ziele sind immer beschriftet) */
  label: MapLabel;
  /** Eigene Farbe (#rrggbb) oder null = Vorgabe der Objektart */
  color: string | null;
  data: MapObjectData[K];
  createdAt: string;
  createdBy: string;
}

export type MapObject = { [K in MapObjectKind]: MapObjectBase<K> }[MapObjectKind];

/** Lage der Karte zu einem Zeitpunkt (Zeitstrahl): Objekte, Kräfte und Einsatzort wie damals */
export interface MapHistoryState {
  at: string;
  incident: { lat: number | null; lon: number | null; vehicleVisible: boolean };
  objects: MapObject[];
  units: Unit[];
}

// --- Prüfung (Server) ---

const name = z.string().trim().min(1, 'Name fehlt').max(120);
/** Eigene Farbe (#rrggbb), null = Vorgabe der Objektart */
export const mapColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe im Format #rrggbb');
const ownColor = mapColorSchema.nullable().optional();
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const position = z.tuple([lon, lat]);
const ring = z.array(position).min(4).max(20_000);
const outline = z.union([
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(500) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1).max(500)).min(1).max(2_000) }),
]);
const path = z.array(position).min(2).max(20_000);
const geoPath = z.union([
  z.object({ type: z.literal('LineString'), coordinates: path }),
  z.object({ type: z.literal('MultiLineString'), coordinates: z.array(path).min(1).max(2_000) }),
]);
const osmRef = z.string().regex(/^[NWR]\d{1,12}$/).nullable();
/** Kennung eines Lagezeichens nach DV 102 („Kategorie/Name“); ob es das Zeichen gibt, prüft der Server */
const dv102Id = z.string().regex(/^[\p{L}]+\/[\p{L}\p{N}_]{1,80}$/u, 'Zeichen ungültig');
/** Grundzeichen, die das Kartenobjekt „Zeichen“ aus dem Generator nimmt – Fahrzeuge stehen als Kräfte auf der Karte */
export const SIGN_GENERATOR_BASES = ['unit', 'command', 'facility', 'person'] as const;
const generatorSign = tacticalSignSchema.extend({ base: z.enum(SIGN_GENERATOR_BASES).default('person') });
/** Name eines Lucide-Icons; ob es ihn gibt, prüft der Server */
export const mapIconNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]{0,60}$/, 'Symbol ungültig');
const gauss = z.object({
  stability: z.enum(['auto', 'I', 'II', 'III/1', 'III/2', 'IV', 'V']),
  cloudOktas: z.number().int().min(0).max(8),
  terrain: z.enum(['rural', 'urban']),
  sourceHeightM: z.number().min(0).max(200),
  releaseRateKgS: z.number().min(0).max(1e6).nullable(),
});
const sector = z.object({ sectorM: z.number().int().min(50).max(20_000) });
const detail = z.string().max(300).default('');
const tracked = (id: z.ZodString) =>
  z
    .object({ id, detail, category: z.string().max(4).nullable().optional(), aircraftType: z.string().max(8).nullable().optional() })
    .transform((d): TrackedData => ({ ...d, trail: [], last: null, lostSince: null }));

export const newMapObjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), name, lat, lon, color: ownColor, data: z.object({ detail, osm: osmRef.optional(), icon: mapIconNameSchema.nullable().optional(), badge: z.string().trim().max(40).nullable().optional() }) }),
  z.object({ kind: z.literal('sign'), name, lat, lon, data: z.union([z.object({ detail, sign: dv102Id }), z.object({ detail, tactical: generatorSign })]) }),
  z.object({ kind: z.literal('area'), name, lat, lon, color: ownColor, data: z.object({ detail, osm: osmRef, outline }) }),
  z.object({ kind: z.literal('line'), name, lat, lon, color: ownColor, data: z.object({ detail, osm: osmRef, path: geoPath }) }),
  z.object({ kind: z.literal('gauss'), name, lat, lon, data: gauss.default(DEFAULT_GAUSS) }),
  z.object({ kind: z.literal('sector'), name, lat, lon, data: sector.default({ sectorM: 1000 }) }),
  z.object({ kind: z.literal('aircraft'), name, lat, lon, data: tracked(z.string().regex(/^~?[0-9a-f]{6}$/, 'ICAO-Adresse ungültig')) }),
  z.object({ kind: z.literal('ship'), name, lat, lon, data: tracked(z.string().regex(/^\d{9}$/, 'MMSI ungültig')) }),
]);
/** Neues Objekt (Ausbreitungen ohne Daten bekommen die Vorgaben; verfolgte Ziele brauchen nur Kennung und Beschreibung; Farbe bei Punkten, Flächen und Linien) */
export type NewMapObject = {
  [K in MapObjectKind]: {
    kind: K;
    name: string;
    lat: number;
    lon: number;
    color?: string | null;
    data: K extends 'gauss' | 'sector' ? MapObjectData[K] | undefined : K extends TrackedKind ? { id: string; detail?: string; category?: string | null; aircraftType?: string | null } : MapObjectData[K];
  };
}[MapObjectKind];

/**
 * Änderungen: Name, Sichtbarkeit, Beschriftung, Lage, Farbe, Symbol (Punkte), Lagezeichen (Zeichen), Form (Umriss einer Fläche, Verlauf einer
 * Linie), Beschreibung (Punkte, Flächen, Linien) und je nach Art die Einstellungen (Teilmenge der Daten)
 */
export const mapObjectPatchSchema = z.object({
  name: name.optional(),
  visible: z.boolean().optional(),
  label: z.enum(MAP_LABELS).optional(),
  lat: lat.optional(),
  lon: lon.optional(),
  color: mapColorSchema.nullable().optional(),
  /** Symbol eines Punkts (null = einfacher Punkt) */
  icon: mapIconNameSchema.nullable().optional(),
  /** Lagezeichen eines Zeichens tauschen: fertiges Zeichen oder Zeichen aus dem Generator */
  sign: dv102Id.optional(),
  tactical: generatorSign.optional(),
  outline: outline.optional(),
  path: geoPath.optional(),
  detail: z.string().max(300).optional(),
  data: z.union([gauss.partial(), sector.partial()]).optional(),
});
export type MapObjectPatch = z.input<typeof mapObjectPatchSchema>;
