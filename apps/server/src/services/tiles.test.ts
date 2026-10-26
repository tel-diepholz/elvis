import { describe, expect, it } from 'vitest';
import { tileAt, tileBbox3857 } from './tiles.js';

const HALF = 20_037_508.342789244;

describe('tileBbox3857', () => {
  it('deckt bei Zoomstufe 0 die ganze Welt ab', () => {
    const [minx, miny, maxx, maxy] = tileBbox3857(0, 0, 0);
    expect(minx).toBeCloseTo(-HALF, 3);
    expect(miny).toBeCloseTo(-HALF, 3);
    expect(maxx).toBeCloseTo(HALF, 3);
    expect(maxy).toBeCloseTo(HALF, 3);
  });

  it('liefert für eine Kachel in Diepholz den passenden Ausschnitt', () => {
    // Diepholz: 52.607 N, 8.371 E → EPSG:3857 ≈ 931 855, 6 910 632
    const { x, y } = tileAt(52.607, 8.371, 14);
    expect({ x, y }).toEqual({ x: 8572, y: 5366 });
    const [minx, miny, maxx, maxy] = tileBbox3857(14, x, y);
    expect(maxx - minx).toBeCloseTo(2445.98, 1);
    expect(maxy - miny).toBeCloseTo(2445.98, 1);
    expect(minx).toBeLessThan(931_855);
    expect(maxx).toBeGreaterThan(931_855);
    expect(miny).toBeLessThan(6_910_632);
    expect(maxy).toBeGreaterThan(6_910_632);
  });
});
