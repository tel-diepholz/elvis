import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, GripVertical, Settings2, X } from 'lucide-react';
import { DASHBOARD_COLS, DASHBOARD_MAX_ROWS, DASHBOARD_TILE_TYPES, dashboardRows, placeDashboardTile, type DashboardTile } from '@elvis/shared';
import { DASHBOARD_ICONS, DASHBOARD_LINKS, DashboardTileContent, HEADLESS } from './tiles';

type Box = Pick<DashboardTile, 'x' | 'y' | 'w' | 'h'>;
interface Drag {
  id: string;
  mode: 'move' | 'resize';
  /** Griffpunkt relativ zur linken oberen Ecke der Kachel (in Zellen) */
  offX: number;
  offY: number;
  box: Box;
}

/** Zeilenhöhe und Abstand – auch im CSS (--dash-row, --dash-gap) */
const ROW_PX = 64;
const GAP_PX = 12;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * Kacheln der Übersicht im Raster mit 12 Spalten. Im Bearbeitungsmodus Kachel ziehen zum Verschieben, Ecke unten
 * rechts zum Ändern der Größe; Pfeiltasten verschieben, Umschalt+Pfeiltasten ändern die Größe. Im Weg liegende
 * Kacheln rutschen nach unten. Auf schmalen Bildschirmen stehen die Kacheln untereinander (ohne Bearbeiten).
 */
export function DashboardGrid({
  tiles,
  editing,
  stacked,
  onChange,
  onSettings,
  onRemove,
}: {
  tiles: DashboardTile[];
  editing: boolean;
  stacked: boolean;
  onChange: (tiles: DashboardTile[]) => void;
  onSettings: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const edit = editing && !stacked;

  // Während des Ziehens die Anordnung zeigen, die beim Loslassen entsteht
  const shown = drag ? placeDashboardTile(tiles, drag.id, drag.box) : tiles;
  const rows = Math.max(dashboardRows(shown), 1) + (edit ? 4 : 0);

  const cellAt = (e: PointerEvent) => {
    const r = grid.current!.getBoundingClientRect();
    const colPitch = (r.width + GAP_PX) / DASHBOARD_COLS;
    return { cx: Math.floor((e.clientX - r.left) / colPitch), cy: Math.floor((e.clientY - r.top) / (ROW_PX + GAP_PX)) };
  };

  const start = (t: DashboardTile, mode: Drag['mode']) => (e: PointerEvent<HTMLElement>) => {
    if (!edit || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    grid.current!.setPointerCapture(e.pointerId);
    const { cx, cy } = cellAt(e);
    setDrag({ id: t.id, mode, offX: cx - t.x, offY: cy - t.y, box: { x: t.x, y: t.y, w: t.w, h: t.h } });
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const t = tiles.find((x) => x.id === drag.id)!;
    const { cx, cy } = cellAt(e);
    const box =
      drag.mode === 'move'
        ? { x: clamp(cx - drag.offX, 0, DASHBOARD_COLS - t.w), y: clamp(cy - drag.offY, 0, DASHBOARD_MAX_ROWS - t.h), w: t.w, h: t.h }
        : { x: t.x, y: t.y, w: clamp(cx - t.x + 1, 2, DASHBOARD_COLS - t.x), h: clamp(cy - t.y + 1, 1, DASHBOARD_MAX_ROWS - t.y) };
    if (!sameBox(box, drag.box)) setDrag({ ...drag, box });
  };
  const end = () => {
    if (drag) {
      const t = tiles.find((x) => x.id === drag.id)!;
      if (!sameBox(t, drag.box)) commit(drag.id, drag.box);
    }
    setDrag(null);
  };
  const commit = (id: string, box: Box) => {
    const next = placeDashboardTile(tiles, id, box);
    if (dashboardRows(next) <= DASHBOARD_MAX_ROWS) onChange(next);
  };
  const onKey = (t: DashboardTile) => (e: KeyboardEvent) => {
    if (!edit || e.target !== e.currentTarget) return;
    const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (e.key === 'Delete') return onRemove(t.id);
    if (!d) return;
    e.preventDefault();
    const box = e.shiftKey
      ? { x: t.x, y: t.y, w: clamp(t.w + d[0], 2, DASHBOARD_COLS - t.x), h: Math.max(1, t.h + d[1]) }
      : { x: clamp(t.x + d[0], 0, DASHBOARD_COLS - t.w), y: Math.max(0, t.y + d[1]), w: t.w, h: t.h };
    commit(t.id, box);
  };

  const ordered = stacked ? [...shown].sort((a, b) => a.y - b.y || a.x - b.x) : shown;

  return (
    <div
      ref={grid}
      className={`dash-grid ${edit ? 'editing' : ''} ${stacked ? 'stacked' : ''}`}
      style={stacked ? undefined : ({ gridTemplateRows: `repeat(${rows}, var(--dash-row))`, '--dash-row': `${ROW_PX}px`, '--dash-gap': `${GAP_PX}px` } as CSSProperties)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => setDrag(null)}
    >
      {drag && <div className="dash-placeholder" style={{ gridColumn: `${drag.box.x + 1} / span ${drag.box.w}`, gridRow: `${drag.box.y + 1} / span ${drag.box.h}` }} />}
      {ordered.map((t) => {
        const info = DASHBOARD_TILE_TYPES[t.type];
        const Icon = DASHBOARD_ICONS[t.type];
        const link = DASHBOARD_LINKS[t.type];
        const headless = HEADLESS.has(t.type);
        const title = typeof t.config.heading === 'string' && t.config.heading.trim() ? t.config.heading.trim() : info.label;
        const style: CSSProperties = stacked
          ? { height: `calc(${Math.max(t.h, 2)} * ${ROW_PX}px + ${Math.max(t.h, 2) - 1} * ${GAP_PX}px)` }
          : { gridColumn: `${t.x + 1} / span ${t.w}`, gridRow: `${t.y + 1} / span ${t.h}` };
        return (
          <section
            key={t.id}
            className={`dash-tile display-tile-${t.type} ${drag?.id === t.id ? 'dragging' : ''} ${headless ? 'headless' : ''}`}
            style={style}
            tabIndex={edit ? 0 : undefined}
            aria-label={edit ? `${title}, Spalte ${t.x + 1}, Zeile ${t.y + 1}, ${t.w}×${t.h}` : undefined}
            onPointerDown={start(t, 'move')}
            onKeyDown={onKey(t)}
          >
            {!headless && (
              <header className="dash-tile-head">
                {link && !edit ? (
                  <Link to={link} className="dash-tile-title">
                    <Icon size={16} /> {title} <ChevronRight size={14} className="dash-tile-more" />
                  </Link>
                ) : (
                  <span className="dash-tile-title">
                    <Icon size={16} /> {title}
                  </span>
                )}
              </header>
            )}
            <div className="dash-tile-body">
              <DashboardTileContent tile={t} />
            </div>
            {edit && (
              <div className="dash-tile-edit">
                <span className="dash-tile-edit-bar">
                  <GripVertical size={16} aria-hidden />
                  <span className="ellipsis">{title}</span>
                  <span className="dash-tile-size">
                    {t.w}×{t.h}
                  </span>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Einstellungen" aria-label={`${title}: Einstellungen`} onClick={() => onSettings(t.id)}>
                    <Settings2 size={16} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Entfernen" aria-label={`${title} entfernen`} onClick={() => onRemove(t.id)}>
                    <X size={16} />
                  </button>
                </span>
                <span className="dash-tile-resize" aria-hidden onPointerDown={start(t, 'resize')} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
