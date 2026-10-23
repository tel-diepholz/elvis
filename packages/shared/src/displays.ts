import { z } from 'zod';

/**
 * Bildschirme: gekoppelte Anzeigegeräte (Kiosk-Browser, später Android-App), die /bildschirm anzeigen.
 * Den Inhalt bestimmt ein Raster mit Kacheln, das aus ELVIS ferngesteuert wird.
 */

export type DisplayTileType = 'map' | 'camera' | 'video' | 'weather' | 'clock' | 'alerts' | 'network' | 'text';

export interface DisplayTileTypeInfo {
  label: string;
  description: string;
  /** Größe beim Hinzufügen (in Rasterzellen) */
  size: { w: number; h: number };
}

export const DISPLAY_TILE_TYPES: Record<DisplayTileType, DisplayTileTypeInfo> = {
  map: { label: 'Lagekarte', description: 'Karte mit Fahrzeug und Einsatzort, per Touch verschieb- und zoombar', size: { w: 6, h: 6 } },
  camera: { label: 'Kamera', description: 'Livebild einer Kamera', size: { w: 4, h: 3 } },
  video: { label: 'Video (NDI)', description: 'Videostrom eines Gateways, z. B. NDI-Quelle über das Addon „NDI-Gateway“', size: { w: 4, h: 3 } },
  weather: { label: 'Wetter', description: 'Wind, Böen, Ausbreitungsrichtung, Temperatur', size: { w: 3, h: 3 } },
  clock: { label: 'Uhr', description: 'Datum-Zeit-Gruppe, Uhrzeit und Datum', size: { w: 3, h: 2 } },
  alerts: { label: 'Meldungen', description: 'Aktuelle Meldungen des Fahrzeugs', size: { w: 3, h: 3 } },
  network: { label: 'Netzwerk', description: 'Internetverbindung, Failover und SIM-Status des Routers', size: { w: 3, h: 2 } },
  text: { label: 'Freitext', description: 'Eigener Text, z. B. Hinweise oder Sammelplätze; Schrift passt sich der Kachel an', size: { w: 4, h: 2 } },
};

/** Höchstlänge des Freitexts */
export const DISPLAY_TEXT_MAX = 2000;

export const DISPLAY_TILE_IDS = Object.keys(DISPLAY_TILE_TYPES) as DisplayTileType[];

const tileConfigSchema = z.record(z.union([z.string().max(DISPLAY_TEXT_MAX), z.number(), z.boolean()]));

export const displayTileSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  type: z.enum(DISPLAY_TILE_IDS as [DisplayTileType, ...DisplayTileType[]]),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  config: tileConfigSchema.default({}),
});

export type DisplayTile = z.infer<typeof displayTileSchema>;

export const tilesOverlap = (a: Pick<DisplayTile, 'x' | 'y' | 'w' | 'h'>, b: Pick<DisplayTile, 'x' | 'y' | 'w' | 'h'>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const displayLayoutSchema = z
  .object({
    cols: z.number().int().min(2).max(24),
    rows: z.number().int().min(2).max(16),
    tiles: z.array(displayTileSchema).max(32),
  })
  .superRefine((l, ctx) => {
    l.tiles.forEach((t, i) => {
      if (t.x + t.w > l.cols || t.y + t.h > l.rows) ctx.addIssue({ code: 'custom', path: ['tiles', i], message: `Kachel „${DISPLAY_TILE_TYPES[t.type].label}“ ragt über das Raster hinaus` });
      for (let j = 0; j < i; j++) {
        if (tilesOverlap(t, l.tiles[j]!)) ctx.addIssue({ code: 'custom', path: ['tiles', i], message: `Kacheln „${DISPLAY_TILE_TYPES[l.tiles[j]!.type].label}“ und „${DISPLAY_TILE_TYPES[t.type].label}“ überlappen` });
      }
      if (new Set(l.tiles.map((x) => x.id)).size !== l.tiles.length) ctx.addIssue({ code: 'custom', path: ['tiles'], message: 'Kachel-IDs sind nicht eindeutig' });
    });
  });

export type DisplayLayout = z.infer<typeof displayLayoutSchema>;

export const EMPTY_DISPLAY_LAYOUT: DisplayLayout = { cols: 12, rows: 8, tiles: [] };

/** Erste freie Stelle für eine Kachel der Größe w×h (zeilenweise von links oben); null = kein Platz */
export function findFreeSpot(layout: DisplayLayout, w: number, h: number): { x: number; y: number } | null {
  for (let y = 0; y + h <= layout.rows; y++) {
    for (let x = 0; x + w <= layout.cols; x++) {
      if (!layout.tiles.some((t) => tilesOverlap(t, { x, y, w, h }))) return { x, y };
    }
  }
  return null;
}

/** Ausschnitt einer Kartenkachel */
export interface DisplayMapView {
  lat: number;
  lon: number;
  zoom: number;
}

export const displayMapViewSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  zoom: z.number().min(0).max(22),
});

export interface DisplayScreen {
  width: number;
  height: number;
}

/** Gespeicherte Anordnung eines Bildschirms */
export interface DisplayScene {
  id: number;
  name: string;
  /** Anzahl Kacheln (für die Anzeige) */
  tiles: number;
  updatedAt: string;
  updatedBy: string;
}

export interface DisplayDevice {
  id: string;
  name: string;
  layout: DisplayLayout;
  online: boolean;
  /** Fenstergröße, die der Bildschirm zuletzt gemeldet hat (für die Vorschau im richtigen Seitenverhältnis) */
  screen: DisplayScreen | null;
  userAgent: string;
  pairedAt: string;
  lastSeenAt: string | null;
  sort: number;
  scenes: DisplayScene[];
  /** Szene, deren Anordnung gerade angezeigt wird (null = geänderte oder ungespeicherte Anordnung) */
  activeSceneId: number | null;
  /** Aktueller Ausschnitt je Kartenkachel (Kachel-ID), soweit bekannt – nur im Speicher des Servers */
  mapViews: Record<string, DisplayMapView>;
}

/** Antwort auf GET /api/display/self – Sicht des Bildschirms auf sich selbst */
export type DisplaySelf = { state: 'unpaired' } | { state: 'pending'; code: string; expiresAt: string } | { state: 'paired'; display: DisplayDevice };

export type DisplayCommand = 'reload' | 'identify';
