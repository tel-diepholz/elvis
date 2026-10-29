import { describe, expect, it } from 'vitest';
import { applyAffine, fitAffine, georefRequestSchema, hexRgb, isBackground, inverseMercator, mercator, overlayBounds, overlayZoom, type Gcp } from './georef';

/** Seite 1000 × 800 px, 0,5 m je Pixel, um 30° gedreht, Ursprung bei Diepholz */
const origin = mercator(52.6, 8.37);
const angle = (30 * Math.PI) / 180;
const scale = 0.5 / Math.cos((52.6 * Math.PI) / 180); // Meter am Boden → Mercator-Meter
function truth(x: number, y: number) {
  const X = origin[0] + scale * (Math.cos(angle) * x + Math.sin(angle) * y);
  const Y = origin[1] + scale * (Math.sin(angle) * x - Math.cos(angle) * y);
  return inverseMercator(X, Y);
}
const gcp = (x: number, y: number): Gcp => ({ x, y, ...truth(x, y) });

describe('Georeferenzierung', () => {
  it('Mercator hin und zurück', () => {
    const [x, y] = mercator(52.6, 8.37);
    const p = inverseMercator(x, y);
    expect(p.lat).toBeCloseTo(52.6, 9);
    expect(p.lon).toBeCloseTo(8.37, 9);
  });

  it('findet Verschiebung, Drehung und Maßstab aus 3 Passpunkten ohne Restfehler', () => {
    const fit = fitAffine([gcp(0, 0), gcp(1000, 0), gcp(0, 800)])!;
    expect(fit.rmsM).toBe(0);
    const p = applyAffine(fit.t, 500, 400);
    const want = truth(500, 400);
    expect(p.lat).toBeCloseTo(want.lat, 7);
    expect(p.lon).toBeCloseTo(want.lon, 7);
  });

  it('gleicht überzählige Punkte aus und zeigt den Ausreißer im Restfehler', () => {
    const points = [gcp(0, 0), gcp(1000, 0), gcp(0, 800), gcp(1000, 800)];
    expect(fitAffine(points)!.rmsM).toBeLessThan(0.01);
    // Ein Punkt 20 m daneben
    const off = { ...points[3]!, lat: points[3]!.lat + 20 / 111_320 };
    const fit = fitAffine([...points.slice(0, 3), off])!;
    expect(fit.rmsM).toBeGreaterThan(3);
    expect(fit.residualsM[3]).toBeGreaterThan(fit.residualsM[0]!);
  });

  it('lehnt zu wenige oder kollineare Punkte ab', () => {
    expect(fitAffine([gcp(0, 0), gcp(10, 10)])).toBeNull();
    expect(fitAffine([gcp(0, 0), gcp(10, 10), gcp(20, 20), gcp(30, 30)])).toBeNull();
  });

  it('leitet Ausdehnung und Zoomstufen ab', () => {
    const fit = fitAffine([gcp(0, 0), gcp(1000, 0), gcp(0, 800)])!;
    const [[s, w], [n, e]] = overlayBounds(fit.t, 1000, 800);
    for (const [x, y] of [[0, 0], [1000, 0], [0, 800], [1000, 800], [500, 400]] as const) {
      const p = truth(x, y);
      expect(p.lat).toBeGreaterThanOrEqual(s - 1e-9);
      expect(p.lat).toBeLessThanOrEqual(n + 1e-9);
      expect(p.lon).toBeGreaterThanOrEqual(w - 1e-9);
      expect(p.lon).toBeLessThanOrEqual(e + 1e-9);
    }
    // 0,5 m je Pixel auf 52,6° Breite: Zoom 18 hat dort rund 0,36 m je Pixel
    expect(overlayZoom(fit.t)).toEqual({ minZoom: 10, maxZoom: 18 });
  });

  it('verlangt für die 2. Ordnung mindestens 6 Passpunkte', () => {
    const three = [gcp(0, 0), gcp(1000, 0), gcp(0, 800)];
    expect(georefRequestSchema.safeParse({ page: 1, name: 'Plan', gcps: three }).success).toBe(true);
    expect(georefRequestSchema.safeParse({ page: 1, name: 'Plan', gcps: three, order: 2 }).success).toBe(false);
  });
});

describe('Weggeschnittene Bereiche', () => {
  const gcps = [gcp(0, 0), gcp(1000, 0), gcp(0, 800)];
  it('nimmt Rechtecke in Bildpixeln und lehnt leere ab', () => {
    expect(georefRequestSchema.parse({ page: 1, name: 'Plan', gcps }).cuts).toEqual([]);
    expect(georefRequestSchema.safeParse({ page: 1, name: 'Plan', gcps, cuts: [[700, 600, 1000, 800]] }).success).toBe(true);
    expect(georefRequestSchema.safeParse({ page: 1, name: 'Plan', gcps, cuts: [[700, 600, 700, 800]] }).success).toBe(false);
  });
});

describe('Gebäude, Hintergrund und Radierer', () => {
  const gcps = [gcp(0, 0), gcp(1000, 0), gcp(0, 800)];
  it('prüft Umriss, Farbe und Striche', () => {
    const ok = georefRequestSchema.parse({
      page: 1,
      name: 'Plan',
      gcps,
      outline: [[100, 100], [400, 100], [400, 300]],
      background: { color: '#fffff0', tolerance: 40 },
      erase: [{ width: 20, points: [[500, 500], [600, 520]] }],
    });
    expect(ok.outline).toHaveLength(3);
    expect(georefRequestSchema.parse({ page: 1, name: 'Plan', gcps })).toMatchObject({ outline: null, background: null, erase: [] });
    expect(georefRequestSchema.safeParse({ page: 1, name: 'Plan', gcps, outline: [[1, 1], [2, 2]] }).success).toBe(false);
    expect(georefRequestSchema.safeParse({ page: 1, name: 'Plan', gcps, background: { color: 'white', tolerance: 40 } }).success).toBe(false);
  });

  it('erkennt Hintergrund mit Toleranz je Farbkanal', () => {
    const paper = hexRgb('#f8f4e8');
    expect(paper).toEqual({ r: 248, g: 244, b: 232 });
    expect(isBackground(255, 255, 255, paper, 40)).toBe(true);
    expect(isBackground(200, 244, 232, paper, 40)).toBe(false);
    expect(isBackground(0, 0, 0, paper, 40)).toBe(false);
  });
});
