import { describe, expect, it } from 'vitest';
import {
  concentrationPerRate,
  estimateStability,
  plumeContour,
  plumeToLatLon,
  sigmas,
  sunElevationDeg,
  type PlumeParams,
} from './dispersion';

const neutral: PlumeParams = { stability: 'III/1', terrain: 'rural', windSpeed10mMs: 5, sourceHeightM: 0 };

describe('Ausbreitungsparameter und Konzentration', () => {
  it('liefert die Briggs-Werte für Klasse D, offenes Gelände', () => {
    const { sy, sz } = sigmas(1000, 'III/1', 'rural');
    expect(sy).toBeCloseTo(0.08 * 1000 / Math.sqrt(1.1), 6);
    expect(sz).toBeCloseTo(0.06 * 1000 / Math.sqrt(2.5), 6);
  });

  it('berechnet c/Q auf der Fahnenachse einer Bodenquelle', () => {
    // 1 / (π · 76,28 · 37,95 · 5) ≈ 2,199e-5 s/m³
    expect(concentrationPerRate(1000, 0, neutral)).toBeCloseTo(2.199e-5, 8);
  });

  it('ist symmetrisch zur Fahnenachse und fällt quer dazu ab', () => {
    const c = (y: number) => concentrationPerRate(500, y, neutral);
    expect(c(30)).toBeCloseTo(c(-30), 12);
    expect(c(30)).toBeLessThan(c(0));
  });

  it('verringert die Bodenkonzentration nahe einer erhöhten Quelle', () => {
    const elevated = { ...neutral, sourceHeightM: 30 };
    expect(concentrationPerRate(100, 0, elevated)).toBeLessThan(concentrationPerRate(100, 0, neutral));
  });
});

describe('Isolinien', () => {
  it('trifft die Schwelle am Rand und an der Spitze', () => {
    const T = 1e-4;
    const contour = plumeContour(neutral, T)!;
    expect(contour.truncated).toBe(false);
    expect(concentrationPerRate(contour.maxDistanceM, 0, neutral) / T).toBeCloseTo(1, 4);
    const edge = contour.outline[Math.floor(contour.outline.length / 4)]!;
    expect(concentrationPerRate(edge.x, edge.y, neutral) / T).toBeCloseTo(1, 4);
  });

  it('reicht bei stabiler Schichtung weiter als bei labiler', () => {
    const T = 1e-5;
    const stable = plumeContour({ ...neutral, stability: 'I', windSpeed10mMs: 2 }, T)!;
    const labile = plumeContour({ ...neutral, stability: 'IV', windSpeed10mMs: 2 }, T)!;
    expect(stable.maxDistanceM).toBeGreaterThan(labile.maxDistanceM);
  });

  it('meldet eine abgeschnittene Isolinie an der Rechengrenze', () => {
    const c = plumeContour({ ...neutral, stability: 'I', windSpeed10mMs: 1 }, 1e-6, { maxX: 5000 })!;
    expect(c.truncated).toBe(true);
    expect(c.maxDistanceM).toBe(5000);
  });

  it('liegt in Windrichtung: Wind aus West → Fahne nach Osten', () => {
    const [lat, lon] = plumeToLatLon({ lat: 51, lon: 10 }, 270, { x: 1000, y: 0 });
    expect(lat).toBeCloseTo(51, 6);
    expect(lon).toBeGreaterThan(10);
  });
});

describe('Ausbreitungsklasse', () => {
  it('klare Nacht und schwacher Wind → sehr stabil (I)', () => {
    expect(estimateStability({ windSpeedMs: 1.5, cloudOktas: 1, sunElevationDeg: -20 })).toBe('I');
  });
  it('bedeckter Himmel → neutral (III/1)', () => {
    expect(estimateStability({ windSpeedMs: 1.5, cloudOktas: 8, sunElevationDeg: 50 })).toBe('III/1');
  });
  it('hoher Sonnenstand und schwacher Wind → sehr labil (V)', () => {
    expect(estimateStability({ windSpeedMs: 1, cloudOktas: 0, sunElevationDeg: 62 })).toBe('V');
  });
  it('Dämmerung → neutral', () => {
    expect(estimateStability({ windSpeedMs: 2, cloudOktas: 0, sunElevationDeg: 5 })).toBe('III/1');
  });
});

describe('Sonnenstand', () => {
  it('Berlin zum Sommeranfang mittags ≈ 61°', () => {
    // 90° − 52,5° + 23,44° ≈ 60,9°; wahrer Mittag in Berlin ca. 11:08 UTC
    expect(sunElevationDeg(new Date('2026-06-21T11:08:00Z'), 52.5, 13.4)).toBeCloseTo(60.9, 0);
  });
  it('ist nachts negativ', () => {
    expect(sunElevationDeg(new Date('2026-06-21T23:00:00Z'), 52.5, 13.4)).toBeLessThan(0);
  });
});
