import {
  MAX_PRINT_ZOOM,
  MIN_PRINT_ZOOM,
  objectColor,
  printFrame,
  project,
  type MapObject,
  type MapPrintRequest,
  type MapSource,
  type Orientation,
  type PaperFormat,
} from '@elvis/shared';
import type { ReportData } from './collect.js';

const PAPER: PaperFormat = 'A4';
const ORIENTATION: Orientation = 'landscape';

/** Ring auf höchstens max Punkte ausdünnen */
function thin<T>(points: T[], max = 2000): T[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, i) => points[Math.floor(i * step)]!);
}

/** Mittelpunkt einer Fläche oder Linie (Mittel der Stützpunkte) für die Beschriftung */
function centroid(points: [number, number][]): [number, number] {
  const n = points.length || 1;
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
}

/** Kartenquelle für den Bericht: Druckstil, sonst die erste helle */
export function reportSource(sources: MapSource[]): MapSource | null {
  return sources.find((s) => s.variant === 'print') ?? sources.find((s) => s.variant !== 'dark') ?? sources[0] ?? null;
}

/** Größte Zoomstufe, bei der alle Punkte mit Rand auf die Seite passen */
function fit(points: [number, number][], maxZoom: number): { zoom: number; center: { lat: number; lon: number } } {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const north = Math.max(...lats);
  const south = Math.min(...lats);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  const center = { lat: (north + south) / 2, lon: (west + east) / 2 };
  const top = Math.min(maxZoom, 17, MAX_PRINT_ZOOM);
  for (let z = top; z > MIN_PRINT_ZOOM; z--) {
    const frame = printFrame(center, z, PAPER, ORIENTATION);
    const nw = project(north, west, z);
    const se = project(south, east, z);
    if (se.x - nw.x <= frame.widthPx * 0.85 && se.y - nw.y <= frame.heightPx * 0.85) return { zoom: z, center };
  }
  return { zoom: MIN_PRINT_ZOOM, center };
}

/**
 * Endstand der Lagekarte: Einsatzort, Kräfte mit Position und sichtbare Kartenobjekte. Ausbreitungen (Gauß, Sektor)
 * hängen vom damaligen Wind ab und erscheinen nur in der Objekttabelle; Overlays werden mitgedruckt.
 * null = nichts mit Position vorhanden.
 */
export function reportMapRequest(data: ReportData, source: MapSource): MapPrintRequest | null {
  const { incident } = data;
  const markers: MapPrintRequest['markers'] = [];
  const polygons: MapPrintRequest['polygons'] = [];
  const lines: NonNullable<MapPrintRequest['lines']> = [];
  const overlays: NonNullable<MapPrintRequest['overlays']> = [];
  const legend: MapPrintRequest['legend'] = [];
  const notes: string[] = [];
  const extent: [number, number][] = [];

  if (incident.lat !== null && incident.lon !== null) {
    markers.push({ kind: 'incident', lat: incident.lat, lon: incident.lon, label: incident.keyword || 'Einsatzort' });
    extent.push([incident.lat, incident.lon]);
  }
  for (const u of data.units) {
    if (u.lat === null || u.lon === null || !u.mapVisible || u.status === 'entlassen') continue;
    markers.push({ kind: 'unit', lat: u.lat, lon: u.lon, label: u.name.slice(0, 120), sign: u.sign });
    extent.push([u.lat, u.lon]);
  }
  for (const o of data.mapObjects.filter((x) => x.visible)) addObject(o);
  if (extent.length === 0) return null;

  const { zoom, center } = fit(extent, source.maxZoom);
  const skipped = data.mapObjects.filter((o) => o.visible && (o.kind === 'gauss' || o.kind === 'sector')).length;
  if (skipped) notes.push(`${skipped} Ausbreitung(en) nicht dargestellt (abhängig vom damaligen Wind) – siehe Kartenobjekte im Bericht.`);
  return {
    paper: PAPER,
    orientation: ORIENTATION,
    zoom,
    center,
    sourceId: source.id,
    title: 'Lagekarte – Endstand',
    subtitle: incident.location || undefined,
    markers,
    polygons,
    lines,
    overlays,
    legend,
    notes,
  };

  function addObject(o: MapObject): void {
    const color = objectColor(o);
    const label = (name: string) => (o.label === 'off' ? '' : name.slice(0, 120));
    switch (o.kind) {
      case 'point':
        markers.push({ kind: 'point', lat: o.lat, lon: o.lon, label: label(o.data.badge ? `${o.name} (${o.data.badge})` : o.name), color, ...(o.data.icon && { icon: o.data.icon }) });
        extent.push([o.lat, o.lon]);
        break;
      case 'sign':
        markers.push(
          o.data.tactical
            ? { kind: 'unit', lat: o.lat, lon: o.lon, sign: o.data.tactical, label: label(o.name) }
            : { kind: 'sign', lat: o.lat, lon: o.lon, symbol: o.data.sign, label: label(o.name) },
        );
        extent.push([o.lat, o.lon]);
        break;
      case 'area': {
        const outers = o.data.outline.type === 'Polygon' ? [o.data.outline.coordinates[0]!] : o.data.outline.coordinates.map((p) => p[0]!);
        for (const ring of outers) {
          const pts = thin(ring.map(([lon, lat]) => [lat!, lon!] as [number, number]));
          polygons.push({ points: pts, stroke: color, fill: color, fillOpacity: 0.08, dashed: true });
          extent.push(...pts);
          const [lat, lon] = centroid(pts);
          if (o.label !== 'off') markers.push({ kind: 'label', lat, lon, label: label(o.name) });
        }
        legend.push({ color, label: o.name });
        break;
      }
      case 'line': {
        const parts = o.data.path.type === 'LineString' ? [o.data.path.coordinates] : o.data.path.coordinates;
        for (const part of parts) {
          const pts = thin(part.map(([lon, lat]) => [lat!, lon!] as [number, number]));
          lines.push({ points: pts, color });
          extent.push(...pts);
        }
        legend.push({ color, label: o.name });
        break;
      }
      case 'overlay':
        overlays.push({ id: o.id, opacity: o.data.opacity, minZoom: o.data.minZoom, maxZoom: o.data.maxZoom });
        notes.push(`${o.name}: Seite ${o.data.page} aus „${o.data.filename}“, georeferenziert`);
        break;
      case 'aircraft':
      case 'ship':
        markers.push({ kind: 'point', lat: o.lat, lon: o.lon, label: o.name.slice(0, 120), color });
        break;
      default:
        break;
    }
  }
}
