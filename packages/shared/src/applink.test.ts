import { describe, expect, it } from 'vitest';
import { distanceM, formatDeviceId, normalizeDeviceId, pairInputSchema, SEND_INTERVAL_MS, shouldSendPosition } from './applink';

describe('App-Anbindung', () => {
  it('meldet die erste Position, ab 10 m Bewegung und spätestens nach 10 min', () => {
    const at = { lat: 52.6, lon: 8.37 };
    expect(shouldSendPosition(null, at, 0)).toBe(true);
    const last = { ...at, sentAt: 1_000 };
    expect(shouldSendPosition(last, { lat: 52.60005, lon: 8.37 }, 2_000)).toBe(false); // ~5,6 m
    expect(shouldSendPosition(last, { lat: 52.6001, lon: 8.37 }, 2_000)).toBe(true); // ~11 m
    expect(shouldSendPosition(last, at, 1_000 + SEND_INTERVAL_MS - 1)).toBe(false);
    expect(shouldSendPosition(last, at, 1_000 + SEND_INTERVAL_MS)).toBe(true);
  });

  it('rechnet Abstände in Metern', () => {
    expect(distanceM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111_195, -1);
  });

  it('nimmt die App-ID tolerant entgegen', () => {
    expect(normalizeDeviceId(' k7m2-qx9p ')).toBe('K7M2QX9P');
    expect(normalizeDeviceId('O1IL')).toBe('0111');
    expect(formatDeviceId('K7M2QX9P')).toBe('K7M2-QX9P');
    expect(pairInputSchema.parse({ deviceId: 'k7m2 qx9p', code: '123 456' })).toEqual({ deviceId: 'K7M2QX9P', code: '123456' });
    expect(pairInputSchema.safeParse({ deviceId: 'K7M2QX9U', code: '123456' }).success).toBe(false);
    expect(pairInputSchema.safeParse({ deviceId: 'K7M2QX9P', code: '12345' }).success).toBe(false);
  });
});
