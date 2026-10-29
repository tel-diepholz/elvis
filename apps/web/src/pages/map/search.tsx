import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Crosshair, Home, Landmark, Loader2, MapPin, Search, Signpost, X } from 'lucide-react';
import { GEOCODE_KIND_LABELS, type GeocodeKind, type GeocodeResult } from '@elvis/shared';
import { api } from '../../lib/api';

const KIND_ICONS: Record<GeocodeKind, typeof MapPin> = {
  coordinate: Crosshair,
  house: Home,
  street: Signpost,
  locality: Building2,
  district: Building2,
  city: Building2,
  county: Landmark,
  state: Landmark,
  country: Landmark,
  other: MapPin,
};

/**
 * Suchfeld der Karte: Straßen, Orte, Adressen, Koordinaten und UTMREF. Treffer in der Nähe von focus() zuerst;
 * ↑/↓ wählen, Enter übernimmt, Esc schließt.
 */
export function MapSearch({
  focus,
  onSelect,
  id = 'map-search-results',
  placeholder = 'Straße, Ort, Koordinate, UTMREF',
  label = 'In der Karte suchen',
  clearOnSelect = false,
}: {
  focus: () => { lat: number; lon: number } | null;
  onSelect: (r: GeocodeResult) => void;
  /** Eigene Kennung der Trefferliste, wenn mehrere Suchfelder gleichzeitig zu sehen sind (Routenbox) */
  id?: string;
  placeholder?: string;
  label?: string;
  /** Feld nach der Auswahl leeren (Halte der Route nacheinander suchen) */
  clearOnSelect?: boolean;
}) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState<{ q: string; focus: { lat: number; lon: number } | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Enter gedrückt, bevor die Treffer zum aktuellen Text da waren: ersten frischen Treffer übernehmen */
  const [pendingEnter, setPendingEnter] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Erst suchen, wenn eine Weile nicht getippt wurde; die Kartenmitte zählt zum Zeitpunkt der Suche
  useEffect(() => {
    const q = text.trim();
    const t = setTimeout(() => setQuery(q.length >= 2 ? { q, focus: focus() } : null), 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isFetching, isPlaceholderData, error } = useQuery({
    queryKey: ['mapSearch', query?.q, query?.focus?.lat.toFixed(2), query?.focus?.lon.toFixed(2)],
    queryFn: () => api.mapSearch(query!.q, query!.focus),
    enabled: !!query,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const results = query ? data?.results ?? [] : [];
  // Bis die Antwort zum aktuellen Text da ist, zeigt die Liste noch die vorige Suche
  const fresh = !!query && query.q === text.trim() && !isPlaceholderData && !isFetching;

  useEffect(() => setActive(0), [data]);

  // Klick außerhalb schließt die Liste
  useEffect(() => {
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const choose = (r: GeocodeResult | undefined) => {
    if (!r) return;
    onSelect(r);
    setOpen(false);
    if (clearOnSelect) (setText(''), setQuery(null));
    (document.activeElement as HTMLElement | null)?.blur();
  };

  useEffect(() => {
    if (!pendingEnter || !fresh) return;
    setPendingEnter(false);
    choose(results[0]);
  }, [pendingEnter, fresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, results.length - 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
    else if (e.key === 'Enter') {
      if (fresh) choose(results[active]);
      else if (text.trim().length >= 2) {
        // Nicht auf die Tipp-Pause warten: sofort suchen und den ersten Treffer nehmen
        if (query?.q !== text.trim()) setQuery({ q: text.trim(), focus: focus() });
        setPendingEnter(true);
      }
    }
    else if (e.key === 'Escape') (text ? setText('') : setOpen(false));
    else return;
    e.preventDefault();
  };

  const showList = open && !!query;
  return (
    <div className="map-search" ref={box}>
      <div className="map-search-field">
        {isFetching ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
        <input
          type="search"
          value={text}
          onChange={(e) => (setText(e.target.value), setOpen(true), setPendingEnter(false))}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label={label}
          aria-expanded={showList}
          aria-controls={id}
          role="combobox"
          autoComplete="off"
          spellCheck={false}
        />
        {text && (
          <button type="button" className="map-search-clear" onClick={() => (setText(''), setQuery(null))} aria-label="Suche leeren">
            <X size={16} />
          </button>
        )}
      </div>
      {showList && (
        <div className={`map-search-results ${fresh ? '' : 'stale'}`} id={id} role="listbox">
          {results.map((r, i) => {
            const Icon = KIND_ICONS[r.kind];
            return (
              <button
                type="button"
                key={r.id}
                role="option"
                aria-selected={i === active}
                className={`map-search-item ${i === active ? 'active' : ''}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(r)}
              >
                <Icon size={18} />
                <span className="map-search-text">
                  <strong>{r.name}</strong>
                  {r.detail && <span className="muted">{r.detail}</span>}
                </span>
                <span className="map-search-kind">{GEOCODE_KIND_LABELS[r.kind]}</span>
              </button>
            );
          })}
          {!isFetching && data && results.length === 0 && !data.problem && <div className="map-search-note muted">Nichts gefunden</div>}
          {(data?.problem || error) && <div className="map-search-note tone-warn">{data?.problem ?? (error as Error).message}</div>}
          {data?.source && results.length > 0 && <div className="map-search-note muted">Quelle: {data.source}</div>}
        </div>
      )}
    </div>
  );
}
