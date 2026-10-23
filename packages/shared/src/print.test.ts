import { describe, expect, it } from 'vitest';
import { metersPerPixel, niceScale, printFrame, project, unproject } from './print';

describe('Druckgeometrie', () => {
  it('projiziert hin und zurück ohne Verlust', () => {
    const p = project(51.1657, 10.4515, 16);
    const back = unproject(p, 16);
    expect(back.lat).toBeCloseTo(51.1657, 9);
    expect(back.lon).toBeCloseTo(10.4515, 9);
  });

  it('berechnet Kartenfläche und Maßstab für A1 hochkant', () => {
    const f = printFrame({ lat: 51.1657, lon: 10.4515 }, 16, 'A1', 'portrait');
    expect(f.mapWidthMm).toBe(574);
    expect(f.mapHeightMm).toBe(821);
    expect(f.widthPx).toBe(2296);
    expect(f.heightPx).toBe(3284);
    // 1 px = 0,25 mm; bei z16 und 51,17° ≈ 1,5 m/px → 1:6000
    expect(f.scale).toBeCloseTo(metersPerPixel(51.1657, 16) / 0.00025, 6);
    expect(niceScale(f.scale)).toBe(6000);
  });

  it('liegt mittig um den gewählten Punkt und vertauscht Seiten im Querformat', () => {
    const c = { lat: 51.1657, lon: 10.4515 };
    const p = printFrame(c, 15, 'A3', 'portrait');
    const l = printFrame(c, 15, 'A3', 'landscape');
    expect((p.bounds.west + p.bounds.east) / 2).toBeCloseTo(c.lon, 9);
    expect(l.widthPx).toBe(p.heightPx);
    expect(l.heightPx).toBe(p.widthPx);
  });

  it('halbiert den Maßstab je Zoomstufe', () => {
    const c = { lat: 50, lon: 8 };
    expect(printFrame(c, 15, 'A2', 'portrait').scale / printFrame(c, 16, 'A2', 'portrait').scale).toBeCloseTo(2, 9);
  });
});
