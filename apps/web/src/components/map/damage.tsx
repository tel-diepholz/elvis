import { Link } from 'react-router-dom';
import { Marker, Popup, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { DAMAGE_COUNT_LABELS, formatDamageCount, type DamageAccount } from '@elvis/shared';

const icons = new Map<number, L.DivIcon>();
/** Schadenstelle: roter Kreis mit Nummer (wie auf der Lagekarte) */
function damageIcon(number: number): L.DivIcon {
  let icon = icons.get(number);
  if (!icon) {
    icon = L.divIcon({ className: 'map-marker', html: `<span class="damage-number damage-marker">${number}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    icons.set(number, icon);
  }
  return icon;
}

/** Offene Schadenkonten mit Position */
export const placedAccounts = (accounts: DamageAccount[]) => accounts.filter((a) => !a.closedAt && a.lat !== null && a.lon !== null);

/** Schadenkonten auf der Karte; verschiebbar ist nur `movable` (über „Auf Karte setzen“ gewählt), und nur mit `onMove` */
export function DamageLayer({ accounts, movable = null, onMove }: { accounts: DamageAccount[]; movable?: number | null; onMove?: (a: DamageAccount, lat: number, lon: number) => void }) {
  return (
    <>
      {placedAccounts(accounts).map((a) => {
        const counts = a.counts.filter((c) => c.value > 0);
        const open = a.entries.filter((e) => e.side !== 'massnahme' && !e.doneAt);
        const drag = !!onMove && a.id === movable;
        return (
          <Marker
            key={a.id}
            position={[a.lat!, a.lon!]}
            icon={damageIcon(a.number)}
            draggable={drag}
            eventHandlers={drag ? { dragend: (e) => { const p = (e.target as L.Marker).getLatLng(); onMove!(a, p.lat, p.lng); } } : undefined}
          >
            <Tooltip direction="bottom" offset={[0, 14]}>
              {a.name}
            </Tooltip>
            <Popup>
              <strong>
                Schadenkonto {a.number} {a.name}
              </strong>
              {(a.leader || a.radio) && <div className="muted">{[a.leader && `Leiter ${a.leader}`, a.radio && `Fm ${a.radio}`].filter(Boolean).join(' · ')}</div>}
              {open.length > 0 && (
                <ul className="damage-popup-list">
                  {open.slice(0, 5).map((e) => (
                    <li key={e.id}>
                      {e.uncertain && '? '}
                      {e.count !== null && `${e.count} × `}
                      {e.text || e.sign?.split('/')[1]?.replaceAll('_', ' ')}
                    </li>
                  ))}
                  {open.length > 5 && <li className="muted">… {open.length - 5} weitere</li>}
                </ul>
              )}
              {counts.length > 0 && <div>{counts.map((c) => `${DAMAGE_COUNT_LABELS[c.category]} ${formatDamageCount(c)}`).join(' · ')}</div>}
              <Link to="/einsatz/schadenkonten">Zum Schadenkonto</Link>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}
