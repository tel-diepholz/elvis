import { describe, expect, it } from 'vitest';
import { newMapObjectSchema } from './mapobjects';
import { formatAltitude, shipTypeLabel } from './traffic';

describe('Verfolgte Flugzeuge und Schiffe', () => {
  it('brauchen eine gültige Kennung und starten ohne Spur', () => {
    const plane = newMapObjectSchema.parse({ kind: 'aircraft', name: 'CHX31', lat: 52.6, lon: 8.3, data: { id: '3c4b26', detail: 'EC35' } });
    expect(plane.data).toEqual({ id: '3c4b26', detail: 'EC35', trail: [], last: null, lostSince: null });
    expect(newMapObjectSchema.safeParse({ kind: 'aircraft', name: 'X', lat: 52, lon: 8, data: { id: '3C4B26' } }).success).toBe(false);
    expect(newMapObjectSchema.safeParse({ kind: 'ship', name: 'WESERSTAR', lat: 53, lon: 8.8, data: { id: '211234560' } }).success).toBe(true);
    expect(newMapObjectSchema.safeParse({ kind: 'ship', name: 'X', lat: 53, lon: 8.8, data: { id: '12345' } }).success).toBe(false);
  });

  it('zeigen Höhe und Schiffstyp lesbar', () => {
    expect(formatAltitude(35000)).toBe('FL350');
    expect(formatAltitude(1500)).toBe('1.500 ft');
    expect(formatAltitude(0, true)).toBe('am Boden');
    expect(shipTypeLabel(79)).toBe('Frachtschiff');
    expect(shipTypeLabel(51)).toBe('SAR');
  });
});
