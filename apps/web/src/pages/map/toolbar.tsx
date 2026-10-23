import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Crosshair, Layers, MapPin, Shapes, Wind as WindIcon } from 'lucide-react';
import type { MapSource } from '@elvis/shared';
import { compass, fmtOpt } from '../../lib/format';
import { WindCompass } from '../../components/WindCompass';

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

/** Menü „Objekte“: Einsatzort setzen, Ausbreitung einfügen (danach in die Karte tippen) */
export function ObjectMenu({ enabled, reason, hasLocation, onPlace }: { enabled: boolean; reason: string; hasLocation: boolean; onPlace: (k: PlaceKind) => void }) {
  return (
    <Dropdown
      label="Objekte"
      disabled={!enabled}
      title={enabled ? undefined : reason}
      button={
        <>
          <Shapes size={18} /> Objekte <ChevronDown size={16} />
        </>
      }
    >
      {(close) => (
        <>
          <button type="button" role="menuitem" className="map-dropdown-item" onClick={() => (close(), onPlace('incident'))}>
            <MapPin size={18} /> {hasLocation ? 'Einsatzort verschieben' : 'Einsatzort setzen'}
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" onClick={() => (close(), onPlace('gauss'))}>
            <WindIcon size={18} /> Gauß-Fahne einfügen
          </button>
          <button type="button" role="menuitem" className="map-dropdown-item" onClick={() => (close(), onPlace('sector'))}>
            <Crosshair size={18} /> Sektor 60° einfügen
          </button>
        </>
      )}
    </Dropdown>
  );
}

/** Kartenstil oben rechts; „Automatisch“ folgt Hell/Dunkel */
export function MapStylePicker({
  sources,
  value,
  auto,
  onChange,
  onMenuHeight,
}: {
  sources: MapSource[];
  value: string | null;
  auto: MapSource | undefined;
  onChange: (id: string | null) => void;
  onMenuHeight?: (px: number) => void;
}) {
  if (sources.length < 2) return null;
  const item = (id: string | null, label: string, close: () => void) => (
    <button key={id ?? 'auto'} type="button" role="menuitemradio" aria-checked={value === id} className="map-dropdown-item" onClick={() => (close(), onChange(id))}>
      <span className="map-dropdown-check">{value === id && <Check size={16} />}</span> {label}
    </button>
  );
  return (
    <div className="map-overlay map-style">
      <Dropdown label="Kartenstil" align="right" button={<Layers size={18} />} onMenuHeight={onMenuHeight}>
        {(close) => (
          <>
            {item(null, `Automatisch (${auto?.name ?? '–'})`, close)}
            {sources.map((s) => item(s.id, s.name, close))}
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
