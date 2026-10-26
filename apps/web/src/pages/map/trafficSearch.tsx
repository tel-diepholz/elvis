import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plane, Search, Ship } from 'lucide-react';
import { formatAltitude, type TrafficHit } from '@elvis/shared';
import { api } from '../../lib/api';
import { Loading } from '../../components/ui';
import { hitDetail, hitName } from '../../components/map/traffic';

/**
 * Einzelnes Flugzeug oder Schiff suchen (Rufzeichen, Kennzeichen, ICAO-Adresse, Schiffsname, MMSI). Flugzeuge kommen
 * vom Online-Dienst, Schiffe aus dem AIS-Empfang um Einsatzort bzw. Fahrzeug.
 */
export function TrafficSearch({ tracked, onPick }: { tracked: Set<string>; onPick: (hit: TrafficHit) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ['trafficSearch', debounced],
    queryFn: () => api.trafficSearch(debounced),
    enabled: debounced.length >= 3,
    staleTime: 10_000,
  });

  return (
    <>
      <label className="map-search-field">
        <Search size={18} aria-hidden />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rufzeichen, Kennzeichen, ICAO-Adresse, Schiffsname oder MMSI" aria-label="Flugzeug oder Schiff suchen" />
      </label>
      <p className="muted">Schiffe findet die Suche nur, wenn sie zuletzt im Gebiet um Einsatzort bzw. Fahrzeug gesendet haben.</p>
      {debounced.length >= 3 && isFetching && !data && <Loading />}
      {data?.problem && <p className="tone-warn">{data.problem}</p>}
      {data && debounced.length >= 3 && !data.items.length && !isFetching && <p className="muted">Nichts gefunden – gerade nicht in der Luft bzw. nicht im Empfangsgebiet?</p>}
      {!!data?.items.length && (
        <ul className="traffic-hits">
          {data.items.map((h) => {
            const id = h.kind === 'aircraft' ? h.hex : h.mmsi;
            const done = tracked.has(id);
            return (
              <li key={`${h.kind}:${id}`}>
                <button type="button" disabled={done} onClick={() => onPick(h)}>
                  {h.kind === 'aircraft' ? <Plane size={18} /> : <Ship size={18} />}
                  <span className="map-object-text">
                    <strong>{hitName(h)}</strong>
                    <span className="muted">
                      {hitDetail(h)}
                      {h.kind === 'aircraft' && ` · ${formatAltitude(h.altFt, h.onGround)}`}
                      {done && ' · bereits in der Objektliste'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
