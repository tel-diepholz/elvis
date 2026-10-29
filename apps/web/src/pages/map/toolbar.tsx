import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Check, ChevronDown, Circle, CircleDot, CloudRain, Hexagon, RectangleHorizontal, Spline, Crosshair, Database, Loader2, Minus, Plus, Search, X, Layers, MapPin, Plane, Route, Shapes, Ship, TriangleAlert, Wind as WindIcon } from 'lucide-react';
import { toMgrs, type MapSource, type OverpassQuery } from '@elvis/shared';
import { MapIcon } from '../../components/map/mapIcons';
import { compass, fmtOpt } from '../../lib/format';
import { WindCompass } from '../../components/WindCompass';
import type { TrafficLayers } from '../../components/map/traffic';
import type { ShapeKind } from './draw';

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

export type PlaceKind = 'incident' | 'point' | 'sign' | 'gauss' | 'sector';

/**
 * Menü „Objekte“: Einsatzort setzen, Punkt oder Ausbreitung einfügen (danach in die Karte tippen), Flugzeug/Schiff suchen, Formen zeichnen –
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
  onDraw,
  onSign,
  onSearchTraffic,
  onTemplate,
  onOverpass,
  onClearOverpass,
  routing,
  onRoute,
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
  onDraw: (k: ShapeKind) => void;
  /** Lagezeichen nach DV 102 auswählen (danach in die Karte tippen) */
  onSign: () => void;
  onSearchTraffic: () => void;
  onTemplate: (q: OverpassQuery) => void;
  onOverpass: () => void;
  onClearOverpass: () => void;
  /** Routing (Addon OSM-Daten): null = nicht verfügbar, sonst ob die Routenbox offen ist */
  routing: { open: boolean } | null;
  onRoute: () => void;
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
          <button
            type="button"
            role="menuitem"
            className="map-dropdown-item"
            disabled={!routing}
            title={routing ? undefined : 'Routing braucht das Addon „OSM-Daten“'}
            onClick={() => (close(), onRoute())}
          >
            <Route size={18} /> Route planen …{routing?.open && <span className="muted">offen</span>}
          </button>
          <div className="map-dropdown-heading">Zeichnen</div>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onPlace('point'))}>
            <CircleDot size={18} /> Punkt
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onSign())}>
            <TriangleAlert size={18} /> Zeichen …
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onDraw('polygon'))}>
            <Hexagon size={18} /> Fläche
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onDraw('line'))}>
            <Spline size={18} /> Linie
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onDraw('rectangle'))}>
            <RectangleHorizontal size={18} /> Rechteck
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" {...edit} onClick={() => (close(), onDraw('circle'))}>
            <Circle size={18} /> Kreis
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
            {layer('radar', <CloudRain size={16} />, 'Regenradar')}
          </>
        )}
      </Dropdown>
    </div>
  );
}

/** Kleine Windanzeige unten links */
/** Zoomknöpfe unten links (über der Windanzeige); gehört in den MapContainer */
export function ZoomControl({ aboveWind }: { aboveWind: boolean }) {
  const map = useMap();
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(() => map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  // Klicks und Doppelklicks nicht an die Karte durchreichen (kein Setzen, kein Doppelklick-Zoom)
  useEffect(() => {
    if (!box.current) return;
    L.DomEvent.disableClickPropagation(box.current);
    L.DomEvent.disableScrollPropagation(box.current);
  }, []);
  return (
    <div className={`map-overlay map-zoom ${aboveWind ? 'above-wind' : ''}`} ref={box}>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Hineinzoomen" title="Hineinzoomen" disabled={zoom >= map.getMaxZoom()} onClick={() => map.zoomIn()}>
        <Plus size={18} />
      </button>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Herauszoomen" title="Herauszoomen" disabled={zoom <= map.getMinZoom()} onClick={() => map.zoomOut()}>
        <Minus size={18} />
      </button>
    </div>
  );
}

/** Koordinate unter dem Mauszeiger unten rechts, als UTMREF und Grad; gehört in den MapContainer */
export function CursorPosition() {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  useMapEvents({
    mousemove: (e) => setPos({ lat: e.latlng.lat, lon: e.latlng.lng }),
    mouseout: () => setPos(null),
  });
  // Text soll markier- und kopierbar sein, ohne dass die Karte den Klick bekommt
  useEffect(() => {
    if (box.current) L.DomEvent.disableClickPropagation(box.current);
  }, []);
  return (
    <div className="map-overlay map-cursor" ref={box} aria-label="Koordinate unter dem Mauszeiger">
      {pos ? (
        <>
          <span className="mono">{toMgrs(pos.lat, pos.lon)}</span>
          <span className="mono muted">
            {pos.lat.toFixed(5)}, {pos.lon.toFixed(5)}
          </span>
        </>
      ) : (
        <span className="muted">Maus über die Karte führen</span>
      )}
    </div>
  );
}

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
