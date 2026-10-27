import { describe, expect, it } from 'vitest';
import { latLonToUtm, outlineArea, parseCoordinates, toMgrs, utmToLatLon } from './geocode';

// Referenzwerte aus der Bibliothek mgrs (proj4js) 2.1.0
const REF = [
  { n: 'Barnstorf', lat: 52.709856, lon: 8.5042465, mgrs: '32U MD 66507 40110' },
  { n: 'Brandenburger Tor', lat: 52.516275, lon: 13.377704, mgrs: '33U UU 89918 19699' },
  { n: 'Zugspitze', lat: 47.421111, lon: 10.985278, mgrs: '32T PT 49739 53872' },
  { n: 'Flensburg', lat: 54.7833, lon: 9.4333, mgrs: '32U NF 27866 70763' },
  { n: 'Görlitz', lat: 51.1526, lon: 14.9873, mgrs: '33U VS 99111 66794' },
  { n: 'Aachen', lat: 50.7753, lon: 6.0839, mgrs: '32U KB 94409 28892' },
];

describe('UTM und UTMREF', () => {
  it.each(REF)('$n: Koordinate → UTMREF', ({ lat, lon, mgrs }) => {
    expect(toMgrs(lat, lon)).toBe(mgrs);
  });

  it.each(REF)('$n: UTMREF → Koordinate (Mitte des 1-m-Quadrats)', ({ lat, lon, mgrs }) => {
    const p = parseCoordinates(mgrs)!;
    expect(p.format).toBe('UTMREF');
    expect(p.lat).toBeCloseTo(lat, 4);
    expect(p.lon).toBeCloseTo(lon, 4);
  });

  it('versteht UTMREF ohne Leerzeichen, klein geschrieben und mit geringerer Genauigkeit', () => {
    expect(parseCoordinates('32umd6650740110')).toMatchObject({ format: 'UTMREF' });
    const coarse = parseCoordinates('32U MD 6650 4011')!; // 10-m-Quadrat
    expect(coarse.lat).toBeCloseTo(52.70985, 3);
    expect(coarse.lon).toBeCloseTo(8.5042, 3);
    expect(parseCoordinates('32U MD 665 40110')).toBeNull(); // ungleich viele Ziffern
    expect(parseCoordinates('32U MI 66507 40110')).toBeNull(); // I gibt es nicht
  });

  it('rechnet UTM hin und zurück', () => {
    for (const { lat, lon } of REF) {
      const u = latLonToUtm(lat, lon);
      const back = utmToLatLon(u.zone, true, u.easting, u.northing);
      expect(back.lat).toBeCloseTo(lat, 7);
      expect(back.lon).toBeCloseTo(lon, 7);
    }
    expect(latLonToUtm(52.709856, 8.5042465)).toMatchObject({ zone: 32, band: 'U' });
    const p = parseCoordinates('32U 466507 5840110')!;
    expect(p.format).toBe('UTM');
    expect(p.lat).toBeCloseTo(52.70985, 4);
    expect(p.lon).toBeCloseTo(8.50424, 4);
  });
});

describe('Koordinaten im Suchtext', () => {
  it.each([
    ['52.709856, 8.5042465', 52.709856, 8.5042465],
    ['52.709856 8.5042465', 52.709856, 8.5042465],
    ['52,709856 8,5042465', 52.709856, 8.5042465],
    ['52.709856;8.5042465', 52.709856, 8.5042465],
    ['-33.86, 151.21', -33.86, 151.21],
    ['N 52° 42.591\' E 8° 30.255\'', 52.70985, 8.50425],
    ['52°42\'35.5"N 8°30\'15.3"E', 52.709861, 8.504250],
    ['E 8° 30.255\' N 52° 42.591\'', 52.70985, 8.50425],
    ['N52.7098 O8.5042', 52.7098, 8.5042],
  ])('%s', (q, lat, lon) => {
    const p = parseCoordinates(q)!;
    expect(p).not.toBeNull();
    expect(p.lat).toBeCloseTo(lat, 4);
    expect(p.lon).toBeCloseTo(lon, 4);
  });

  it.each(['Barnstorf', 'Lange Straße 3', '49406', 'B 51', 'A1 12', '95.1, 8.5', 'Hauptstraße 12, 49406 Barnstorf'])('„%s“ ist keine Koordinate', (q) => {
    expect(parseCoordinates(q)).toBeNull();
  });
});

describe('outlineArea', () => {
  // Quadrat von 100 m × 100 m bei 52° N (1 m in Breite ≈ 1/111 250°, in Länge entsprechend cos 52°)
  const square = (lat: number, lon: number, m: number) => {
    const dLat = m / 111_250;
    const dLon = m / (111_320 * Math.cos((lat * Math.PI) / 180));
    return [[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]];
  };

  it('misst ein Quadrat auf etwa 1 % genau', () => {
    expect(outlineArea({ type: 'Polygon', coordinates: [square(52, 8.5, 100)] })).toBeGreaterThan(9_900);
    expect(outlineArea({ type: 'Polygon', coordinates: [square(52, 8.5, 100)] })).toBeLessThan(10_100);
  });

  it('zieht Löcher ab und zählt Teilflächen zusammen', () => {
    const holed = outlineArea({ type: 'Polygon', coordinates: [square(52, 8.5, 100), square(52.0002, 8.5003, 20)] });
    expect(holed).toBeGreaterThan(9_500);
    expect(holed).toBeLessThan(9_700);
    const multi = outlineArea({ type: 'MultiPolygon', coordinates: [[square(52, 8.5, 100)], [square(53, 9, 100)]] });
    expect(multi).toBeGreaterThan(19_800);
    expect(multi).toBeLessThan(20_200);
  });
});
