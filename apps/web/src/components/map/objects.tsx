import { Fragment } from 'react';
import { GeoJSON, Marker, Polygon, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_OBJECT_COLORS, objectColor, type MapObject } from '@elvis/shared';
import { api } from '../../lib/api';
import { dispersionSector, usePlume, type Wind } from './dispersion';

/** Darstellung je Farbe (Karte, Vorschau und – über dieselben Werte – Druck) */
export const areaStyle = (color: string) => ({ color, weight: 3, dashArray: '8 6', fillColor: color, fillOpacity: 0.08 });
export const sectorStyle = (color: string) => ({ color, fillColor: color, fillOpacity: 0.22, weight: 2, dashArray: '6 4' });
export const AREA_STYLE = areaStyle(DEFAULT_OBJECT_COLORS.area);

const pointIcons = new Map<string, L.DivIcon>();
/** Punkt-Symbol je Farbe (zwischengespeichert, damit Leaflet die Markierung nicht ständig neu anlegt) */
function pointIcon(color: string): L.DivIcon {
  let icon = pointIcons.get(color);
  if (!icon) {
    icon = L.divIcon({ className: 'map-marker object', html: `<span style="background:${color}"></span>`, iconSize: [16, 16], iconAnchor: [8, 8] });
    pointIcons.set(color, icon);
  }
  return icon;
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

/** Ausdehnung eines Objekts für „hinfliegen“ (Fläche: Umriss, sonst Punkt) */
export function objectBounds(o: MapObject): L.LatLngBounds {
  if (o.kind === 'area') return L.geoJSON(o.data.outline).getBounds();
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

/** Sichtbare Kartenobjekte zeichnen: Flächen, Punkte und Ausbreitungen (mit aktuellem Wind) */
export function MapObjectsLayer({ objects, wind, now, labels = true }: { objects: MapObject[]; wind: Wind | undefined; now: Date; labels?: boolean }) {
  return (
    <>
      {objects
        .filter((o) => o.visible)
        .map((o) => {
          switch (o.kind) {
            case 'area':
              // Schlüssel mit Farbe: GeoJSON übernimmt geänderte Stile sonst nicht
              return <GeoJSON key={`${o.id}:${o.data.osm}:${objectColor(o)}`} data={o.data.outline} interactive={false} style={areaStyle(objectColor(o))} />;
            case 'point':
              return (
                <Marker key={o.id} position={[o.lat, o.lon]} icon={pointIcon(objectColor(o))}>
                  {labels && <Tooltip direction="top" offset={[0, -8]}>{o.name}</Tooltip>}
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
          }
        })}
    </>
  );
}
