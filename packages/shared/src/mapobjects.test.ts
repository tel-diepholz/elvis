import { describe, expect, it } from 'vitest';
import { DEFAULT_GAUSS, DEFAULT_MANUAL_WIND, gaussWind } from './mapobjects';

describe('Wind einer Gauß-Fahne', () => {
  const station = { windSpeedMs: 5, windDirectionDeg: 90 };
  const manual = { windSpeedMs: 2, windDirectionDeg: 180 };
  it('Wetterstation geht vor', () => expect(gaussWind(station, { ...DEFAULT_GAUSS, manualWind: manual })).toEqual(station));
  it('ohne Wetterstation der Wind von Hand', () => expect(gaussWind(undefined, { ...DEFAULT_GAUSS, manualWind: manual })).toEqual(manual));
  it('ohne beides die Vorgabe', () => expect(gaussWind(null, DEFAULT_GAUSS)).toEqual(DEFAULT_MANUAL_WIND));
});

describe('Patch einer Gauß-Fahne', () => {
  it('übernimmt den Wind von Hand und prüft die Grenzen', async () => {
    const { mapObjectPatchSchema } = await import('./mapobjects');
    expect(mapObjectPatchSchema.parse({ data: { manualWind: { windSpeedMs: 4.5, windDirectionDeg: 225 } } }).data).toEqual({ manualWind: { windSpeedMs: 4.5, windDirectionDeg: 225 } });
    expect(mapObjectPatchSchema.safeParse({ data: { manualWind: { windSpeedMs: 50, windDirectionDeg: 225 } } }).success).toBe(false);
  });
});
