import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';

/** Alle Lucide-Icons (eigener, nachgeladener Teil der Oberfläche – nur wenn Symbole gebraucht werden) */
type MapIconsModule = typeof import('@elvis/shared/mapIcons');

let loaded: MapIconsModule | null = null;
let loading: Promise<MapIconsModule> | null = null;
const load = () => (loading ??= import('@elvis/shared/mapIcons').then((m) => (loaded = m)));

/** Icon-Daten, sobald geladen; needed = false lädt nichts nach (z. B. keine Punkte mit Symbol) */
export function useMapIcons(needed = true): MapIconsModule | null {
  const [mod, setMod] = useState(loaded);
  useEffect(() => {
    if (!mod && needed) void load().then(setMod);
  }, [mod, needed]);
  return mod;
}

/** Ein Symbol als Inline-SVG (Objektliste, Auswahl); bis zum Laden leer */
export function MapIcon({ name, size = 16 }: { name: string; size?: number }) {
  const mod = useMapIcons();
  const svg = mod?.mapIconSvg(name, { size });
  return <span className="map-icon" style={{ width: size, height: size }} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />;
}

/** So viele Treffer zeigt die Auswahl auf einmal; den Rest findet die Suche */
const SHOWN = 120;

/** Symbolauswahl mit Suche (englische Lucide-Namen, häufige Einsatzbegriffe auch deutsch) */
export function MapIconPicker({ value, label, onPick }: { value: string | null; label: string; onPick: (name: string | null) => void }) {
  const mod = useMapIcons();
  const [q, setQ] = useState('');
  const hits = useMemo(() => mod?.searchMapIcons(q) ?? [], [mod, q]);
  return (
    <div className="map-icon-picker" role="group" aria-label={label}>
      <div className="map-icon-search">
        <Search size={15} aria-hidden />
        <input type="search" aria-label="Symbol suchen" placeholder="Symbol suchen, z. B. Feuer, Hydrant, hospital" value={q} onChange={(e) => setQ(e.target.value)} />
        {value && (
          <button type="button" className="btn btn-sm" onClick={() => onPick(null)}>
            Ohne Symbol
          </button>
        )}
      </div>
      {!mod ? (
        <p className="muted">Symbole werden geladen …</p>
      ) : (
        <>
          <div className="map-icon-grid" role="radiogroup" aria-label="Symbole">
            {hits.slice(0, SHOWN).map((e) => (
              <button
                key={e.name}
                type="button"
                role="radio"
                aria-checked={value === e.name}
                aria-label={e.name}
                title={e.name}
                className={`map-icon-choice ${value === e.name ? 'active' : ''}`}
                onClick={() => onPick(e.name)}
                dangerouslySetInnerHTML={{ __html: mod.mapIconSvg(e.name, { size: 20 })! }}
              />
            ))}
          </div>
          <p className="muted map-icon-count">
            {hits.length === 0 ? 'Kein Symbol gefunden' : hits.length > SHOWN ? `${SHOWN} von ${hits.length} Symbolen – Suche verfeinern` : `${hits.length} Symbole`}
          </p>
        </>
      )}
    </div>
  );
}
