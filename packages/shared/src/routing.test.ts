import { describe, expect, it } from 'vitest';
import { formatDistance, formatDuration, routeRequestSchema, routeSummary } from './routing';

describe('Routenplanung', () => {
  it('formatiert Strecke und Fahrzeit', () => {
    expect(formatDistance(847)).toBe('850 m');
    expect(formatDistance(12_345)).toBe('12,3 km');
    expect(formatDistance(127_800)).toBe('128 km');
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(899)).toBe('15 min');
    expect(formatDuration(3900)).toBe('1 h 05 min');
    expect(routeSummary({ distanceM: 12_345, durationS: 899, profile: 'truck' })).toBe('12,3 km · 15 min · LKW');
  });

  it('verlangt Start und Ziel', () => {
    const stop = { lat: 52.7, lon: 8.5, name: 'A' };
    expect(routeRequestSchema.safeParse({ stops: [stop] }).success).toBe(false);
    expect(routeRequestSchema.parse({ stops: [stop, stop] }).profile).toBe('auto');
    expect(routeRequestSchema.safeParse({ profile: 'bicycle', stops: [stop, stop] }).success).toBe(false);
  });
});
