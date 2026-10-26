import { Fragment } from 'react';
import { GeoJSON, Marker, Polygon, Polyline, Popup, Tooltip } from 'react-leaflet';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_OBJECT_COLORS, formatAltitude, objectColor, type MapObject } from '@elvis/shared';
import { api } from '../../lib/api';
import { dispersionSector, usePlume, type Wind } from './dispersion';
import { aircraftMarker } from './aircraftIcons';
import { shipIcon, trafficPath } from './traffic';
import { useMapIcons } from './mapIcons';

/** Darstellung je Farbe (Karte, Vorschau und – über dieselben Werte – Druck) */
export const areaStyle = (color: string) => ({ color, weight: 3, dashArray: '8 6', fillColor: color, fillOpacity: 0.08 });
export const sectorStyle = (color: string) => ({ color, fillColor: color, fillOpacity: 0.22, weight: 2, dashArray: '6 4' });
export const lineStyle = (color: string) => ({ color, weight: 4, opacity: 0.85, lineCap: 'round' as const, lineJoin: 'round' as const });
export const AREA_STYLE = areaStyle(DEFAULT_OBJECT_COLORS.area);

const pointIcons = new Map<string, L.DivIcon>();
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Symbol für pointIcon: Name und fertiges SVG (siehe useMapIcons) */
export type PointSymbol = { name: string; svg: string };

/**
 * Punkt-Markierung je Farbe, Symbol und Schild (zwischengespeichert, damit Leaflet die Markierung nicht ständig neu
 * anlegt); mit Symbol ein größerer Kreis mit weißem Lucide-Icon, das Schild (z. B. „DN 100“) steht darunter
 */
export function pointIcon(color: string, symbol: PointSymbol | null, badge?: string | null): L.DivIcon {
  const key = `${color}|${symbol?.name ?? ''}|${badge ?? ''}`;
  let icon = pointIcons.get(key);
  if (!icon) {
    const tag = badge ? `<b class="map-marker-badge">${escapeHtml(badge)}</b>` : '';
    icon = symbol
      ? L.divIcon({ className: 'map-marker object with-icon', html: `<span style="background:${color}">${symbol.svg}</span>${tag}`, iconSize: [28, 28], iconAnchor: [14, 14] })
      : L.divIcon({ className: 'map-marker object', html: `<span style="background:${color}"></span>${tag}`, iconSize: [16, 16], iconAnchor: [8, 8] });
    pointIcons.set(key, icon);
  }
  return icon;
}

/** Fertiges weißes Symbol für pointIcon; null ohne Namen oder solange die Icons laden */
export function pointSymbol(icons: ReturnType<typeof useMapIcons>, name: string | null | undefined): PointSymbol | null {
  const svg = name && icons?.mapIconSvg(name, { size: 16, color: '#ffffff', strokeWidth: 2.25 });
  return svg ? { name: name!, svg } : null;
}
const sourceIcon = L.divIcon({ className: 'map-marker origin', html: '<span></span>', iconSize: [14, 14], iconAnchor: [7, 7] });

/** Kartenobjekte des Einsatzes; live aktualisiert über das Thema „mapObjects“ */
export function useMapObjects(incidentId: number | null | undefined) {
  return useQuery({
    queryKey: ['mapObjects', incidentId],
    queryFn: () => api.mapObjects(incidentId!),
    enabled: !!incidentId,
    staleTime: 60_000,
  });
}

/** Ausdehnung eines Objekts für „hinfliegen“ (Fläche: Umriss, Linie: Verlauf, sonst Punkt) */
export function objectBounds(o: MapObject): L.LatLngBounds {
  if (o.kind === 'area') return L.geoJSON(o.data.outline).getBounds();
  if (o.kind === 'line') return L.geoJSON(o.data.path).getBounds();
  return L.latLngBounds([o.lat, o.lon], [o.lat, o.lon]);
}

function GaussLayer({ object, wind, now }: { object: Extract<MapObject, { kind: 'gauss' }>; wind: Wind | undefined; now: Date }) {
  const plume = usePlume(object.data, object, wind, now);
  return (
    <>
      {plume?.contours.map(({ level, polygon }) => <Polygon key={level.threshold} positions={polygon} pathOptions={level.path} interactive={false} />)}
      <Marker position={[object.lat, object.lon]} icon={sourceIcon} interactive={false} />
    </>
  );
}

/** Verfolgtes Flugzeug oder Schiff: Spur, Symbol in Bewegungsrichtung, Beschriftung; ohne Signal blass */
function TrackedLayer({ object, labels, links }: { object: Extract<MapObject, { kind: 'aircraft' | 'ship' }>; labels: boolean; links: boolean }) {
  const color = objectColor(object);
  const { trail, last, lostSince } = object.data;
  const lost = !!lostSince;
  const icon =
    object.kind === 'aircraft'
      ? aircraftMarker(
          { category: object.data.category, type: object.data.aircraftType, altFt: last?.altFt ?? null, onGround: last?.onGround ?? false, track: last?.track ?? null },
          { color, faded: lost, selected: true },
        )
      : shipIcon(color, last?.track ?? null, (last?.speedKt ?? 0) >= 0.5, lost);
  const sub = object.kind === 'aircraft' && last ? formatAltitude(last.altFt, last.onGround) : null;
  return (
    <>
      {trail.length > 1 && <Polyline positions={trail} pathOptions={{ color, weight: 2, opacity: lost ? 0.35 : 0.8, dashArray: '4 4' }} interactive={false} />}
      <Marker position={[object.lat, object.lon]} icon={icon}>
        {/* Popup mit Link zur Detailseite nur an Arbeitsplätzen, nicht auf Bildschirmen */}
        {links && (
          <Popup>
            <Link to={trafficPath(object.kind, object.data.id)} className="map-popup-title" title="Details">
              {object.name}
            </Link>
            <br />
            {object.data.detail}
            {sub && (
              <>
                <br />
                {sub}
              </>
            )}
            {lost && (
              <>
                <br />
                <span className="tone-warn">kein Signal</span>
              </>
            )}
          </Popup>
        )}
        {labels && (
          <Tooltip direction="right" offset={[12, 0]} permanent className="map-tracked-label">
            {object.name}
            {sub && ` · ${sub}`}
            {lost && ' · kein Signal'}
          </Tooltip>
        )}
      </Marker>
    </>
  );
}

/** Sichtbare Kartenobjekte zeichnen: Flächen, Linien, Punkte und Ausbreitungen (mit aktuellem Wind) */
export function MapObjectsLayer({
  objects,
  wind,
  now,
  labels = true,
  links = false,
}: {
  objects: MapObject[];
  wind: Wind | undefined;
  now: Date;
  labels?: boolean;
  /** Popups mit Link zur Detailseite (Arbeitsplätze) */
  links?: boolean;
}) {
  // Lucide erst laden, wenn ein Punkt ein Symbol hat
  const icons = useMapIcons(objects.some((o) => o.kind === 'point' && o.data.icon));
  return (
    <>
      {objects
        .filter((o) => o.visible)
        .map((o) => {
          switch (o.kind) {
            case 'area':
              // Schlüssel mit Farbe: GeoJSON übernimmt geänderte Stile sonst nicht
              return <GeoJSON key={`${o.id}:${o.data.osm}:${objectColor(o)}`} data={o.data.outline} interactive={false} style={areaStyle(objectColor(o))} />;
            case 'line':
              return (
                <GeoJSON key={`${o.id}:${o.data.osm}:${objectColor(o)}`} data={o.data.path} style={lineStyle(objectColor(o))}>
                  {labels && <Tooltip sticky>{o.name}</Tooltip>}
                </GeoJSON>
              );
            case 'point':
              return (
                <Marker key={o.id} position={[o.lat, o.lon]} icon={pointIcon(objectColor(o), pointSymbol(icons, o.data.icon), o.data.badge)}>
                  {labels && <Tooltip direction="top" offset={[0, o.data.icon ? -14 : -8]}>{o.name}</Tooltip>}
                </Marker>
              );
            case 'gauss':
              return <GaussLayer key={o.id} object={o} wind={wind} now={now} />;
            case 'sector':
              return (
                <Fragment key={o.id}>
                  {wind && <Polygon positions={dispersionSector(o.lat, o.lon, wind.windDirectionDeg, o.data.sectorM)} pathOptions={sectorStyle(objectColor(o))} interactive={false} />}
                  <Marker position={[o.lat, o.lon]} icon={sourceIcon} interactive={false} />
                </Fragment>
              );
            case 'aircraft':
            case 'ship':
              return <TrackedLayer key={o.id} object={o} labels={labels} links={links} />;
          }
        })}
    </>
  );
}
