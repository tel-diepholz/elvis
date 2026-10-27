import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polygon, Rectangle, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { useMutation } from '@tanstack/react-query';
import { FileDown, Printer } from 'lucide-react';
import {
  DEFAULT_VEHICLE_SIGN,
  KLUG_MANIER,
  MAX_PRINT_ZOOM,
  MIN_PRINT_ZOOM,
  TERRAIN_LABELS,
  TILE_SIZE,
  niceScale,
  printFrame,
  formatAltitude,
  isTracked,
  MAP_OBJECT_LABELS,
  type Incident,
  objectColor,
  type MapLabel,
  type MapObject,
  type MapPrintRequest,
  type MapSource,
  type Orientation,
  type PaperFormat,
  type Unit,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { PrinterSettings, downloadBlob, mediaFor, usePrintForm, usePrintStatus } from '../../components/print/PrinterSettings';
import { compass, fmtDtg, fmtNum, fmtTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { useSettings } from '../../lib/hooks';
import { tacticalIcon } from '../../components/tactical/TacticalSign';
import { Field, Segmented, Toggle } from '../../components/ui';
import { computePlume, dispersionSector, fmtDistance, fmtExp, type Wind } from '../../components/map/dispersion';
import { LabelToggle, MapObjectsLayer, labelPlace, labelSub } from '../../components/map/objects';
import { UnitsLayer, placedUnits } from '../../components/map/units';

const incidentIcon = L.divIcon({ className: 'map-marker incident', html: '<span>!</span>', iconSize: [30, 30], iconAnchor: [15, 15] });

type LatLon = { lat: number; lon: number };

export interface PrintDialogProps {
  sources: MapSource[];
  initialSourceId: string;
  initialCenter: LatLon;
  initialZoom: number;
  /** null, solange kein Fahrzeugstandort (GPS) bekannt ist. */
  vehicle: (LatLon & { name: string }) | null;
  incident: Incident | null;
  /** Kartenobjekte des Einsatzes; vorgewählt sind die sichtbaren mit ihrer Beschriftung, im Dialog einzeln änderbar */
  objects: MapObject[];
  /** Kräfte des Einsatzes; gedruckt werden die gesetzten und eingeblendeten */
  units: Unit[];
  /** Wind für Ausbreitung und Hinweis (nur wenn Geschwindigkeit und Richtung bekannt sind). */
  wind: Wind | undefined;
  weatherGustMs: number | null;
  onDone: () => void;
}

/** Ring auf höchstens max Punkte ausdünnen (Druckanfrage begrenzt die Punkte je Fläche) */
function thin<T>(points: T[], max = 2000): T[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, i) => points[Math.floor(i * step)]!);
}

/** Beschriftung im Druck (eine Zeile, höchstens 120 Zeichen) */
function printLabel(o: MapObject, name: string): string {
  return (o.label === 'details' ? `${name} · ${labelSub(o)}` : name).slice(0, 120);
}

/** Sichtbare Kartenobjekte als Markierungen, Flächen, Legende und Hinweise für den PDF-Druck */
function objectsForPrint(objects: MapObject[], weather: Wind | undefined, now: Date) {
  const markers: MapPrintRequest['markers'] = [];
  const polygons: MapPrintRequest['polygons'] = [];
  const lines: NonNullable<MapPrintRequest['lines']> = [];
  const legend: MapPrintRequest['legend'] = [];
  const notes: string[] = [];
  for (const o of objects.filter((x) => x.visible)) {
    const color = objectColor(o);
    if (o.kind === 'point') {
      const label = o.label === 'off' ? '' : printLabel(o, o.data.badge ? `${o.name} (${o.data.badge})` : o.name);
      markers.push({ kind: 'point', lat: o.lat, lon: o.lon, label, color, ...(o.data.icon && { icon: o.data.icon }) });
    }
    if (o.kind === 'sign') {
      const label = o.label === 'off' ? '' : printLabel(o, o.name);
      // Personen aus dem Generator druckt der Server wie die Kräfte
      markers.push(o.data.tactical ? { kind: 'unit', lat: o.lat, lon: o.lon, sign: o.data.tactical, label } : { kind: 'sign', lat: o.lat, lon: o.lon, symbol: o.data.sign, label });
    }
    // Flächen, Linien und Ausbreitungen: Beschriftung als Text an derselben Stelle wie auf der Karte
    if (o.label !== 'off' && o.kind !== 'point' && o.kind !== 'sign' && !isTracked(o.kind)) {
      const [lat, lon] = labelPlace(o).pos;
      markers.push({ kind: 'label', lat, lon, label: printLabel(o, o.name) });
    }
    if (o.kind === 'aircraft' || o.kind === 'ship') {
      const { last, lostSince } = o.data;
      const extra = lostSince ? `kein Signal seit ${fmtTime(lostSince)}` : last ? [o.kind === 'aircraft' ? formatAltitude(last.altFt, last.onGround) : null, `Stand ${fmtTime(last.at)}`].filter(Boolean).join(', ') : null;
      markers.push({ kind: 'point', lat: o.lat, lon: o.lon, label: extra ? `${o.name} (${extra})` : o.name, color });
    }
    if (o.kind === 'area') {
      const outers = o.data.outline.type === 'Polygon' ? [o.data.outline.coordinates[0]!] : o.data.outline.coordinates.map((p) => p[0]!);
      for (const ring of outers) polygons.push({ points: thin(ring.map(([lon, lat]) => [lat!, lon!] as [number, number])), stroke: color, fill: color, fillOpacity: 0.08, dashed: true });
      legend.push({ color, label: o.name });
    }
    if (o.kind === 'line') {
      const parts = o.data.path.type === 'LineString' ? [o.data.path.coordinates] : o.data.path.coordinates;
      for (const part of parts) lines.push({ points: thin(part.map(([lon, lat]) => [lat!, lon!] as [number, number])), color });
      legend.push({ color, label: o.name });
    }
    if (o.kind === 'sector' && weather) {
      polygons.push({ points: dispersionSector(o.lat, o.lon, weather.windDirectionDeg, o.data.sectorM), stroke: color, fill: color, fillOpacity: 0.22, dashed: true });
      legend.push({ color, label: `${o.name}: Schemasektor 60° in Windrichtung (${fmtDistance(o.data.sectorM)})` });
    }
    if (o.kind === 'gauss') {
      const plume = computePlume(o.data, o, weather, now);
      if (!plume) continue;
      for (const { level, polygon } of plume.contours) {
        polygons.push({ points: polygon, stroke: level.path.color, fill: level.path.fillColor, fillOpacity: level.path.fillOpacity, dashed: 'dashArray' in level.path });
      }
      const rate = o.data.releaseRateKgS;
      for (const { level, contour } of plume.contours.slice().reverse()) {
        const value = rate ? `${fmtNum(level.threshold * rate * 1e6, 0)} mg/m³` : `${fmtExp(level.threshold)} s/m³`;
        legend.push({ color: level.path.color, label: `${o.name}: ${level.label} ≥ ${value} – bis ${contour.truncated ? '> ' : ''}${fmtDistance(contour.maxDistanceM)}` });
      }
      notes.push(
        `${o.name}: Gauß-Fahne, Klasse ${plume.stability} (${KLUG_MANIER[plume.stability].label}), ${TERRAIN_LABELS[o.data.terrain]}, Quellhöhe ${o.data.sourceHeightM} m${rate ? `, Freisetzung ${fmtNum(rate, 2)} kg/s` : ''}. Nur Orientierung – keine Grundlage für Grenzwertentscheidungen.`,
      );
    }
  }
  return { markers, polygons, lines, legend, notes };
}

/** Hält den Druckmittelpunkt in der Mitte der Vorschaukarte – der Rahmen bleibt stehen, die Karte wird verschoben. */
function CenterSync({ onCenter }: { onCenter: (c: LatLon) => void }) {
  const map = useMapEvents({
    move: () => {
      const c = map.getCenter();
      onCenter({ lat: c.lat, lon: c.lng });
    },
  });
  return null;
}

/**
 * Mausrad ändert die Zoomstufe des Ausdrucks statt der Vorschau (die Vorschau passt sich über FitFrame an). Kleine
 * Schritte (Touchpad) werden gesammelt, bis sie einer Rastung entsprechen.
 */
function WheelPrintZoom({ onStep }: { onStep: (delta: 1 | -1) => void }) {
  const map = useMap();
  const step = useRef(onStep);
  step.current = onStep;
  useEffect(() => {
    const el = map.getContainer();
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      acc += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(acc) < 100) return;
      step.current(acc < 0 ? 1 : -1);
      acc = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [map]);
  return null;
}

/** Passt die Vorschau an, wenn sich Format, Ausrichtung oder Zoomstufe ändern. */
function FitFrame({ bounds, deps }: { bounds: L.LatLngBoundsExpression; deps: unknown[] }) {
  const map = useMap();
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  useEffect(() => {
    // Der Dialog ist beim ersten Rendern noch nicht vermessen.
    const t = setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(boundsRef.current, { padding: [24, 24], animate: false });
    }, 60);
    return () => clearTimeout(t);
  }, deps);
  return null;
}

export function PrintDialog(props: PrintDialogProps) {
  const { sources, vehicle, incident, objects, wind: weather, weatherGustMs } = props;
  const mapSign = useSettings().data?.mapSign ?? DEFAULT_VEHICLE_SIGN;
  const vehicleIcon = useMemo(() => tacticalIcon(mapSign, 36), [mapSign]);
  const toast = useToast();
  const [paper, setPaper] = useState<PaperFormat>('A3');
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  const [sourceId, setSourceId] = useState(props.initialSourceId);
  const source = sources.find((s) => s.id === sourceId) ?? sources[0]!;
  const maxZoom = Math.min(MAX_PRINT_ZOOM, source.maxZoom);
  const [zoom, setZoom] = useState(Math.min(maxZoom, Math.max(MIN_PRINT_ZOOM, Math.round(props.initialZoom))));
  const [center, setCenter] = useState<LatLon>(props.initialCenter);
  const [title, setTitle] = useState(incident ? [incident.keyword, incident.title].filter(Boolean).join(' · ') : 'Lagekarte');
  const hasIncidentPos = incident?.lat != null && incident.lon != null;
  const visibleObjects = objects.filter((o) => o.visible);
  // Auswahl und Beschriftung nur für diesen Druck – die Karte und ihre Objekte bleiben unverändert
  const [choice, setChoice] = useState<Record<number, { show: boolean; label: MapLabel }>>({});
  const choiceOf = (o: MapObject) => choice[o.id] ?? { show: o.visible, label: o.label };
  const choose = (o: MapObject, c: Partial<{ show: boolean; label: MapLabel }>) => setChoice((all) => ({ ...all, [o.id]: { ...choiceOf(o), ...c } }));
  const printObjects = objects.map((o) => ({ ...o, visible: choiceOf(o).show, label: choiceOf(o).label }) as MapObject);
  const shownCount = printObjects.filter((o) => o.visible).length;
  const [withVehicle, setWithVehicle] = useState(!!props.vehicle && (incident?.vehicleVisible ?? true));
  const [withIncident, setWithIncident] = useState(hasIncidentPos);
  const [withObjects, setWithObjects] = useState(visibleObjects.length > 0);
  const mapUnits = placedUnits(props.units);
  const [withUnits, setWithUnits] = useState(mapUnits.length > 0);
  // Ausgabe: PDF herunterladen oder direkt auf einem Drucker des Druckservers
  const { data: printStatus } = usePrintStatus();
  const hasPrinters = !!printStatus?.printers.length;
  const [target, setTarget] = useState<'pdf' | 'printer' | null>(null);
  const output = target ?? (hasPrinters ? 'printer' : 'pdf');
  const { form, setForm, printer, valid: printerValid } = usePrintForm(printStatus);
  const media = mediaFor(printer, paper);

  const frame = useMemo(() => printFrame(center, zoom, paper, orientation), [center, zoom, paper, orientation]);
  const b = frame.bounds;
  const frameBounds: L.LatLngBoundsExpression = [
    [b.south, b.west],
    [b.north, b.east],
  ];
  const [previewTime] = useState(() => new Date());
  const tileCount = (Math.ceil(frame.widthPx / TILE_SIZE) + 1) * (Math.ceil(frame.heightPx / TILE_SIZE) + 1);

  const buildRequest = (): MapPrintRequest => {
    const now = new Date();
    const markers: MapPrintRequest['markers'] = [];
    if (withVehicle && vehicle) markers.push({ kind: 'vehicle', lat: vehicle.lat, lon: vehicle.lon, label: vehicle.name });
    if (withIncident && hasIncidentPos) markers.push({ kind: 'incident', lat: incident!.lat!, lon: incident!.lon!, label: incident!.keyword || 'Einsatzort' });

    const polygons: MapPrintRequest['polygons'] = [];
    const lines: NonNullable<MapPrintRequest['lines']> = [];
    const legend: MapPrintRequest['legend'] = [];
    const notes: string[] = [];
    if (withUnits) for (const u of mapUnits) markers.push({ kind: 'unit', lat: u.lat!, lon: u.lon!, label: u.name, sign: u.sign });
    if (withObjects) {
      const o = objectsForPrint(printObjects, weather, now);
      markers.push(...o.markers);
      polygons.push(...o.polygons);
      lines.push(...o.lines);
      legend.push(...o.legend);
      notes.push(...o.notes);
    }
    if (weather) {
      notes.push(
        `Wind ${fmtNum(weather.windSpeedMs)} m/s aus ${compass(weather.windDirectionDeg)} (${weather.windDirectionDeg}°)${weatherGustMs !== null ? `, Böen ${fmtNum(weatherGustMs)} m/s` : ''} – Stand ${fmtDtg(now)}`,
      );
    }
    return {
      paper,
      orientation,
      zoom,
      center,
      sourceId,
      title: title.trim() || 'Lagekarte',
      subtitle: incident?.location || undefined,
      markers,
      polygons,
      lines,
      legend,
      notes,
    };
  };

  const print = useMutation({
    mutationFn: async () => {
      const map = await api.printMap(buildRequest());
      if (output === 'pdf') return { ...map, job: null };
      // Format und Ausrichtung legt das PDF fest; passendes Papier wählen, sonst auf die Vorgabe des Druckers anpassen
      const file = new File([map.pdf], map.filename, { type: 'application/pdf' });
      const job = await api.printPdf(file, { ...form, media, orientation: 'auto', pageRanges: '', numberUp: 1 });
      return { ...map, job };
    },
    onSuccess: ({ pdf, filename, missingTiles, job }) => {
      if (!job) downloadBlob(pdf, filename);
      const what = job ? `Lagekarte an ${job.printerName} gesendet${job.archivedPath ? ` und unter „${job.archivedPath}“ abgelegt` : ''}` : 'Lagekarte als PDF erstellt';
      if (missingTiles) toast('error', `${what}, aber ${missingTiles} Kartenkachel(n) fehlen (offline?)`);
      else toast('success', what);
      props.onDone();
    },
    onError: (e) => toast('error', e.message),
  });

  // Maske außerhalb des Druckrahmens
  const mask: [number, number][][] = [
    [
      [85, -180],
      [85, 180],
      [-85, 180],
      [-85, -180],
    ],
    [
      [b.north, b.west],
      [b.north, b.east],
      [b.south, b.east],
      [b.south, b.west],
    ],
  ];

  return (
    <div className="print-dialog">
      <div className="print-options">
        <Field label="Titel">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Format">
          <Segmented<PaperFormat> label="Format" value={paper} onChange={setPaper} options={(['A4', 'A3', 'A2', 'A1'] as const).map((p) => ({ value: p, label: p }))} />
        </Field>
        <Field label="Ausrichtung">
          <Segmented<Orientation>
            label="Ausrichtung"
            value={orientation}
            onChange={setOrientation}
            options={[
              { value: 'landscape', label: 'Quer' },
              { value: 'portrait', label: 'Hoch' },
            ]}
          />
        </Field>
        <Field label={`Zoomstufe ${zoom} · Maßstab ca. 1:${niceScale(frame.scale).toLocaleString('de-DE')}`}>
          <input type="range" min={MIN_PRINT_ZOOM} max={maxZoom} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </Field>
        {sources.length > 1 && (
          <Field label="Kartenstil">
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="toggle-group">
          <Toggle label="Fahrzeugstandort" checked={withVehicle} onChange={setWithVehicle} disabled={!vehicle} />
          <Toggle label="Einsatzort" checked={withIncident} onChange={setWithIncident} disabled={!hasIncidentPos} />
          <Toggle label={`Kartenobjekte (${shownCount}/${objects.length})`} checked={withObjects} onChange={setWithObjects} disabled={!objects.length} />
          {withObjects && objects.length > 0 && (
            <ul className="print-objects" aria-label="Kartenobjekte im Druck">
              {objects.map((o) => {
                const c = choiceOf(o);
                return (
                  <li key={o.id} className={c.show ? '' : 'hidden'}>
                    <label>
                      <input type="checkbox" checked={c.show} onChange={(e) => choose(o, { show: e.target.checked })} />
                      <span className="print-object-name">{o.name}</span>
                      <span className="muted">{MAP_OBJECT_LABELS[o.kind]}</span>
                    </label>
                    {!isTracked(o.kind) && <LabelToggle object={o} value={c.label} onChange={(label) => choose(o, { label })} />}
                  </li>
                );
              })}
            </ul>
          )}
          <Toggle label={`Kräfte (${mapUnits.length})`} checked={withUnits} onChange={setWithUnits} disabled={!mapUnits.length} />
        </div>
        <p className="muted print-summary">
          Ausschnitt {fmtDistance(frame.widthM)} × {fmtDistance(frame.heightM)} · ca. {tileCount} Kacheln. Karte in der Vorschau verschieben, um den Ausschnitt zu wählen.
        </p>
        {hasPrinters && (
          <Field label="Ausgabe">
            <Segmented
              label="Ausgabe"
              value={output}
              onChange={setTarget}
              options={[
                { value: 'printer', label: 'Drucker' },
                { value: 'pdf', label: 'PDF herunterladen' },
              ]}
            />
          </Field>
        )}
        {output === 'printer' && printStatus && (
          <>
            <PrinterSettings status={printStatus} form={form} onChange={setForm} fixedLayout />
            {printer && !media && (
              <p className="muted">
                {printer.info} kennt kein {paper}
                {form.fitToPage ? ' – die Karte wird auf das Standardpapier des Druckers verkleinert.' : '.'}
              </p>
            )}
          </>
        )}
        {output === 'printer' ? (
          <button className="btn btn-primary btn-lg" disabled={print.isPending || !printerValid} onClick={() => print.mutate()}>
            <Printer size={18} /> {print.isPending ? 'Wird gedruckt …' : `Drucken (${paper})`}
          </button>
        ) : (
          <button className="btn btn-primary btn-lg" disabled={print.isPending} onClick={() => print.mutate()}>
            <FileDown size={18} /> {print.isPending ? 'PDF wird erstellt …' : `PDF erzeugen (${paper})`}
          </button>
        )}
      </div>

      <div className="print-preview">
        <MapContainer center={[center.lat, center.lon]} zoom={zoom - 2} className="map" zoomControl={false} attributionControl={false} scrollWheelZoom={false}>
          <TileLayer url={api.tileUrl(sourceId)} maxZoom={source.maxZoom} />
          <Polygon positions={mask} pathOptions={{ stroke: false, fillColor: '#000', fillOpacity: 0.4 }} interactive={false} />
          <Rectangle bounds={frameBounds} pathOptions={{ color: '#e53935', weight: 3, fill: false }} interactive={false} />
          {withObjects && <MapObjectsLayer objects={printObjects} wind={weather} now={previewTime} />}
          {withUnits && <UnitsLayer units={mapUnits} labels={false} />}
          {withVehicle && vehicle && <Marker position={[vehicle.lat, vehicle.lon]} icon={vehicleIcon} interactive={false} />}
          {withIncident && hasIncidentPos && <Marker position={[incident!.lat!, incident!.lon!]} icon={incidentIcon} interactive={false} />}
          <CenterSync onCenter={setCenter} />
          <WheelPrintZoom onStep={(d) => setZoom((z) => Math.min(maxZoom, Math.max(MIN_PRINT_ZOOM, z + d)))} />
          <FitFrame bounds={frameBounds} deps={[paper, orientation, zoom]} />
        </MapContainer>
        <div className="print-paper-label">
          {paper} {orientation === 'landscape' ? 'quer' : 'hoch'}
        </div>
      </div>
    </div>
  );
}
