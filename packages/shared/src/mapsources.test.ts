import { describe, expect, it } from 'vitest';
import { mapSourceListSchema, mapSourcePresets } from './mapsources';

describe('Vorlagen für Kartenquellen', () => {
  it('sind gültige WMS-Quellen mit eindeutigen Kennungen', () => {
    const presets = mapSourcePresets(2026);
    expect(mapSourceListSchema.safeParse(presets).success).toBe(true);
    expect(presets.every((p) => p.url.includes('CRS=EPSG:3857') && p.url.includes('{bbox}'))).toBe(true);
    expect(presets.find((p) => p.id === 'lgln-dop')?.attribution).toBe('© GeoBasis-DE/LGLN 2026, CC BY 4.0');
  });
});
