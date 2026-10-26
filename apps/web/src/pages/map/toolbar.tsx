import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Crosshair, Database, Loader2, Search, X, Layers, MapPin, Plane, Shapes, Ship, Wind as WindIcon } from 'lucide-react';
import type { MapSource, OverpassQuery } from '@elvis/shared';
import { MapIcon } from '../../components/map/mapIcons';
import { compass, fmtOpt } from '../../lib/format';
import { WindCompass } from '../../components/WindCompass';
import type { TrafficLayers } from '../../components/map/traffic';

/** Knopf mit ausklappbarem Menü; Klick daneben oder Esc schließt */
function Dropdown({
  button,
  label,
  align = 'left',
  disabled,
  title,
  onMenuHeight,
  children,
}: {
  button: ReactNode;
  label: string;
  align?: 'left' | 'right';
  disabled?: boolean;
  title?: string;
  /** Höhe des offenen Menüs (0 = geschlossen), z. B. um darunterliegende Overlays zu verschieben */
  onMenuHeight?: (px: number) => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => onMenuHeight?.(open && menu.current ? menu.current.offsetHeight + 6 : 0), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => (document.removeEventListener('pointerdown', onDown), document.removeEventListener('keydown', onKey));
  }, [open]);
  return (
    <div className="map-dropdown" ref={box}>
      <button type="button" className={`btn ${open ? 'active' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={label} disabled={disabled} title={title} onClick={() => setOpen((o) => !o)}>
        {button}
      </button>
      {open && (
        <div className={`map-dropdown-menu ${align}`} role="menu" ref={menu}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export type PlaceKind = 'incident' | 'gauss' | 'sector';

/**
 * Menü „Objekte“: Einsatzort setzen, Ausbreitung einfügen (danach in die Karte tippen), Flugzeug/Schiff suchen –
 * das braucht einen laufenden Einsatz – sowie OpenStreetMap-Daten abfragen (nur angemeldet): die Vorlagen aus den
 * Einstellungen laufen sofort im Kartenausschnitt, „OpenStreetMap abfragen …“ öffnet den Abfragebereich.
 */
export function ObjectMenu({
  loggedIn,
  enabled,
  reason,
  hasLocation,
  templates,
  overpass,
  overpassRunning,
  onPlace,
  onSearchTraffic,
  onTemplate,
  onOverpass,
  onClearOverpass,
}: {
  loggedIn: boolean;
  /** Objekte des Einsatzes ändern */
  enabled: boolean;
  reason: string;
  hasLocation: boolean;
  /** Overpass-Vorlagen aus den Einstellungen */
  templates: OverpassQuery[];
  /** Letzte Overpass-Abfrage und ihre Trefferzahl, null = keine Treffer angezeigt */
  overpass: { name: string; count: number } | null;
  /** Name der gerade laufenden Overpass-Abfrage, null = keine */
  overpassRunning: string | null;
  onPlace: (k: PlaceKind) => void;
  onSearchTraffic: () => void;
  onTemplate: (q: OverpassQuery) => void;
  onOverpass: () => void;
  onClearOverpass: () => void;
}) {
  const edit = { disabled: !enabled, title: enabled ? undefined : reason };
  return (
    <Dropdown
      label="Objekte"
      disabled={!loggedIn}
      title={loggedIn ? undefined : 'Zum Bearbeiten anmelden'}
      button={
        <>
          {overpassRunning ? <Loader2 size={18} className="spin" aria-label={`„${overpassRunning}“ wird abgefragt`} /> : <Shapes size={18} />} Objekte <ChevronDown size={16} />
        </>
      }
    >
      {(close) => (
        <>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onPlace('incident'))}>
            <MapPin size={18} /> {hasLocation ? 'Einsatzort verschieben' : 'Einsatzort setzen'}
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onPlace('gauss'))}>
            <WindIcon size={18} /> Gauß-Fahne einfügen
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onPlace('sector'))}>
            <Crosshair size={18} /> Sektor 60° einfügen
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onSearchTraffic())}>
            <Plane size={18} /> Flugzeug oder Schiff suchen …
          </button>
          <div className="map-dropdown-heading">OpenStreetMap</div>
          {templates.map((q, i) => (
            <button key={i} type="button" role="menuitem" className={`map-dropdown-item ${overpassRunning === q.name ? 'running' : ''}`} disabled={!!overpassRunning} onClick={() => (close(), onTemplate(q))}>
              {q.icon ? <MapIcon name={q.icon} size={18} /> : <Database size={18} />} {q.name}
              {overpassRunning === q.name ? (
                <span className="muted map-dropdown-loading">
                  <Loader2 size={14} className="spin" /> lädt …
                </span>
              ) : (
                overpass?.name === q.name && <span className="muted">{overpass.count} Treffer</span>
              )}
            </button>
          ))}
          <button type="button" role="menuitem" className="map-dropdown-item" onClick={() => (close(), onOverpass())}>
            <Search size={18} /> OpenStreetMap abfragen …
          </button>
          {overpass && (
            <button type="button" role="menuitem" className="map-dropdown-item" onClick={() => (close(), onClearOverpass())}>
              <X size={18} /> Treffer entfernen
              <span className="muted">{overpass.count}</span>
            </button>
          )}
        </>
      )}
    </Dropdown>
  );
}

/** Kartenstil und Ebenen oben rechts; „Automatisch“ folgt Hell/Dunkel */
export function MapStylePicker({
  sources,
  value,
  auto,
  onChange,
  layers,
  onLayers,
  onMenuHeight,
}: {
  sources: MapSource[];
  value: string | null;
  auto: MapSource | undefined;
  onChange: (id: string | null) => void;
  layers: TrafficLayers;
  onLayers: (l: TrafficLayers) => void;
  onMenuHeight?: (px: number) => void;
}) {
  const layer = (key: keyof TrafficLayers, icon: ReactNode, label: string) => (
    <button key={key} type="button" role="menuitemcheckbox" aria-checked={layers[key]} className="map-dropdown-item" onClick={() => onLayers({ ...layers, [key]: !layers[key] })}>
      <span className="map-dropdown-check">{layers[key] && <Check size={16} />}</span> {icon} {label}
    </button>
  );
  const item = (id: string | null, label: string, close: () => void) => (
    <button key={id ?? 'auto'} type="button" role="menuitemradio" aria-checked={value === id} className="map-dropdown-item" onClick={() => (close(), onChange(id))}>
      <span className="map-dropdown-check">{value === id && <Check size={16} />}</span> {label}
    </button>
  );
  return (
    <div className="map-overlay map-style">
      <Dropdown label="Kartenstil und Ebenen" align="right" button={<Layers size={18} />} onMenuHeight={onMenuHeight}>
        {(close) => (
          <>
            {sources.length > 1 && (
              <>
                <div className="map-dropdown-heading">Kartenstil</div>
                {item(null, `Automatisch (${auto?.name ?? '–'})`, close)}
                {sources.map((s) => item(s.id, s.name, close))}
              </>
            )}
            <div className="map-dropdown-heading">Ebenen</div>
            {layer('aircraft', <Plane size={16} />, 'Flugzeuge')}
            {layer('ships', <Ship size={16} />, 'Schiffe')}
          </>
        )}
      </Dropdown>
    </div>
  );
}

/** Kleine Windanzeige unten links */
export function WindTile({ speedMs, directionDeg, gustMs }: { speedMs: number | null; directionDeg: number | null; gustMs: number | null }) {
  return (
    <div className="map-overlay map-wind" aria-label="Wind">
      <WindCompass directionDeg={directionDeg} size={44} />
      <div>
        <div className="map-wind-value">
          <WindIcon size={16} /> {fmtOpt(speedMs)} m/s
        </div>
        <div className="muted">
          {directionDeg === null ? 'Richtung unbekannt' : `aus ${compass(directionDeg)}`} · Böen {fmtOpt(gustMs)}
        </div>
      </div>
    </div>
  );
}
