import { z } from 'zod';
import { DISPLAY_TEXT_MAX, DISPLAY_TILE_TYPES, tilesOverlap, type DisplayTileType, type DisplayTileTypeInfo } from './displays';

/**
 * Übersicht: jeder Benutzer ordnet seine Kacheln selbst in einem Raster mit 12 Spalten an (Zeilen fester Höhe, die
 * Seite wächst nach unten). Die Anordnung gehört zum Benutzer, nicht zum Einsatz, und bleibt beim Abschluss erhalten.
 * Viele Kacheln teilt sich die Übersicht mit den Bildschirmen; „Szenenwahl“ gibt es nur dort.
 */

export type DashboardTileType = Exclude<DisplayTileType, 'scenes'> | 'incident' | 'journal' | 'radio' | 'energy' | 'monitoring' | 'messages';

export interface DashboardTileTypeInfo extends DisplayTileTypeInfo {
  /** Inhalt nur für angemeldete Benutzer (Einsatzdaten) */
  requiresLogin?: boolean;
}

/** Kachel der Bildschirme mit eigener Startgröße für die Übersicht (Zeilen sind niedriger als auf einem Bildschirm) */
const fromDisplay = (type: Exclude<DisplayTileType, 'scenes'>, w: number, h: number, extra: Partial<DashboardTileTypeInfo> = {}): DashboardTileTypeInfo => ({
  ...DISPLAY_TILE_TYPES[type],
  size: { w, h },
  ...extra,
});

export const DASHBOARD_TILE_TYPES: Record<DashboardTileType, DashboardTileTypeInfo> = {
  incident: { label: 'Laufender Einsatz', description: 'Stichwort, Einsatzort, Einsatzdauer und Stärke der Kräfte', size: { w: 8, h: 3 }, requiresLogin: true },
  journal: { label: 'Einsatztagebuch', description: 'Letzte Einträge im Einsatztagebuch', size: { w: 8, h: 4 }, requiresLogin: true },
  messages: { label: 'Meldungen im Einsatz', description: 'Meldungen, bei denen Sie gerade etwas tun müssen', size: { w: 4, h: 4 }, requiresLogin: true },
  tasks: fromDisplay('tasks', 4, 5, { requiresLogin: true }),
  forces: fromDisplay('forces', 6, 6, { requiresLogin: true }),
  map: fromDisplay('map', 6, 6),
  weather: fromDisplay('weather', 4, 3),
  forecast: fromDisplay('forecast', 8, 4),
  clock: fromDisplay('clock', 4, 3),
  alerts: fromDisplay('alerts', 4, 4, { label: 'Fahrzeugmeldungen' }),
  radio: { label: 'Funk', description: 'Funkgeräte, Erreichbarkeit und aktueller Funkverkehr', size: { w: 4, h: 3 } },
  network: fromDisplay('network', 4, 3),
  energy: { label: 'Energie', description: 'Batterien und Ladegeräte (Victron über Bluetooth)', size: { w: 4, h: 3 } },
  monitoring: { label: 'Monitoring', description: 'Erreichbarkeit der überwachten Systeme', size: { w: 4, h: 3 } },
  camera: fromDisplay('camera', 4, 4),
  video: fromDisplay('video', 4, 4),
  text: fromDisplay('text', 4, 2),
  image: fromDisplay('image', 4, 4, { requiresLogin: true }),
  guestWifi: fromDisplay('guestWifi', 4, 4, { requiresLogin: true }),
};

export const DASHBOARD_TILE_IDS = Object.keys(DASHBOARD_TILE_TYPES) as DashboardTileType[];

/** Spalten des Rasters; auf schmalen Bildschirmen werden die Kacheln untereinander gezeigt */
export const DASHBOARD_COLS = 12;
/** Höchste Zeile (Unterkante), damit eine Anordnung nicht beliebig wächst */
export const DASHBOARD_MAX_ROWS = 80;

export const dashboardTileSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  type: z.enum(DASHBOARD_TILE_IDS as [DashboardTileType, ...DashboardTileType[]]),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  config: z.record(z.union([z.string().max(DISPLAY_TEXT_MAX), z.number(), z.boolean()])).default({}),
});

export type DashboardTile = z.infer<typeof dashboardTileSchema>;

export const dashboardLayoutSchema = z
  .object({ tiles: z.array(dashboardTileSchema).max(40) })
  .superRefine((l, ctx) => {
    if (new Set(l.tiles.map((t) => t.id)).size !== l.tiles.length) ctx.addIssue({ code: 'custom', path: ['tiles'], message: 'Kachel-IDs sind nicht eindeutig' });
    l.tiles.forEach((t, i) => {
      const label = DASHBOARD_TILE_TYPES[t.type].label;
      if (t.x + t.w > DASHBOARD_COLS || t.y + t.h > DASHBOARD_MAX_ROWS) ctx.addIssue({ code: 'custom', path: ['tiles', i], message: `Kachel „${label}“ ragt über das Raster hinaus` });
      for (let j = 0; j < i; j++) {
        if (tilesOverlap(t, l.tiles[j]!)) ctx.addIssue({ code: 'custom', path: ['tiles', i], message: `Kacheln „${DASHBOARD_TILE_TYPES[l.tiles[j]!.type].label}“ und „${label}“ überlappen` });
      }
    });
  });

export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** Anordnung des Benutzers; custom = selbst angepasst (sonst die Grundeinstellung) */
export interface DashboardResponse {
  layout: DashboardLayout;
  custom: boolean;
  updatedAt: string | null;
}

/** Grundeinstellung – auch für anonyme Arbeitsplätze */
export const DEFAULT_DASHBOARD: DashboardLayout = {
  tiles: [
    { id: 'incident', type: 'incident', x: 0, y: 0, w: 8, h: 3, config: {} },
    { id: 'clock', type: 'clock', x: 8, y: 0, w: 4, h: 3, config: {} },
    { id: 'journal', type: 'journal', x: 0, y: 3, w: 8, h: 4, config: {} },
    { id: 'alerts', type: 'alerts', x: 8, y: 3, w: 4, h: 4, config: {} },
    { id: 'weather', type: 'weather', x: 0, y: 7, w: 4, h: 3, config: {} },
    { id: 'radio', type: 'radio', x: 4, y: 7, w: 4, h: 3, config: {} },
    { id: 'network', type: 'network', x: 8, y: 7, w: 4, h: 3, config: {} },
  ],
};

type Box = Pick<DashboardTile, 'x' | 'y' | 'w' | 'h'>;

/** Unterkante der Anordnung (Anzahl belegter Zeilen) */
export const dashboardRows = (tiles: Box[]) => tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);

/**
 * Kachel `id` an `box` setzen; überlappte Kacheln rutschen nach unten (wie beim Einsortieren), bis nichts mehr
 * überlappt. Die gesetzte Kachel bleibt, wo sie ist.
 */
export function placeDashboardTile<T extends DashboardTile>(tiles: T[], id: string, box: Box): T[] {
  const moved = tiles.map((t) => (t.id === id ? { ...t, ...box } : { ...t }));
  const fixed: T[] = [moved.find((t) => t.id === id)!];
  const rest = moved.filter((t) => t.id !== id).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const t of rest) {
    while (fixed.some((f) => tilesOverlap(f, t))) {
      const blocker = fixed.filter((f) => tilesOverlap(f, t));
      t.y = Math.max(...blocker.map((f) => f.y + f.h));
    }
    fixed.push(t);
  }
  return moved;
}

/** Leere Zeilen oberhalb der Kacheln schließen (jede Kachel so weit nach oben, wie es geht) */
export function compactDashboard<T extends DashboardTile>(tiles: T[]): T[] {
  const out: T[] = [];
  for (const t of [...tiles].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const c = { ...t };
    while (c.y > 0 && !out.some((o) => tilesOverlap(o, { ...c, y: c.y - 1 }))) c.y--;
    out.push(c);
  }
  return tiles.map((t) => out.find((o) => o.id === t.id)!);
}

/** Erste freie Stelle für w×h (zeilenweise), notfalls unter allen Kacheln */
export function findDashboardSpot(tiles: Box[], w: number, h: number): { x: number; y: number } {
  const rows = dashboardRows(tiles);
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x + w <= DASHBOARD_COLS; x++) {
      if (!tiles.some((t) => tilesOverlap(t, { x, y, w, h }))) return { x, y };
    }
  }
  return { x: 0, y: rows };
}
