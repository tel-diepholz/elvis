import { Circle, Marker, Tooltip } from 'react-leaflet';
import type L from 'leaflet';
import { useQuery } from '@tanstack/react-query';
import { APP_POSITION_STALE_MS, type TacticalSign, type Unit } from '@elvis/shared';
import { fmtAgo } from '../../lib/format';
import { api } from '../../lib/api';
import { tacticalIcon } from '../tactical/TacticalSign';

/** Kräfte des Einsatzes; live aktualisiert über das Thema „units“ (gemeinsamer Cache mit der Kräfteübersicht) */
export function useMapUnits(incidentId: number | null | undefined) {
  return useQuery({
    queryKey: ['units', incidentId],
    queryFn: () => api.units(incidentId!),
    enabled: !!incidentId,
    staleTime: 60_000,
  });
}

/** Auf der Karte: nicht entlassen, mit Position und eingeblendet */
export const placedUnits = (units: Unit[]) => units.filter((u) => u.status !== 'entlassen' && u.mapVisible && u.lat !== null && u.lon !== null);

const icons = new Map<string, L.DivIcon>();
/** Zeichen je Darstellung zwischenspeichern, damit Leaflet die Markierung nicht ständig neu anlegt */
function unitIcon(sign: TacticalSign): L.DivIcon {
  const key = JSON.stringify(sign);
  let icon = icons.get(key);
  if (!icon) {
    icon = tacticalIcon(sign, 40);
    icons.set(key, icon);
  }
  return icon;
}

/** Per App geortet und seit 20 min keine Meldung */
const staleApp = (u: Unit) => u.positionSource === 'app' && !!u.positionAt && Date.now() - new Date(u.positionAt).getTime() > APP_POSITION_STALE_MS;

/** Taktische Zeichen der Kräfte; verschiebbar, wenn `onMove` gesetzt ist. Per App geortete Kräfte zeigen Alter und Genauigkeit. */
export function UnitsLayer({ units, labels = true, onMove }: { units: Unit[]; labels?: boolean; onMove?: (u: Unit, lat: number, lon: number) => void }) {
  return (
    <>
      {placedUnits(units).map((u) =>
        u.positionSource === 'app' && u.positionAccuracyM !== null && u.positionAccuracyM > 10 ? (
          <Circle
            key={`acc-${u.id}`}
            center={[u.lat!, u.lon!]}
            radius={u.positionAccuracyM}
            interactive={false}
            pathOptions={{ color: '#4ea1ff', weight: 1, opacity: 0.6, fillOpacity: 0.08 }}
          />
        ) : null,
      )}
      {placedUnits(units).map((u) => (
        <Marker
          key={u.id}
          position={[u.lat!, u.lon!]}
          icon={unitIcon(u.sign)}
          opacity={staleApp(u) ? 0.5 : 1}
          draggable={!!onMove}
          interactive={labels || !!onMove}
          eventHandlers={onMove && { dragend: (e) => { const p = (e.target as L.Marker).getLatLng(); onMove(u, p.lat, p.lng); } }}
        >
          {labels && (
            <Tooltip direction="bottom" offset={[0, 14]}>
              {u.name}
              {u.positionSource === 'app' && u.positionAt && (
                <div className="muted">
                  App {fmtAgo(u.positionAt)}
                  {u.positionAccuracyM !== null && ` · ±${Math.round(u.positionAccuracyM)} m`}
                </div>
              )}
            </Tooltip>
          )}
        </Marker>
      ))}
    </>
  );
}
