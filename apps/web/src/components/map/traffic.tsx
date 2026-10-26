import { useEffect, useState, type ReactNode } from 'react';
import { Marker, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { useQuery } from '@tanstack/react-query';
import { ListPlus } from 'lucide-react';
import {
  MAX_TRAFFIC_RADIUS_NM,
  NAV_STATUS,
  formatAltitude,
  shipTypeLabel,
  type Aircraft,
  type NewMapObject,
  type Ship,
  type TrafficHit,
} from '@elvis/shared';
import { api } from '../../lib/api';

/** Ebenen der Karte (pro Browser gemerkt) */
export interface TrafficLayers {
  aircraft: boolean;
  ships: boolean;
}

const LAYERS_KEY = 'elvis.map.layers';

export function readLayers(): TrafficLayers {
  try {
    const v = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') as Partial<TrafficLayers>;
    return { aircraft: v.aircraft === true, ships: v.ships === true };
  } catch {
    return { aircraft: false, ships: false };
  }
}

export function saveLayers(l: TrafficLayers): void {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(l));
  } catch {
    /* nur Komfort */
  }
}

/** Darunter zeigen die Ebenen nichts (zu viele Ziele, zu große Abfragen) */
export const TRAFFIC_MIN_ZOOM = 7;
export const AIRCRAFT_COLOR = '#f5b400';

// --- Symbole ---

const PLANE =
  'M12 1.5c.9 0 1.4.9 1.4 2v5.3l8.1 4.7v2.2l-8.1-2.5v4.9l2.5 1.9v1.7L12 20.7l-3.9 1v-1.7l2.5-1.9v-4.9l-8.1 2.5v-2.2l8.1-4.7V3.5c0-1.1.5-2 1.4-2z';
const HULL = 'M12 2l5 13.5-1.5 6.5h-7L7 15.5z';

const icons = new Map<string, L.DivIcon>();
function cached(key: string, html: () => string, size: number): L.DivIcon {
  let icon = icons.get(key);
  if (!icon) {
    icon = L.divIcon({ className: 'map-marker traffic', html: html(), iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    icons.set(key, icon);
  }
  return icon;
}

/** Flugzeug in Flugrichtung gedreht (auf 5° gerundet, damit sich die Symbole zwischenspeichern lassen) */
export function aircraftIcon(color: string, track: number | null, faded = false): L.DivIcon {
  const rot = Math.round((track ?? 0) / 5) * 5;
  return cached(
    `a:${color}:${rot}:${faded}`,
    () =>
      `<svg viewBox="0 0 24 24" width="26" height="26" style="transform:rotate(${rot}deg);opacity:${faded ? 0.45 : 1}"><path d="${PLANE}" fill="${color}" stroke="#1a1a1a" stroke-width="0.8" stroke-linejoin="round"/></svg>`,
    26,
  );
}

/** Schiff: Rumpf in Kursrichtung, ohne Fahrt als Kreis */
export function shipIcon(color: string, course: number | null, moving: boolean, faded = false): L.DivIcon {
  const rot = Math.round((course ?? 0) / 5) * 5;
  return cached(
    `s:${color}:${moving ? rot : 'x'}:${faded}`,
    () =>
      moving
        ? `<svg viewBox="0 0 24 24" width="22" height="22" style="transform:rotate(${rot}deg);opacity:${faded ? 0.45 : 1}"><path d="${HULL}" fill="${color}" stroke="#1a1a1a" stroke-width="0.8" stroke-linejoin="round"/></svg>`
        : `<svg viewBox="0 0 24 24" width="22" height="22" style="opacity:${faded ? 0.45 : 1}"><circle cx="12" cy="12" r="5" fill="${color}" stroke="#1a1a1a" stroke-width="0.8"/></svg>`,
    22,
  );
}

/** Farbe nach Schiffstyp, angelehnt an gängige AIS-Karten */
export function shipColor(type: number | null): string {
  if (type == null) return '#9e9e9e';
  if (type >= 60 && type <= 69) return '#1e88e5'; // Fahrgast
  if (type >= 70 && type <= 79) return '#43a047'; // Fracht
  if (type >= 80 && type <= 89) return '#e53935'; // Tanker
  if (type === 30) return '#ff8f00'; // Fischerei
  if (type === 36 || type === 37) return '#d81b60'; // Segel-/Sportboot
  if (type === 31 || type === 32 || type === 50 || type === 51 || type === 52 || type === 55 || type === 58) return '#00acc1'; // Schlepper, Lotse, SAR, Behörden
  return '#9e9e9e';
}

// --- Übernahme in die Objektliste ---

export const hitName = (h: TrafficHit) => (h.kind === 'aircraft' ? h.callsign ?? h.registration ?? h.hex.toUpperCase() : h.name ?? `MMSI ${h.mmsi}`);

export function hitDetail(h: TrafficHit): string {
  if (h.kind === 'aircraft') return [h.type, h.registration, h.hex.toUpperCase(), h.source === 'mlat' ? 'MLAT' : null].filter(Boolean).join(' · ');
  return [shipTypeLabel(h.shipType), h.callsign, `MMSI ${h.mmsi}`].filter(Boolean).join(' · ');
}

export function trafficObject(h: TrafficHit): NewMapObject {
  const base = { name: hitName(h), lat: h.lat, lon: h.lon };
  return h.kind === 'aircraft' ? { ...base, kind: 'aircraft', data: { id: h.hex, detail: hitDetail(h) } } : { ...base, kind: 'ship', data: { id: h.mmsi, detail: hitDetail(h) } };
}

const kmh = (kn: number | null) => (kn == null ? null : `${Math.round(kn)} kn (${Math.round(kn * 1.852)} km/h)`);

function AircraftDetails({ a }: { a: Aircraft }) {
  return (
    <>
      <strong>{a.callsign ?? a.registration ?? a.hex.toUpperCase()}</strong> <span className={`badge badge-${a.source === 'mlat' ? 'warn' : 'info'}`}>{a.source === 'mlat' ? 'MLAT' : a.source === 'adsb' ? 'ADS-B' : 'sonstige'}</span>
      <br />
      {[a.type, a.registration, a.hex.toUpperCase()].filter(Boolean).join(' · ')}
      <br />
      {formatAltitude(a.altFt, a.onGround)}
      {a.speedKt != null && ` · ${kmh(a.speedKt)}`}
      {a.track != null && ` · Kurs ${Math.round(a.track)}°`}
      {a.squawk && (
        <>
          <br />
          Squawk {a.squawk}
          {(a.squawk === '7500' || a.squawk === '7600' || a.squawk === '7700') && <strong className="tone-alarm"> Notfall</strong>}
        </>
      )}
    </>
  );
}

function ShipDetails({ s }: { s: Ship }) {
  return (
    <>
      <strong>{s.name ?? `MMSI ${s.mmsi}`}</strong>
      <br />
      {[shipTypeLabel(s.shipType), s.callsign, `MMSI ${s.mmsi}`].filter(Boolean).join(' · ')}
      <br />
      {s.sogKn != null ? kmh(s.sogKn) : 'Fahrt unbekannt'}
      {s.cog != null && ` · Kurs ${Math.round(s.cog)}°`}
      {s.navStatus != null && NAV_STATUS[s.navStatus] && ` · ${NAV_STATUS[s.navStatus]}`}
      {s.destination && (
        <>
          <br />
          Ziel: {s.destination}
        </>
      )}
    </>
  );
}

export interface TrafficStatus {
  count: number;
  problem: string | null;
  /** Karte zu weit herausgezoomt */
  tooFar: boolean;
}

/** Sichtbarer Ausschnitt; aktualisiert nach jedem Verschieben */
function useViewport() {
  const map = useMap();
  const read = () => ({ bounds: map.getBounds(), zoom: map.getZoom() });
  const [view, setView] = useState(read);
  useMapEvents({ moveend: () => setView(read()) });
  return view;
}

/** Quellenangabe in der Leaflet-Attribution, solange die Ebene an ist */
function useAttribution(text: string | null) {
  const map = useMap();
  useEffect(() => {
    if (!text || !map.attributionControl) return;
    map.attributionControl.addAttribution(text);
    return () => void map.attributionControl.removeAttribution(text);
  }, [map, text]);
}

interface LayerProps {
  /** Bereits in der Objektliste (ICAO-Adressen bzw. MMSI) */
  tracked: Set<string>;
  onAdd?: (hit: TrafficHit) => void;
  onStatus: (s: TrafficStatus) => void;
}

function AddButton({ hit, tracked, onAdd }: { hit: TrafficHit; tracked: Set<string>; onAdd?: (hit: TrafficHit) => void }): ReactNode {
  if (!onAdd) return null;
  const id = hit.kind === 'aircraft' ? hit.hex : hit.mmsi;
  return (
    <span className="map-popup-actions">
      {tracked.has(id) ? (
        <span className="muted">In der Objektliste</span>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => onAdd(hit)}>
          <ListPlus size={14} /> Zur Objektliste
        </button>
      )}
    </span>
  );
}

/** Alle Flugzeuge im Ausschnitt, alle 10 s neu (der Server teilt die Abfragen zwischen den Arbeitsplätzen) */
export function AircraftLayer({ tracked, onAdd, onStatus }: LayerProps) {
  const { bounds, zoom } = useViewport();
  const tooFar = zoom < TRAFFIC_MIN_ZOOM;
  const c = bounds.getCenter();
  const radius = Math.min(MAX_TRAFFIC_RADIUS_NM, c.distanceTo(bounds.getNorthEast()) / 1852);
  const params = { lat: Number(c.lat.toFixed(2)), lon: Number(c.lng.toFixed(2)), radius: Math.ceil(radius) };
  const { data } = useQuery({
    queryKey: ['traffic', 'aircraft', params],
    queryFn: () => api.trafficAircraft(params),
    enabled: !tooFar,
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  // Verfolgte Flugzeuge zeichnet die Objektliste (eigene Farbe, Spur) – hier nicht doppelt
  const visible = tooFar ? [] : (data?.items ?? []).filter((a) => !tracked.has(a.hex) && bounds.pad(0.1).contains([a.lat, a.lon]));
  useAttribution(data?.source ? `Flugdaten: ${data.source}` : null);
  useEffect(() => onStatus({ count: visible.length, problem: data?.problem ?? null, tooFar }), [visible.length, data?.problem, tooFar]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {visible.map((a) => (
        <Marker key={a.hex} position={[a.lat, a.lon]} icon={aircraftIcon(AIRCRAFT_COLOR, a.track, a.onGround)}>
          <Tooltip direction="top" offset={[0, -10]}>
            {a.callsign ?? a.registration ?? a.hex.toUpperCase()}
          </Tooltip>
          <Popup>
            <AircraftDetails a={a} />
            <AddButton hit={{ kind: 'aircraft', ...a }} tracked={tracked} onAdd={onAdd} />
          </Popup>
        </Marker>
      ))}
    </>
  );
}

/** Schiffe im Ausschnitt (soweit im AIS-Abo um Einsatzort bzw. Fahrzeug), alle 10 s neu */
export function ShipLayer({ tracked, onAdd, onStatus }: LayerProps) {
  const { bounds, zoom } = useViewport();
  const tooFar = zoom < TRAFFIC_MIN_ZOOM;
  const b = { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() };
  const { data } = useQuery({
    queryKey: ['traffic', 'ships', b],
    queryFn: () => api.trafficShips(b),
    enabled: !tooFar,
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  const visible = tooFar ? [] : (data?.items ?? []).filter((s) => !tracked.has(s.mmsi));
  useAttribution(data?.source ? `AIS: ${data.source}` : null);
  useEffect(() => onStatus({ count: visible.length, problem: data?.problem ?? null, tooFar }), [visible.length, data?.problem, tooFar]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {visible.map((s) => (
        <Marker key={s.mmsi} position={[s.lat, s.lon]} icon={shipIcon(shipColor(s.shipType), s.cog ?? s.heading, (s.sogKn ?? 0) >= 0.5)}>
          <Tooltip direction="top" offset={[0, -8]}>
            {s.name ?? `MMSI ${s.mmsi}`}
          </Tooltip>
          <Popup>
            <ShipDetails s={s} />
            <AddButton hit={{ kind: 'ship', ...s }} tracked={tracked} onAdd={onAdd} />
          </Popup>
        </Marker>
      ))}
    </>
  );
}
