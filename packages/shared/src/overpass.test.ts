import { describe, expect, it } from 'vitest';
import { applyBbox, buildOverpassQl, overpassBadge, overpassBoundsSchema, overpassQuerySchema, overpassToFeatures } from './overpass';
import { newMapObjectSchema } from './mapobjects';

const g = (...pts: [number, number][]) => pts.map(([lat, lon]) => ({ lat, lon }));

describe('Overpass-Abfrage', () => {
  it('baut QL aus dem einfachen Filter', () => {
    const ql = buildOverpassQl('nwr', [
      { key: 'amenity', op: '=', value: 'fire_station' },
      { key: 'name', op: 'exists', value: '' },
      { key: 'operator', op: '~', value: 'Feuer"wehr' },
    ]);
    expect(ql).toBe('[out:json][timeout:60];\nnwr["amenity"="fire_station"]["name"]["operator"~"Feuer\\"wehr"]({{bbox}});\nout geom;');
  });

  it('setzt den Kartenausschnitt ein', () => {
    expect(applyBbox('node({{bbox}});way({{ bbox }});', { s: 52.5, w: 8.4, n: 52.8, e: 8.7 })).toBe('node(52.5,8.4,52.8,8.7);way(52.5,8.4,52.8,8.7);');
  });

  it('prüft Abfragen und Ausschnitt', () => {
    expect(overpassQuerySchema.safeParse({ name: 'X', mode: 'simple', filters: [] }).success).toBe(false);
    expect(overpassQuerySchema.safeParse({ name: 'X', mode: 'simple', filters: [{ key: 'a', op: '=', value: '' }] }).success).toBe(false);
    expect(overpassQuerySchema.safeParse({ name: 'X', mode: 'ql', ql: ' ' }).success).toBe(false);
    const hydrants = overpassQuerySchema.parse({ name: 'Hydranten', mode: 'simple', filters: [{ key: 'emergency', op: '=', value: 'fire_hydrant' }], icon: 'Droplet', badge: 'DN {fire_hydrant:diameter}' });
    expect(hydrants).toMatchObject({ elements: 'nwr', ql: '', icon: 'Droplet', badge: 'DN {fire_hydrant:diameter}' });
    expect(overpassQuerySchema.parse({ name: 'X', mode: 'ql', ql: 'node;out;' })).toMatchObject({ icon: null, badge: '' });
    expect(overpassQuerySchema.safeParse({ name: 'X', mode: 'ql', ql: 'node;out;', icon: 'flame' }).success).toBe(false);
    expect(overpassBoundsSchema.safeParse({ s: 50, w: 8, n: 54, e: 9 }).success).toBe(false);
  });
});

describe('Schild am Symbol', () => {
  it('setzt Tag-Werte ein und lässt das Schild ohne Werte weg', () => {
    const tags = { 'fire_hydrant:diameter': '100', 'fire_hydrant:type': 'underground' };
    expect(overpassBadge('DN {fire_hydrant:diameter}', tags)).toBe('DN 100');
    expect(overpassBadge('{ fire_hydrant:type } {fire_hydrant:pressure}', tags)).toBe('underground');
    expect(overpassBadge('DN {diameter}', tags)).toBe('');
    expect(overpassBadge('B', tags)).toBe('B');
    expect(overpassBadge('', tags)).toBe('');
  });
});

describe('Overpass-Antwort → Treffer', () => {
  it('Punkte, offene und geschlossene Wege', () => {
    const { features, skipped } = overpassToFeatures({
      elements: [
        { type: 'node', id: 1, lat: 52.7, lon: 8.5, tags: { emergency: 'fire_hydrant', 'fire_hydrant:type': 'underground', 'fire_hydrant:diameter': '100' } },
        { type: 'node', id: 2, lat: 52.7, lon: 8.5 },
        { type: 'way', id: 10, geometry: g([0, 0], [0, 1], [1, 1], [0, 0]), tags: { amenity: 'fire_station', name: 'FF Barnstorf', 'addr:street': 'Bahnhofstraße', 'addr:housenumber': '5', 'addr:city': 'Barnstorf' } },
        { type: 'way', id: 11, geometry: g([0, 0], [0, 1], [1, 1], [0, 0]), tags: { highway: 'residential' } },
        { type: 'way', id: 12, geometry: g([0, 0], [0, 1]), tags: { waterway: 'river' } },
        { type: 'way', id: 13, tags: { building: 'yes' } },
      ],
    });
    expect(skipped).toBe(1);
    expect(features.map((f) => [f.id, f.geometry.type])).toEqual([
      ['N1', 'Point'],
      ['W10', 'Polygon'],
      ['W11', 'LineString'],
      ['W12', 'LineString'],
    ]);
    expect(features[0]).toMatchObject({ name: 'Hydrant', detail: 'Unterflur DN 100', lat: 52.7, lon: 8.5 });
    expect(features[1]).toMatchObject({ name: 'FF Barnstorf', detail: 'Feuerwehrhaus · Bahnhofstraße 5, Barnstorf', lat: 0.5, lon: 0.5 });
  });

  it('setzt Multipolygone aus Wegstücken zusammen', () => {
    const { features } = overpassToFeatures({
      elements: [
        {
          type: 'relation',
          id: 5,
          tags: { type: 'multipolygon', landuse: 'forest' },
          members: [
            { type: 'way', ref: 1, role: 'outer', geometry: g([0, 0], [0, 10], [10, 10]) },
            { type: 'way', ref: 2, role: 'outer', geometry: g([0, 0], [10, 0], [10, 10]) },
            { type: 'way', ref: 3, role: 'inner', geometry: g([2, 2], [2, 3], [3, 3], [2, 2]) },
            { type: 'way', ref: 4, role: 'outer', geometry: g([20, 20], [20, 21], [21, 21], [20, 20]) },
          ],
        },
      ],
    });
    const geom = features[0]!.geometry;
    expect(geom.type).toBe('MultiPolygon');
    if (geom.type !== 'MultiPolygon') return;
    expect(geom.coordinates).toHaveLength(2);
    expect(geom.coordinates[0]).toHaveLength(2);
    expect(geom.coordinates[0]![0]).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    expect(geom.coordinates[1]).toHaveLength(1);
  });

  it('kürzt auf die Höchstzahl und nimmt „out center“ als Punkt', () => {
    const elements = Array.from({ length: 5 }, (_, i) => ({ type: 'way', id: i, center: { lat: 1, lon: 2 }, tags: { amenity: 'school' } }));
    const r = overpassToFeatures({ elements }, 3);
    expect(r.features).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.features[0]!.geometry).toEqual({ type: 'Point', coordinates: [2, 1] });
  });

  it('Linie als Kartenobjekt', () => {
    const ok = newMapObjectSchema.safeParse({ kind: 'line', name: 'Hunte', lat: 52, lon: 8, data: { detail: '', osm: 'W12', path: { type: 'LineString', coordinates: [[8, 52], [8.1, 52.1]] } } });
    expect(ok.success).toBe(true);
    const bad = newMapObjectSchema.safeParse({ kind: 'line', name: 'X', lat: 52, lon: 8, data: { detail: '', osm: null, path: { type: 'LineString', coordinates: [[8, 52]] } } });
    expect(bad.success).toBe(false);
  });
});
