import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HYDRAULICS,
  computeSupply,
  flatProfile,
  hoseCount,
  pointAt,
  pressureLossPer100m,
  projectOnProfile,
  resamplePath,
  suggestPumps,
  waterSupplyRequestSchema,
  type ProfilePoint,
} from './watersupply';

/** Gerader Weg nach Norden, alle 10 m ein Punkt; Höhe als Funktion der Strecke */
function line(lengthM: number, h: (d: number) => number = () => 0): ProfilePoint[] {
  const out: ProfilePoint[] = [];
  for (let d = 0; d <= lengthM; d += 10) out.push({ d, h: h(d), lat: 52.7 + d / 111_195, lon: 8.5 });
  return out;
}

describe('Wasserversorgung', () => {
  it('rechnet Reibungsverluste nach Tabellenwerten', () => {
    expect(pressureLossPer100m('B', 800)).toBeCloseTo(1.0);
    expect(pressureLossPer100m('B', 400)).toBeCloseTo(0.25);
    expect(pressureLossPer100m('A', 800)).toBeCloseTo(0.17);
    expect(pressureLossPer100m('F', 2000)).toBeCloseTo(0.25);
    expect(hoseCount(1000, 'B')).toBe(55);
    expect(hoseCount(1000, 'B', 0)).toBe(50);
  });

  it('begrenzt die Anzahl der Entnahmestellen', () => {
    expect(waterSupplyRequestSchema.parse({ lat: 52.7, lon: 8.5 }).count).toBe(5);
    expect(waterSupplyRequestSchema.safeParse({ lat: 52.7, lon: 8.5, count: 11 }).success).toBe(false);
  });

  it('tastet Wege gleichmäßig ab', () => {
    const path: [number, number][] = [
      [8.5, 52.7],
      [8.5, 52.7 + 100 / 111_195],
    ];
    const pts = resamplePath(path, 20);
    expect(pts).toHaveLength(6);
    expect(pts[1]!.d).toBe(20);
    expect(pts[5]!.d).toBeCloseTo(100, 0);
    // Höchstzahl: Abstand wird größer
    expect(resamplePath(path, 1, 11)).toHaveLength(11);
    expect(flatProfile(path).every((p) => p.h === 0)).toBe(true);
  });

  it('interpoliert und projiziert auf den Weg', () => {
    const p = line(100, (d) => d / 10);
    expect(pointAt(p, 55).h).toBeCloseTo(5.5);
    expect(pointAt(p, 500).d).toBe(100);
    // Punkt 30 m östlich neben km 0,040
    const lat = 52.7 + 40 / 111_195;
    expect(projectOnProfile(p, lat, 8.5 + 30 / 67_400)).toBeCloseTo(40, 0);
  });

  it('schlägt auf ebener Strecke alle 650 m eine Pumpe vor (B, 800 l/min, 8 → 1,5 bar)', () => {
    const p = line(2000);
    const { pumpDs, warnings } = suggestPumps(p, DEFAULT_HYDRAULICS);
    expect(pumpDs).toEqual([650, 1300, 1950]);
    expect(warnings).toEqual([]);
    const r = computeSupply(p, pumpDs, DEFAULT_HYDRAULICS);
    expect(r.pumps).toHaveLength(4);
    expect(r.pumps[0]!.inBar).toBeNull();
    expect(r.pumps[1]!.inBar).toBeCloseTo(1.5);
    expect(r.endBar).toBeCloseTo(7.5);
    expect(r.warnings).toEqual([]);
  });

  it('rechnet Steigungen mit 1 bar je 10 m', () => {
    // 300 m, 30 m Steigung: 3 bar Reibung + 3 bar Höhe → 2 bar am Ende, keine Pumpe
    const gentle = line(300, (d) => d / 10);
    expect(suggestPumps(gentle, DEFAULT_HYDRAULICS).pumpDs).toEqual([]);
    expect(computeSupply(gentle, [], DEFAULT_HYDRAULICS).endBar).toBeCloseTo(2);
    // doppelte Steigung: 0,03 bar/m → 1,5 bar nach 216,7 m, Pumpe bei 216 m
    const steep = line(300, (d) => d / 5);
    expect(suggestPumps(steep, DEFAULT_HYDRAULICS).pumpDs).toEqual([216]);
    expect(computeSupply(steep, [216], DEFAULT_HYDRAULICS).warnings).toEqual([]);
    // Gefälle bringt Druck
    expect(computeSupply(line(300, (d) => -d / 10), [], DEFAULT_HYDRAULICS).endBar).toBeCloseTo(8);
  });

  it('warnt bei verschobenen Pumpen und unmöglichen Vorgaben', () => {
    const p = line(2000);
    const r = computeSupply(p, [900], DEFAULT_HYDRAULICS);
    expect(r.pumps[1]!.inBar).toBeCloseTo(-1);
    expect(r.warnings[0]).toContain('Pumpe 2 (km 0,90)');
    expect(r.warnings.some((w) => w.includes('Einsatzort'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Unterdruck'))).toBe(true);
    // 110 m Steigung auf 10 m schafft keine Pumpe
    const wall = line(100, (d) => (d >= 10 ? 110 : 0));
    expect(suggestPumps(wall, DEFAULT_HYDRAULICS).warnings[0]).toContain('nicht zu schaffen');
  });

  it('A-Schlauch braucht weniger Pumpen', () => {
    const p = line(2000);
    expect(suggestPumps(p, { ...DEFAULT_HYDRAULICS, hose: 'A' }).pumpDs).toEqual([]);
  });
});
