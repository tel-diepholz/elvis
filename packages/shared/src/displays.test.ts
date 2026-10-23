import { describe, expect, it } from 'vitest';
import { displayLayoutSchema, findFreeSpot, tilesOverlap, type DisplayLayout } from './displays';

describe('Bildschirm-Raster', () => {
  const layout: DisplayLayout = {
    cols: 6,
    rows: 4,
    tiles: [
      { id: 'a', type: 'map', x: 0, y: 0, w: 4, h: 4, config: {} },
      { id: 'b', type: 'clock', x: 4, y: 0, w: 2, h: 1, config: {} },
    ],
  };

  it('findet die erste freie Stelle oder meldet, dass kein Platz ist', () => {
    expect(findFreeSpot(layout, 2, 2)).toEqual({ x: 4, y: 1 });
    expect(findFreeSpot(layout, 3, 1)).toBeNull();
  });

  it('erkennt Überlappungen nur bei echter Überschneidung', () => {
    expect(tilesOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false);
    expect(tilesOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
  });

  it('lehnt doppelte IDs und unbekannte Kacheltypen ab', () => {
    expect(displayLayoutSchema.safeParse(layout).success).toBe(true);
    expect(displayLayoutSchema.safeParse({ ...layout, tiles: [layout.tiles[0], { ...layout.tiles[1], id: 'a' }] }).success).toBe(false);
    expect(displayLayoutSchema.safeParse({ ...layout, tiles: [{ ...layout.tiles[0], type: 'ndi' }] }).success).toBe(false);
  });
});
