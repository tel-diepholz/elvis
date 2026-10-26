/**
 * Kartenobjekte eines Einsatzes: übernommene Suchtreffer (Punkt oder Fläche mit Umriss), Ausbreitungen
 * (Gauß-Fahne, Sektor 60°) und verfolgte Flugzeuge bzw. Schiffe (Position kommt live vom Server). Sie gehören zum Einsatz, alle Arbeitsplätze und Bildschirme sehen sie, und sie
 * bleiben im Einsatzarchiv. Der Einsatzort selbst ist Teil des Einsatzes (lat/lon) und kein Kartenobjekt.
 */
import { z } from 'zod';
import type { KlugManierClass, Terrain } from './dispersion';
import type { GeoOutline } from './geocode';

export type MapObjectKind = 'point' | 'area' | 'gauss' | 'sector' | 'aircraft' | 'ship';

export const MAP_OBJECT_LABELS: Record<MapObjectKind, string> = {
  point: 'Punkt',
  area: 'Fläche',
  gauss: 'Gauß-Fahne',
  sector: 'Sektor 60°',
  aircraft: 'Flugzeug',
  ship: 'Schiff',
};

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
export const DEFAULT_OBJECT_COLORS: Record<MapObjectKind, string> = { point: '#4ea1ff', area: '#4ea1ff', gauss: '#e53935', sector: '#e3a008', aircraft: '#f57c00', ship: '#00acc1' };

export const COLORABLE_KINDS: MapObjectKind[] = ['point', 'area', 'sector', 'aircraft', 'ship'];

export const objectColor = (o: { kind: MapObjectKind; color: string | null }) => o.color ?? DEFAULT_OBJECT_COLORS[o.kind];

export interface MapObjectData {
  point: { detail: string };
  area: { detail: string; osm: string | null; outline: GeoOutline };
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
  /** Eigene Farbe (#rrggbb) oder null = Vorgabe der Objektart */
  color: string | null;
  data: MapObjectData[K];
  createdAt: string;
  createdBy: string;
}

export type MapObject = { [K in MapObjectKind]: MapObjectBase<K> }[MapObjectKind];

// --- Prüfung (Server) ---

const name = z.string().trim().min(1, 'Name fehlt').max(120);
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const position = z.tuple([lon, lat]);
const ring = z.array(position).min(4).max(20_000);
const outline = z.union([
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(500) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1).max(500)).min(1).max(2_000) }),
]);
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
  z.object({ id, detail }).transform((d): TrackedData => ({ ...d, trail: [], last: null, lostSince: null }));

export const newMapObjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), name, lat, lon, data: z.object({ detail }) }),
  z.object({ kind: z.literal('area'), name, lat, lon, data: z.object({ detail, osm: z.string().regex(/^[NWR]\d{1,12}$/).nullable(), outline }) }),
  z.object({ kind: z.literal('gauss'), name, lat, lon, data: gauss.default(DEFAULT_GAUSS) }),
  z.object({ kind: z.literal('sector'), name, lat, lon, data: sector.default({ sectorM: 1000 }) }),
  z.object({ kind: z.literal('aircraft'), name, lat, lon, data: tracked(z.string().regex(/^~?[0-9a-f]{6}$/, 'ICAO-Adresse ungültig')) }),
  z.object({ kind: z.literal('ship'), name, lat, lon, data: tracked(z.string().regex(/^\d{9}$/, 'MMSI ungültig')) }),
]);
/** Neues Objekt (Ausbreitungen ohne Daten bekommen die Vorgaben; verfolgte Ziele brauchen nur Kennung und Beschreibung) */
export type NewMapObject = {
  [K in MapObjectKind]: {
    kind: K;
    name: string;
    lat: number;
    lon: number;
    data: K extends 'gauss' | 'sector' ? MapObjectData[K] | undefined : K extends TrackedKind ? { id: string; detail?: string } : MapObjectData[K];
  };
}[MapObjectKind];

/** Änderungen: Name, Sichtbarkeit, Lage und je nach Art die Einstellungen (Teilmenge der Daten) */
export const mapObjectPatchSchema = z.object({
  name: name.optional(),
  visible: z.boolean().optional(),
  lat: lat.optional(),
  lon: lon.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe im Format #rrggbb').nullable().optional(),
  data: z.union([gauss.partial(), sector.partial()]).optional(),
});
export type MapObjectPatch = z.input<typeof mapObjectPatchSchema>;
