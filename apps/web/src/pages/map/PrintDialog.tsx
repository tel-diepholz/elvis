import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polygon, Rectangle, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { useMutation } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import {
  DEFAULT_VEHICLE_SIGN,
  KLUG_MANIER,
  MAX_PRINT_ZOOM,
  MIN_PRINT_ZOOM,
  TERRAIN_LABELS,
  TILE_SIZE,
  niceScale,
  printFrame,
  type Incident,
  type MapPrintRequest,
  type MapSource,
  type Orientation,
  type PaperFormat,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { compass, fmtDtg, fmtNum } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { useSettings } from '../../lib/hooks';
import { tacticalIcon } from '../../components/tactical/TacticalSign';
import { Field, Segmented, Toggle } from '../../components/ui';
import { LEVELS, dispersionSector, fmtDistance, fmtExp, type DispersionSettings, type PlumeResult } from './dispersion';

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
  /** Wind für Ausbreitung und Hinweis (nur wenn Geschwindigkeit und Richtung bekannt sind). */
  wind: { windSpeedMs: number; windDirectionDeg: number } | undefined;
  weatherGustMs: number | null;
  settings: DispersionSettings;
  plume: PlumeResult | null;
  onDone: () => void;
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

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PrintDialog(props: PrintDialogProps) {
  const { sources, vehicle, incident, wind: weather, weatherGustMs, settings, plume } = props;
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
  const hasDispersion = hasIncidentPos && !!weather && settings.mode !== 'off';
  const [withVehicle, setWithVehicle] = useState(!!props.vehicle);
  const [withIncident, setWithIncident] = useState(hasIncidentPos);
  const [withDispersion, setWithDispersion] = useState(hasDispersion);

  const frame = useMemo(() => printFrame(center, zoom, paper, orientation), [center, zoom, paper, orientation]);
  const b = frame.bounds;
  const frameBounds: L.LatLngBoundsExpression = [
    [b.south, b.west],
    [b.north, b.east],
  ];
  const tileCount = (Math.ceil(frame.widthPx / TILE_SIZE) + 1) * (Math.ceil(frame.heightPx / TILE_SIZE) + 1);

  const sector = hasIncidentPos && weather && settings.mode === 'sector' ? dispersionSector(incident!.lat!, incident!.lon!, weather.windDirectionDeg, settings.sectorM) : null;

  const buildRequest = (): MapPrintRequest => {
    const now = new Date();
    const markers: MapPrintRequest['markers'] = [];
    if (withVehicle && vehicle) markers.push({ kind: 'vehicle', lat: vehicle.lat, lon: vehicle.lon, label: vehicle.name });
    if (withIncident && hasIncidentPos) markers.push({ kind: 'incident', lat: incident!.lat!, lon: incident!.lon!, label: incident!.keyword || 'Einsatzort' });

    const polygons: MapPrintRequest['polygons'] = [];
    const legend: MapPrintRequest['legend'] = [];
    const notes: string[] = [];
    if (weather) {
      notes.push(
        `Wind ${fmtNum(weather.windSpeedMs)} m/s aus ${compass(weather.windDirectionDeg)} (${weather.windDirectionDeg}°)${weatherGustMs !== null ? `, Böen ${fmtNum(weatherGustMs)} m/s` : ''} – Stand ${fmtDtg(now)}`,
      );
    }
    if (withDispersion && plume) {
      for (const { level, polygon } of plume.contours) {
        polygons.push({ points: polygon, stroke: level.path.color, fill: level.path.fillColor, fillOpacity: level.path.fillOpacity, dashed: 'dashArray' in level.path });
      }
      const rate = settings.releaseRateKgS;
      for (const { level, contour } of plume.contours.slice().reverse()) {
        const value = rate ? `${fmtNum(level.threshold * rate * 1e6, 0)} mg/m³` : `${fmtExp(level.threshold)} s/m³`;
        legend.push({ color: level.path.color, label: `${level.label} ≥ ${value} – bis ${contour.truncated ? '> ' : ''}${fmtDistance(contour.maxDistanceM)}` });
      }
      notes.push(
        `Ausbreitung: Gauß-Fahne, Klasse ${plume.stability} (${KLUG_MANIER[plume.stability].label}), ${TERRAIN_LABELS[settings.terrain]}, Quellhöhe ${settings.sourceHeightM} m${rate ? `, Freisetzung ${fmtNum(rate, 2)} kg/s` : ''}. Nur Orientierung – keine Grundlage für Grenzwertentscheidungen.`,
      );
    } else if (withDispersion && sector) {
      polygons.push({ points: sector, stroke: '#e3a008', fill: '#e3a008', fillOpacity: 0.22, dashed: true });
      legend.push({ color: '#e3a008', label: `Schemasektor 60° in Windrichtung (${fmtDistance(settings.sectorM)})` });
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
      legend,
      notes,
    };
  };

  const print = useMutation({
    mutationFn: () => api.printMap(buildRequest()),
    onSuccess: ({ pdf, filename, missingTiles }) => {
      download(pdf, filename);
      if (missingTiles) toast('error', `PDF erstellt, aber ${missingTiles} Kartenkachel(n) fehlen (offline?)`);
      else toast('success', 'Lagekarte als PDF erstellt');
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
          <Toggle
            label={settings.mode === 'sector' ? 'Ausbreitungssektor' : 'Ausbreitung (Gauß-Fahne)'}
            checked={withDispersion}
            onChange={setWithDispersion}
            disabled={!hasDispersion}
          />
        </div>
        <p className="muted print-summary">
          Ausschnitt {fmtDistance(frame.widthM)} × {fmtDistance(frame.heightM)} · ca. {tileCount} Kacheln. Karte in der Vorschau verschieben, um den Ausschnitt zu wählen.
        </p>
        <button className="btn btn-primary btn-lg" disabled={print.isPending} onClick={() => print.mutate()}>
          <FileDown size={18} /> {print.isPending ? 'PDF wird erstellt …' : `PDF erzeugen (${paper})`}
        </button>
      </div>

      <div className="print-preview">
        <MapContainer center={[center.lat, center.lon]} zoom={zoom - 2} className="map" zoomControl={false} attributionControl={false}>
          <TileLayer url={api.tileUrl(sourceId)} maxZoom={source.maxZoom} />
          <Polygon positions={mask} pathOptions={{ stroke: false, fillColor: '#000', fillOpacity: 0.4 }} interactive={false} />
          <Rectangle bounds={frameBounds} pathOptions={{ color: '#e53935', weight: 3, fill: false }} interactive={false} />
          {withDispersion && plume?.contours.map(({ level, polygon }) => <Polygon key={level.threshold} positions={polygon} pathOptions={level.path} interactive={false} />)}
          {withDispersion && sector && (
            <Polygon positions={sector} pathOptions={{ color: '#e3a008', fillColor: '#e3a008', fillOpacity: 0.22, weight: 2, dashArray: '6 4' }} interactive={false} />
          )}
          {withVehicle && vehicle && <Marker position={[vehicle.lat, vehicle.lon]} icon={vehicleIcon} interactive={false} />}
          {withIncident && hasIncidentPos && <Marker position={[incident!.lat!, incident!.lon!]} icon={incidentIcon} interactive={false} />}
          <CenterSync onCenter={setCenter} />
          <FitFrame bounds={frameBounds} deps={[paper, orientation, zoom]} />
        </MapContainer>
        <div className="print-paper-label">
          {paper} {orientation === 'landscape' ? 'quer' : 'hoch'}
        </div>
      </div>
    </div>
  );
}
