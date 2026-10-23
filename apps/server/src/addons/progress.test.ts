import { describe, expect, it } from 'vitest';
import { createProgressParser, nextScheduledRun, overallPercent } from './progress.js';

describe('Fortschritt', () => {
  it('liest ELVIS_PROGRESS-Zeilen aus eigenen Skripten', () => {
    const p = createProgressParser();
    p.feed('Starte Download …');
    expect(p.state).toEqual({ percent: null, message: null });
    p.feed('ELVIS_PROGRESS 25 Lade germany/thueringen');
    p.feed('ELVIS_PROGRESS 10 Rücksprung');
    expect(p.state).toEqual({ percent: 25, message: 'Rücksprung' });
  });

  it('ordnet Planetiler-Phasen zu und verfeinert mit Prozentangaben', () => {
    const p = createProgressParser({
      phases: [
        { match: '\\[osm_pass1', percent: 10, label: 'OSM lesen (1/2)' },
        { match: '\\[osm_pass2', percent: 40, label: 'OSM lesen (2/2)' },
        { match: '\\[sort', percent: 70 },
      ],
      inlinePercent: true,
    });
    p.feed('3:01:00 INF [osm_pass1] - nodes: [ 1M 50% ]');
    expect(p.state.percent).toBe(25); // 10 + (40-10)*0,5
    expect(p.state.message).toBe('OSM lesen (1/2)');
    p.feed('3:05:00 INF [osm_pass2] - started');
    expect(p.state.percent).toBe(40);
    p.feed('3:06:00 INF [osm_pass1] - 90%'); // ältere Phase ändert nichts
    expect(p.state.percent).toBe(40);
  });

  it('gewichtet die Schritte zum Gesamtfortschritt', () => {
    expect(
      overallPercent([
        { state: 'done', percent: 100, weight: 1 },
        { state: 'running', percent: 50, weight: 2 },
        { state: 'pending', percent: null, weight: 1 },
      ]),
    ).toBe(50);
    expect(overallPercent([{ state: 'pending', percent: null, weight: 1 }])).toBe(0);
  });
});

describe('Zeitplan', () => {
  const d = (s: string) => new Date(s);
  it('plant täglich, wöchentlich und monatlich zur gewählten Stunde', () => {
    expect(nextScheduledRun('daily', 3, d('2026-10-20T15:30:00'), d('2026-10-20T16:00:00'))?.toString()).toBe(d('2026-10-21T03:00:00').toString());
    expect(nextScheduledRun('weekly', 3, d('2026-10-20T03:00:00'), d('2026-10-20T04:00:00'))?.toString()).toBe(d('2026-10-27T03:00:00').toString());
    expect(nextScheduledRun('monthly', 2, d('2026-10-01T02:00:00'), d('2026-10-01T02:30:00'))?.toString()).toBe(d('2026-10-31T02:00:00').toString());
    expect(nextScheduledRun('never', 3, null, d('2026-10-20T00:00:00'))).toBeNull();
  });
  it('nimmt ohne bisherigen Lauf die nächste passende Stunde', () => {
    expect(nextScheduledRun('daily', 3, null, d('2026-10-20T01:00:00'))?.toString()).toBe(d('2026-10-20T03:00:00').toString());
    expect(nextScheduledRun('daily', 3, null, d('2026-10-20T05:00:00'))?.toString()).toBe(d('2026-10-21T03:00:00').toString());
  });
});
