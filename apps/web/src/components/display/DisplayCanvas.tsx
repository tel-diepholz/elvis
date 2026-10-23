import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DisplayLayout, DisplayScreen } from '@elvis/shared';
import { TileView } from './tiles';

/** Kacheln im Raster – auf dem Bildschirm und (verkleinert) in der Vorschau identisch */
export function DisplayCanvas({ layout }: { layout: DisplayLayout }) {
  return (
    <div className="display-canvas" style={{ gridTemplateColumns: `repeat(${layout.cols}, 1fr)`, gridTemplateRows: `repeat(${layout.rows}, 1fr)` }}>
      {layout.tiles.map((t) => (
        <section key={t.id} className={`display-tile display-tile-${t.type}`} style={{ gridColumn: `${t.x + 1} / span ${t.w}`, gridRow: `${t.y + 1} / span ${t.h}` }}>
          <TileView tile={t} />
        </section>
      ))}
    </div>
  );
}

export const DEFAULT_SCREEN: DisplayScreen = { width: 1920, height: 1080 };

/**
 * Inhalt in Originalgröße des Bildschirms rendern und auf die verfügbare Breite verkleinern – so sieht die Vorschau
 * genau aus wie der Bildschirm (Schriftgrößen, Umbrüche, Seitenverhältnis).
 */
export function ScaledScreen({ screen, children, className = '' }: { screen: DisplayScreen | null; children: ReactNode; className?: string }) {
  const s = screen ?? DEFAULT_SCREEN;
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / s.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.width]);
  return (
    <div ref={outer} className={`scaled-screen ${className}`} style={{ aspectRatio: `${s.width} / ${s.height}`, ['--display-ratio' as string]: s.width / s.height }}>
      {scale > 0 && (
        <div className="scaled-screen-inner" style={{ width: s.width, height: s.height, transform: `scale(${scale})` }}>
          {children}
        </div>
      )}
    </div>
  );
}
