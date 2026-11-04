import { describe, expect, it } from 'vitest';
import { vehiclePosition, type GeoPosition } from '@elvis/shared';
import { openDb } from '../db/index.js';
import { HttpError } from '../errors.js';
import { VehiclePositionService } from './vehiclePosition.js';

const setup = (gps: GeoPosition | null) => {
  const state = { gps, notified: 0 };
  const service = new VehiclePositionService(openDb(':memory:'), () => state.gps, () => state.notified++);
  return { state, service };
};

describe('Fahrzeugstandort', () => {
  it('ohne GPS-Empfänger von Hand setzen und wieder entfernen', () => {
    const { state, service } = setup(null);
    expect(service.current()).toBeNull();
    const m = service.set({ lat: 52.6, lon: 8.37 }, 'Müller');
    expect(m).toMatchObject({ lat: 52.6, lon: 8.37, setBy: 'Müller' });
    expect(service.current()).toMatchObject({ lat: 52.6, lon: 8.37, source: 'manual', setBy: 'Müller' });
    expect(state.notified).toBe(1);
    expect(service.clear()).toBe(true);
    expect(service.current()).toBeNull();
    expect(service.clear()).toBe(false);
    expect(state.notified).toBe(2);
  });

  it('ohne GPS-Empfang geht die gesetzte Position vor die letzte GPS-Position', () => {
    const { service } = setup({ lat: 51, lon: 10, headingDeg: 90, fix: false });
    expect(service.current()).toMatchObject({ lat: 51, lon: 10, source: 'last-gps' });
    service.set({ lat: 52.6, lon: 8.37 }, 'Müller');
    expect(service.current()).toMatchObject({ lat: 52.6, lon: 8.37, source: 'manual', headingDeg: null });
  });

  it('mit GPS-Fix ist Setzen gesperrt und eine gesetzte Position wird verworfen', () => {
    const { state, service } = setup(null);
    service.set({ lat: 52.6, lon: 8.37 }, 'Müller');
    state.gps = { lat: 51, lon: 10, headingDeg: 90, fix: true };
    expect(service.current()).toMatchObject({ lat: 51, lon: 10, source: 'gps' });
    service.gpsChanged();
    expect(service.manual()).toBeNull();
    expect(() => service.set({ lat: 52, lon: 8 }, 'Müller')).toThrow(HttpError);
    // Fällt der Empfang wieder aus, gilt die (neuere) letzte GPS-Position
    state.gps = { ...state.gps, fix: false };
    expect(service.current()).toMatchObject({ lat: 51, lon: 10, source: 'last-gps' });
  });

  it('prüft die Koordinaten', () => {
    const { service } = setup(null);
    expect(() => service.set({ lat: 95, lon: 8 }, 'Müller')).toThrow();
  });

  it('Reihenfolge der Quellen', () => {
    const manual = { lat: 1, lon: 2, setAt: '2026-11-04T10:00:00.000Z', setBy: 'Müller' };
    expect(vehiclePosition(null, null)).toBeNull();
    expect(vehiclePosition(null, manual)?.source).toBe('manual');
    expect(vehiclePosition({ lat: 3, lon: 4, headingDeg: null, fix: true }, manual)?.source).toBe('gps');
  });
});
