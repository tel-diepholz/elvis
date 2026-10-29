import { hexRgb, isBackground, type GeorefBackground, type GeorefCut, type GeorefPoint, type GeorefStroke } from '@elvis/shared';

/** Kantenlänge der Vorschau (die Seite selbst hat bis zu 8000 px) */
export const PREVIEW_MAX_PX = 2048;
/** So erscheinen entfernte Stellen links im Plan */
const REMOVED_TINT = [70, 80, 95, 150] as const;

/** Was vor dem Kacheln mit der Seite passiert (wie prep.json auf dem Server) */
export interface PagePrep {
  cuts: GeorefCut[];
  outline: GeorefPoint[] | null;
  background: GeorefBackground | null;
  erase: GeorefStroke[];
}

export interface PreparedPage {
  /** Seite wie später in der Karte (entfernte Stellen transparent, Gebäude deckend auf der Hintergrundfarbe) */
  result: HTMLCanvasElement;
  /** Nur die entfernten Stellen, dunkel eingefärbt – liegt links über dem Plan */
  removed: HTMLCanvasElement;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Maske (Alpha > 0) aus einer Zeichnung auf einer leeren Fläche */
function mask(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Uint8ClampedArray {
  const c = canvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = ctx.strokeStyle = '#000';
  draw(ctx);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * Vorschau der Vorbereitung in verkleinerter Auflösung, nach derselben Regel wie das Skript im GDAL-Container: Rechtecke
 * überall weg, Hintergrundfarbe und Radierer nur außerhalb des Gebäudes (ohne Umriss: überall), Gebäude deckend auf der
 * Hintergrundfarbe.
 */
export function preparePage(source: HTMLImageElement, width: number, height: number, prep: PagePrep): PreparedPage {
  const s = Math.min(1, PREVIEW_MAX_PX / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  const result = canvas(w, h);
  const ctx = result.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  const outline = prep.outline && prep.outline.length >= 3 ? prep.outline : null;
  const inside = outline
    ? mask(w, h, (m) => {
        m.beginPath();
        outline.forEach(([x, y], i) => (i ? m.lineTo(x * s, y * s) : m.moveTo(x * s, y * s)));
        m.closePath();
        m.fill();
      })
    : null;
  const erased = prep.erase.length
    ? mask(w, h, (m) => {
        m.lineCap = m.lineJoin = 'round';
        for (const st of prep.erase) {
          m.lineWidth = st.width * s;
          m.beginPath();
          const [x0, y0] = st.points[0]!;
          m.moveTo(x0 * s, y0 * s);
          // Ein einzelner Punkt wird ein runder Tupfer
          if (st.points.length === 1) m.lineTo(x0 * s + 0.01, y0 * s);
          for (const [x, y] of st.points.slice(1)) m.lineTo(x * s, y * s);
          m.stroke();
        }
      })
    : null;
  const cut = prep.cuts.length ? mask(w, h, (m) => prep.cuts.forEach(([x0, y0, x1, y1]) => m.fillRect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s))) : null;
  const bg = prep.background ? hexRgb(prep.background.color) : null;
  const tolerance = prep.background?.tolerance ?? 0;

  const removed = canvas(w, h);
  const rctx = removed.getContext('2d')!;
  const tint = rctx.createImageData(w, h);
  const t = tint.data;
  for (let i = 0; i < px.length; i += 4) {
    const isInside = !!inside && inside[i + 3]! > 127;
    let gone = !!cut && cut[i + 3]! > 127;
    if (!isInside && !gone) gone = (!!bg && isBackground(px[i]!, px[i + 1]!, px[i + 2]!, bg, tolerance)) || (!!erased && erased[i + 3]! > 0);
    if (isInside && bg && !gone) {
      const a = px[i + 3]! / 255;
      px[i] = Math.round(px[i]! * a + bg.r * (1 - a));
      px[i + 1] = Math.round(px[i + 1]! * a + bg.g * (1 - a));
      px[i + 2] = Math.round(px[i + 2]! * a + bg.b * (1 - a));
      px[i + 3] = 255;
    }
    if (gone) px[i + 3] = 0;
    // Links dunkel: alles, was in der Karte nicht zu sehen sein wird (auch Stellen, die in der Seite schon transparent sind)
    if (gone || (!isInside && px[i + 3] === 0)) [t[i], t[i + 1], t[i + 2], t[i + 3]] = REMOVED_TINT;
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(tint, 0, 0);
  return { result, removed };
}

/** Farbe eines Bildpixels (Pipette) als #rrggbb */
export function pickColor(source: HTMLImageElement, x: number, y: number): string {
  const c = canvas(1, 1);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, Math.floor(x), Math.floor(y), 1, 1, 0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  // Transparentes Papier gilt als Weiß
  const mix = (v: number) => Math.round(v * (a! / 255) + 255 * (1 - a! / 255));
  return `#${[mix(r!), mix(g!), mix(b!)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
