import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WeatherReport } from '@elvis/shared';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { WeatherAlertWatch, WeatherService, warningAlerts, type WeatherFetch } from './weather.js';
import type { AlertDraft } from '../alerts.js';
import { adminCookie } from '../test-helpers.js';

const FORECAST = 'https://meteo.example';
const WARNINGS = 'https://warn.example';

const openMeteo = {
  latitude: 52.70585,
  longitude: 8.514921,
  elevation: 40,
  current: { time: 1792957500, temperature_2m: 9.8, apparent_temperature: 6.1, weather_code: 2, wind_speed_10m: 7.3, wind_gusts_10m: 15.2, wind_direction_10m: 230, is_day: 1 },
  hourly: { time: [1792954800, 1792958400], temperature_2m: [10.1, 9.7], precipitation_probability: [20, null], weather_code: [2, 80], is_day: [1, 0] },
  daily: { time: [1792882800], weather_code: [80], temperature_2m_min: [6.2], temperature_2m_max: [11.4], sunrise: [1792908584], sunset: [1792944000] },
};

const alert = (id: string, severity: string, extra: object = {}) => ({
  alert_id: id,
  status: 'actual',
  effective: '2026-10-25T11:18:00+00:00',
  onset: '2026-10-25T17:00:00+00:00',
  expires: '2026-10-25T23:00:00+00:00',
  severity,
  event_de: 'WINDBÖEN',
  headline_de: 'Amtliche WARNUNG vor WINDBÖEN',
  description_de: 'Es treten Windböen auf.',
  instruction_de: 'Lose Gegenstände sichern',
  ...extra,
});

const brightSky = {
  alerts: [alert('a', 'minor'), alert('b', 'severe'), alert('test', 'extreme', { status: 'test' }), alert('alt', 'moderate', { expires: '2026-10-25T10:00:00+00:00' })],
  location: { name: 'Gemeinde Barnstorf' },
};

function fakeFetch(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch: WeatherFetch = async (url) => {
    calls.push(url);
    const base = Object.keys(answers).find((b) => url.startsWith(b));
    const a = base ? answers[base] : new Error('unbekannt');
    if (a instanceof Error) throw a;
    return a;
  };
  return { fetch, calls };
}

const NOW = Date.parse('2026-10-25T12:00:00Z');

/** Abruf im Hintergrund abschließen lassen */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Wetter', () => {
  it('liefert Prognose und Warnungen, schwerste zuerst, ohne Tests und abgelaufene', async () => {
    const f = fakeFetch({ [FORECAST]: openMeteo, [WARNINGS]: brightSky });
    const w = new WeatherService({ forecastUrl: FORECAST, warningsUrl: `${WARNINGS}/`, userAgent: 'ELVIS-Test' }, f.fetch, () => NOW);
    const r = await w.report(52.70986, 8.50425);
    expect(f.calls[0]).toContain('latitude=52.71&longitude=8.5&');
    expect(f.calls[1]).toBe(`${WARNINGS}/alerts?lat=52.71&lon=8.5`);
    expect(r.forecastError).toBeNull();
    expect(r.forecast!.current).toMatchObject({ temperatureC: 9.8, windGustMs: 15.2, windDirectionDeg: 230, humidityPercent: null, isDay: true });
    expect(r.forecast!.hourly).toHaveLength(2);
    expect(r.forecast!.hourly[1]).toMatchObject({ precipitationProbability: null, weatherCode: 80, isDay: false });
    expect(r.forecast!.daily[0]).toMatchObject({ tempMinC: 6.2, tempMaxC: 11.4, sunrise: new Date(1792908584 * 1000).toISOString() });
    expect(r.warnings!.area).toBe('Gemeinde Barnstorf');
    expect(r.warnings!.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(r.warnings!.items[0]).toMatchObject({ event: 'WINDBÖEN', severity: 'severe', instruction: 'Lose Gegenstände sichern' });
  });

  it('hält Antworten je Standort vor und zeigt bei Ausfall den letzten Stand', async () => {
    let now = NOW;
    const answers: Record<string, unknown> = { [FORECAST]: openMeteo, [WARNINGS]: brightSky };
    const f = fakeFetch(answers);
    const w = new WeatherService({ forecastUrl: FORECAST, warningsUrl: WARNINGS, userAgent: 'ELVIS-Test' }, f.fetch, () => now);
    await w.report(52.70986, 8.50425);
    // GPS wandert ein paar Meter: gleiche Kachel, keine neue Anfrage
    await w.report(52.7102, 8.5039);
    expect(f.calls).toHaveLength(2);

    // nach 15 Minuten neu laden; die Abfrage wartet nicht darauf, sondern liefert den vorhandenen Stand
    now += 20 * 60_000;
    answers[FORECAST] = new Error('HTTP 503');
    const first = await w.report(52.70986, 8.50425);
    expect(f.calls).toHaveLength(4);
    expect(first.forecastError).toBeNull();
    await settle();
    const r = await w.report(52.70986, 8.50425);
    expect(r.forecast?.current.temperatureC).toBe(9.8);
    expect(r.forecast?.fetchedAt).toBe(new Date(NOW).toISOString());
    expect(r.forecastError).toMatch(/HTTP 503/);
    expect(r.warningsError).toBeNull();

    // nach einem Fehler erst nach einer Minute wieder fragen
    now += 30_000;
    await w.report(52.70986, 8.50425);
    expect(f.calls).toHaveLength(4);

    // der letzte Stand bleibt, bis ein Abruf gelingt – auch nach Stunden
    now += 24 * 3600_000;
    await w.report(52.70986, 8.50425);
    await settle();
    expect((await w.report(52.70986, 8.50425)).forecast?.current.temperatureC).toBe(9.8);
    answers[FORECAST] = { ...openMeteo, current: { ...openMeteo.current, temperature_2m: 12.5 } };
    now += 60_000;
    await w.report(52.70986, 8.50425);
    await settle();
    const fresh = await w.report(52.70986, 8.50425);
    expect(fresh.forecast?.current.temperatureC).toBe(12.5);
    expect(fresh.forecastError).toBeNull();
  });

  it('übersteht mit dem letzten Stand einen Neustart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-weather-'));
    try {
      const cacheFile = join(dir, 'weather-cache.json');
      const opts = { forecastUrl: FORECAST, warningsUrl: WARNINGS, userAgent: 'ELVIS-Test', cacheFile };
      await new WeatherService(opts, fakeFetch({ [FORECAST]: openMeteo, [WARNINGS]: brightSky }).fetch, () => NOW).report(52.71, 8.5);

      // nach dem Neustart ist der Dienst nicht erreichbar: der gesicherte Stand wird sofort geliefert
      const offline = fakeFetch({});
      const w = new WeatherService(opts, offline.fetch, () => NOW + 60_000);
      const r = await w.report(52.71, 8.5);
      expect(offline.calls).toHaveLength(0);
      expect(r.forecast?.current.temperatureC).toBe(9.8);
      expect(r.warnings?.items.map((i) => i.id)).toEqual(['b', 'a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('meldet abgeschaltete und unerreichbare Dienste', async () => {
    const f = fakeFetch({});
    const w = new WeatherService({ forecastUrl: null, warningsUrl: WARNINGS, userAgent: 'ELVIS-Test' }, f.fetch, () => NOW);
    const r = await w.report(50, 10);
    expect(r).toMatchObject({ forecast: null, forecastError: 'Wetterprognose ist abgeschaltet', warnings: null });
    expect(r.warningsError).toMatch(/nicht erreichbar/);
  });

  it('ist ohne Anmeldung abrufbar und prüft die Koordinaten', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'elvis-weather-'));
    const f = fakeFetch({ 'https://api.open-meteo.com': openMeteo, 'https://api.brightsky.dev': { alerts: [], location: null } });
    const app = await buildApp(parseConfig({ dataDir, docker: { enabled: false } }), { logger: false, weatherFetch: f.fetch });
    try {
      const res = await app.server.inject({ method: 'GET', url: '/api/weather?lat=52.7&lon=8.5' });
      expect(res.statusCode).toBe(200);
      const body = res.json<WeatherReport>();
      expect(body.forecast?.current.temperatureC).toBe(9.8);
      expect(body.warnings).toMatchObject({ area: null, items: [] });
      expect((await app.server.inject({ method: 'GET', url: '/api/weather?lat=95&lon=8.5' })).statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('druckt den Wetterbericht als PDF nur mit Anmeldung und protokolliert das', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'elvis-weather-'));
    const f = fakeFetch({ 'https://api.open-meteo.com': openMeteo, 'https://api.brightsky.dev': brightSky });
    const app = await buildApp(parseConfig({ dataDir, docker: { enabled: false }, devices: { weather: { driver: 'sim' } } }), { logger: false, weatherFetch: f.fetch });
    try {
      const payload = { lat: 52.7, lon: 8.5 };
      expect((await app.server.inject({ method: 'POST', url: '/api/print/weather', payload })).statusCode).toBe(401);
      const cookie = await adminCookie(app);
      const res = await app.server.inject({ method: 'POST', url: '/api/print/weather', headers: { cookie }, payload });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/Wetterbericht_.*\.pdf/);
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      const audit = (await app.server.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).json<{ target: string; action: string }[]>();
      expect(audit.some((a) => a.target === 'wetter' && a.action === 'print')).toBe(true);
      expect((await app.server.inject({ method: 'POST', url: '/api/print/weather', headers: { cookie }, payload: { lat: 95, lon: 8.5 } })).statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('meldet Unwetter ab Stufe 3, extremes Unwetter als Alarm', () => {
    const now = new Date(NOW);
    const warnings = {
      area: 'Gemeinde Barnstorf',
      fetchedAt: now.toISOString(),
      items: [
        { id: 'x', event: 'ORKANBÖEN', headline: '', description: '', instruction: '', severity: 'extreme' as const, effective: '', onset: '2026-10-25T17:00:00Z', expires: '2026-10-25T23:00:00Z' },
        { id: 'r', event: 'STURMBÖEN', headline: '', description: '', instruction: '', severity: 'severe' as const, effective: '', onset: '2026-10-25T10:00:00Z', expires: null },
        { id: 'g', event: 'WINDBÖEN', headline: '', description: '', instruction: '', severity: 'moderate' as const, effective: '', onset: '2026-10-25T10:00:00Z', expires: null },
        { id: 'alt', event: 'GEWITTER', headline: '', description: '', instruction: '', severity: 'severe' as const, effective: '', onset: '2026-10-25T08:00:00Z', expires: '2026-10-25T11:00:00Z' },
      ],
    };
    expect(warningAlerts(warnings, now)).toEqual([
      { id: 'dwd:x', severity: 'alarm', system: 'weather', title: 'Extremes Unwetter: Orkanböen', detail: 'ab So., 18:00 bis Mo., 00:00 · Gemeinde Barnstorf' },
      { id: 'dwd:r', severity: 'warn', system: 'weather', title: 'Unwetterwarnung: Sturmböen', detail: 'Gemeinde Barnstorf' },
    ]);
    expect(warningAlerts(null, now)).toEqual([]);
  });

  it('prüft die Warnungen am Fahrzeugstandort und räumt sie ohne Standort weg', async () => {
    const f = fakeFetch({ [FORECAST]: openMeteo, [WARNINGS]: brightSky });
    const w = new WeatherService({ forecastUrl: FORECAST, warningsUrl: WARNINGS, userAgent: 'ELVIS-Test' }, f.fetch, () => NOW);
    let pos: { lat: number; lon: number } | null = { lat: 52.71, lon: 8.5 };
    const published: AlertDraft[][] = [];
    const watch = new WeatherAlertWatch(w, () => pos, (a) => published.push(a), () => new Date(NOW));
    await watch.check();
    expect(published.at(-1)!.map((a) => a.id)).toEqual(['dwd:b']);
    expect(watch.warnings()!.items.map((i) => i.id)).toEqual(['b', 'a']);
    pos = null;
    await watch.check();
    expect(published.at(-1)).toEqual([]);
    expect(watch.warnings()).toBeNull();
  });
});
