import { useEffect, useRef, useState } from 'react';
import { CircleMarker, Marker, Polygon, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { DEFAULT_OBJECT_COLORS, type MapObject, type MapObjectPatch, type NewMapObject } from '@elvis/shared';
import { destination, fmtDistance } from '../../components/map/dispersion';

/**
 * Formen zeichnen (Menü „Objekte“): Fläche und Linie aus beliebig vielen Eckpunkten, Rechteck aus zwei Ecken, Kreis aus
 * Mitte und Rand. Gespeichert werden sie als Fläche bzw. Linie ohne OSM-Bezug, der Kreis als Vieleck.
 */
export type ShapeKind = 'polygon' | 'line' | 'rectangle' | 'circle';
export type Drawing = { kind: ShapeKind; points: [number, number][] };

export const SHAPE_LABELS: Record<ShapeKind, string> = { polygon: 'Fläche', line: 'Linie', rectangle: 'Rechteck', circle: 'Kreis' };

/** Rechteck und Kreis sind nach zwei Punkten fertig, Fläche und Linie erst auf „Fertig“ */
const FIXED_POINTS: Partial<Record<ShapeKind, number>> = { rectangle: 2, circle: 2 };
const MIN_POINTS: Record<ShapeKind, number> = { polygon: 3, line: 2, rectangle: 2, circle: 2 };

export const canFinish = (d: Drawing) => d.points.length >= MIN_POINTS[d.kind];
export const isComplete = (d: Drawing) => d.points.length === FIXED_POINTS[d.kind];

/** Hinweis in der Leiste über der Karte */
export function drawHint(d: Drawing): string {
  const n = d.points.length;
  switch (d.kind) {
    case 'polygon':
      return n < 3 ? `Eckpunkte tippen (${n}/3)` : `${n} Eckpunkte – ersten Punkt tippen schließt`;
    case 'line':
      return n < 2 ? `Punkte tippen (${n}/2)` : `${n} Punkte – letzten Punkt tippen beendet`;
    case 'rectangle':
      return n ? 'gegenüberliegende Ecke tippen' : 'erste Ecke tippen';
    case 'circle':
      return n ? 'Rand tippen' : 'Mitte tippen';
  }
}

const distance = (a: [number, number], b: [number, number]) => L.latLng(a).distanceTo(L.latLng(b));

function rectangle([a, b]: [number, number][]): [number, number][] {
  return [a!, [a![0], b![1]], b!, [b![0], a![1]]];
}

function circle(center: [number, number], meters: number): [number, number][] {
  return Array.from({ length: 64 }, (_, i) => destination(center[0], center[1], (i * 360) / 64, meters));
}

/** Eckpunkte für Vorschau und Speichern (offen, [Breite, Länge]) */
function outline(kind: ShapeKind, points: [number, number][]): [number, number][] {
  if (kind === 'rectangle' && points.length === 2) return rectangle(points);
  if (kind === 'circle' && points.length === 2) return circle(points[0]!, distance(points[0]!, points[1]!));
  return points;
}

/** Fertige Form als neues Kartenobjekt; Bezugspunkt ist die Mitte (beim Kreis der Mittelpunkt) */
export function shapeObject(d: Drawing): NewMapObject {
  const ring = outline(d.kind, d.points);
  const coords = ring.map(([lat, lon]) => [lon, lat]);
  const center = L.latLngBounds(ring).getCenter();
  const [lat, lon] = d.kind === 'circle' ? d.points[0]! : [center.lat, center.lng];
  const name = SHAPE_LABELS[d.kind];
  if (d.kind === 'line') return { kind: 'line', name, lat, lon, data: { detail: '', osm: null, path: { type: 'LineString', coordinates: coords } } };
  const detail = d.kind === 'circle' ? `Radius ${fmtDistance(distance(d.points[0]!, d.points[1]!))}` : '';
  return { kind: 'area', name, lat, lon, data: { detail, osm: null, outline: { type: 'Polygon', coordinates: [[...coords, coords[0]!]] } } };
}

const PREVIEW = { color: DEFAULT_OBJECT_COLORS.area, weight: 3, dashArray: '6 6', fillOpacity: 0.08, interactive: false };

/**
 * Vorschau und Eingabe im MapContainer: Tippen setzt Punkte, die Maus zeigt, wie die Form weiterginge. Tippen auf den
 * ersten Punkt (Fläche) bzw. letzten Punkt (Linie) schließt ab. Doppelklick-Zoom ist so lange aus.
 */
export function DrawLayer({ drawing, onPoint, onFinish }: { drawing: Drawing; onPoint: (p: [number, number]) => void; onFinish: () => void }) {
  const map = useMap();
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  useMapEvents({
    click: (e) => onPoint([e.latlng.lat, e.latlng.lng]),
    mousemove: (e) => setCursor([e.latlng.lat, e.latlng.lng]),
    mouseout: () => setCursor(null),
  });
  useEffect(() => {
    map.doubleClickZoom.disable();
    return () => void map.doubleClickZoom.enable();
  }, [map]);

  const { kind, points } = drawing;
  const shape = outline(kind, cursor && points.length && !isComplete(drawing) ? [...points, cursor] : points);
  const closer = kind === 'polygon' && points.length >= 3 ? 0 : kind === 'line' && points.length >= 2 ? points.length - 1 : null;
  return (
    <>
      {shape.length > 1 && (kind === 'line' ? <Polyline positions={shape} pathOptions={PREVIEW} /> : <Polygon positions={shape} pathOptions={PREVIEW} />)}
      {kind === 'circle' && points.length === 1 && cursor && <Polyline positions={[points[0]!, cursor]} pathOptions={{ ...PREVIEW, weight: 1 }} />}
      {points.map((p, i) => (
        <CircleMarker
          // Klickverhalten gilt nur beim Anlegen – der schließende Punkt bekommt darum einen eigenen Schlüssel
          key={`${i}:${i === closer}`}
          center={p}
          radius={i === closer ? 7 : 4}
          pathOptions={{ color: DEFAULT_OBJECT_COLORS.area, weight: 2, fillColor: '#fff', fillOpacity: 1 }}
          bubblingMouseEvents={i !== closer}
          eventHandlers={i === closer ? { click: onFinish } : undefined}
        />
      ))}
    </>
  );
}

// --- Formen bearbeiten (gezeichnete Flächen und Linien, Kreise über Mitte und Radius) ---

export type ShapeEdit =
  | { id: number; kind: 'polygon' | 'line'; points: [number, number][]; selected: number | null }
  | { id: number; kind: 'circle'; center: [number, number]; radiusM: number };

/** Gezeichnete Kreise tragen ihren Radius in der Beschreibung */
const isCircle = (o: MapObject) => o.kind === 'area' && o.data.detail.startsWith('Radius ');

/** Bearbeitbar sind selbst gezeichnete Formen; übernommene OSM-Umrisse haben oft Tausende Punkte und mehrere Teile */
export function isEditable(o: MapObject): boolean {
  if (o.kind === 'area') return !o.data.osm && o.data.outline.type === 'Polygon' && o.data.outline.coordinates.length === 1;
  if (o.kind === 'line') return !o.data.osm && o.data.path.type === 'LineString';
  return false;
}

export function startEdit(o: MapObject): ShapeEdit | null {
  if (!isEditable(o)) return null;
  if (o.kind === 'area' && o.data.outline.type === 'Polygon') {
    const ring = o.data.outline.coordinates[0]!.map(([lon, lat]) => [lat!, lon!] as [number, number]);
    if (isCircle(o)) return { id: o.id, kind: 'circle', center: [o.lat, o.lon], radiusM: distance([o.lat, o.lon], ring[0]!) };
    return { id: o.id, kind: 'polygon', points: ring.slice(0, -1), selected: null };
  }
  if (o.kind === 'line' && o.data.path.type === 'LineString') return { id: o.id, kind: 'line', points: o.data.path.coordinates.map(([lon, lat]) => [lat!, lon!] as [number, number]), selected: null };
  return null;
}

/** Eckpunkte fürs Speichern und die Vorschau ([Breite, Länge], Ring offen) */
const editOutline = (e: ShapeEdit) => (e.kind === 'circle' ? circle(e.center, e.radiusM) : e.points);

/** Änderung am Kartenobjekt: Form, Bezugspunkt (Mitte) und beim Kreis die Beschreibung mit dem Radius */
export function editPatch(e: ShapeEdit): MapObjectPatch {
  const ring = editOutline(e);
  const coords = ring.map(([lat, lon]) => [lon, lat] as [number, number]);
  const c = L.latLngBounds(ring).getCenter();
  const [lat, lon] = e.kind === 'circle' ? e.center : [c.lat, c.lng];
  if (e.kind === 'line') return { lat, lon, path: { type: 'LineString', coordinates: coords } };
  return { lat, lon, outline: { type: 'Polygon', coordinates: [[...coords, coords[0]!]] }, ...(e.kind === 'circle' && { detail: `Radius ${fmtDistance(e.radiusM)}` }) };
}

/** Ausgewählter Punkt lässt sich entfernen, solange die Form gültig bleibt (Fläche ≥ 3, Linie ≥ 2 Punkte) */
export const canRemovePoint = (e: ShapeEdit) => e.kind !== 'circle' && e.selected !== null && e.points.length > (e.kind === 'polygon' ? 3 : 2);
export const removePoint = (e: ShapeEdit): ShapeEdit => (e.kind !== 'circle' && canRemovePoint(e) ? { ...e, points: e.points.filter((_, i) => i !== e.selected), selected: null } : e);

export function editHint(e: ShapeEdit): string {
  if (e.kind === 'circle') return 'Mitte verschieben, Randpunkt ändert den Radius';
  return e.selected === null ? 'Ecken ziehen, Zwischenpunkte fügen Ecken ein' : 'Ecke gewählt';
}

const handle = (cls: string, size: number) => L.divIcon({ className: `map-edit-handle ${cls}`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
const HANDLES = { vertex: handle('vertex', 14), selected: handle('vertex selected', 14), mid: handle('mid', 10), move: handle('move', 22) };
const EDIT_STYLE = { color: DEFAULT_OBJECT_COLORS.area, weight: 3, fillOpacity: 0.12, interactive: false };

/** Griff zum Verschieben der ganzen Form: verschiebt alle Punkte um die Bewegung seit dem letzten Ereignis */
function MoveHandle({ at, onMove }: { at: [number, number]; onMove: (dLat: number, dLon: number) => void }) {
  const last = useRef<L.LatLng | null>(null);
  return (
    <Marker
      position={at}
      icon={HANDLES.move}
      draggable
      title="Form verschieben"
      eventHandlers={{
        dragstart: (ev) => void (last.current = (ev.target as L.Marker).getLatLng()),
        drag: (ev) => {
          const p = (ev.target as L.Marker).getLatLng();
          if (last.current) onMove(p.lat - last.current.lat, p.lng - last.current.lng);
          last.current = p;
        },
      }}
    />
  );
}

/** Bearbeitung im MapContainer: Vorschau der Form mit Griffen; Doppelklick-Zoom ist so lange aus */
export function EditLayer({ edit, onChange }: { edit: ShapeEdit; onChange: (e: ShapeEdit) => void }) {
  const map = useMap();
  useEffect(() => {
    map.doubleClickZoom.disable();
    return () => void map.doubleClickZoom.enable();
  }, [map]);
  const latLng = (ev: L.LeafletEvent) => {
    const p = (ev.target as L.Marker).getLatLng();
    return [p.lat, p.lng] as [number, number];
  };

  if (edit.kind === 'circle') {
    const edge = destination(edit.center[0], edit.center[1], 90, edit.radiusM);
    return (
      <>
        <Polygon positions={circle(edit.center, edit.radiusM)} pathOptions={EDIT_STYLE} />
        <MoveHandle at={edit.center} onMove={(dLat, dLon) => onChange({ ...edit, center: [edit.center[0] + dLat, edit.center[1] + dLon] })} />
        <Marker position={edge} icon={HANDLES.vertex} draggable title="Radius ändern" eventHandlers={{ drag: (ev) => onChange({ ...edit, radiusM: Math.max(5, distance(edit.center, latLng(ev))) }) }} />
      </>
    );
  }

  const { points } = edit;
  const closed = edit.kind === 'polygon';
  const segments = closed ? points.length : points.length - 1;
  const set = (i: number, p: [number, number]) => onChange({ ...edit, points: points.map((q, j) => (j === i ? p : q)) });
  const insert = (i: number, p: [number, number]) => onChange({ ...edit, points: [...points.slice(0, i + 1), p, ...points.slice(i + 1)], selected: i + 1 });
  const c = L.latLngBounds(points).getCenter();
  return (
    <>
      {closed ? <Polygon positions={points} pathOptions={EDIT_STYLE} /> : <Polyline positions={points} pathOptions={EDIT_STYLE} />}
      {Array.from({ length: segments }, (_, i) => {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        return (
          <Marker
            key={`mid-${i}-${points.length}`}
            position={mid}
            icon={HANDLES.mid}
            draggable
            title="Ecke einfügen"
            eventHandlers={{ click: () => insert(i, mid), dragend: (ev) => insert(i, latLng(ev)) }}
          />
        );
      })}
      {points.map((p, i) => (
        <Marker
          key={`v-${i}`}
          position={p}
          icon={edit.selected === i ? HANDLES.selected : HANDLES.vertex}
          draggable
          eventHandlers={{ drag: (ev) => set(i, latLng(ev)), click: () => onChange({ ...edit, selected: edit.selected === i ? null : i }) }}
        />
      ))}
      <MoveHandle at={[c.lat, c.lng]} onMove={(dLat, dLon) => onChange({ ...edit, points: points.map(([la, lo]) => [la + dLat, lo + dLon]) })} />
    </>
  );
}
