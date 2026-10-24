import { Marker, Tooltip } from 'react-leaflet';
import type L from 'leaflet';
import { useQuery } from '@tanstack/react-query';
import type { TacticalSign, Unit } from '@elvis/shared';
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

/** Taktische Zeichen der Kräfte; verschiebbar, wenn `onMove` gesetzt ist */
export function UnitsLayer({ units, labels = true, onMove }: { units: Unit[]; labels?: boolean; onMove?: (u: Unit, lat: number, lon: number) => void }) {
  return (
    <>
      {placedUnits(units).map((u) => (
        <Marker
          key={u.id}
          position={[u.lat!, u.lon!]}
          icon={unitIcon(u.sign)}
          draggable={!!onMove}
          interactive={labels || !!onMove}
          eventHandlers={onMove && { dragend: (e) => { const p = (e.target as L.Marker).getLatLng(); onMove(u, p.lat, p.lng); } }}
        >
          {labels && (
            <Tooltip direction="bottom" offset={[0, 14]}>
              {u.name}
            </Tooltip>
          )}
        </Marker>
      ))}
    </>
  );
}
