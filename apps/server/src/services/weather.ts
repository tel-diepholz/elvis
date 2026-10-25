import { WARNING_LEVEL, type WarningSeverity, type WeatherForecast, type WeatherReport, type WeatherWarning, type WeatherWarnings } from '@elvis/shared';
import type { AlertDraft } from '../alerts.js';

export interface WeatherOptions {
  /** Open-Meteo (https://open-meteo.com), null = keine Prognose */
  forecastUrl: string | null;
  /** Bright Sky (https://brightsky.dev) mit den Warnungen des DWD, null = keine Warnungen */
  warningsUrl: string | null;
  userAgent: string;
}

export type WeatherFetch = (url: string, opts: { timeoutMs: number; userAgent: string }) => Promise<unknown>;

const defaultFetch: WeatherFetch = async (url, { timeoutMs, userAgent }) => {
  const res = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const TIMEOUT_MS = 10_000;
const FORECAST_MS = 15 * 60_000;
const WARNINGS_MS = 5 * 60_000;
/** Nach einem Fehler so lange nicht erneut fragen */
const RETRY_MS = 60_000;
/** Veraltete Werte höchstens so lange zeigen, wenn der Dienst nicht erreichbar ist */
const STALE_MS = 12 * 3600_000;
const CACHE_MAX = 50;

const CURRENT = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day';
const HOURLY = 'temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day';
const DAILY =
  'weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset';

type Series = Record<string, (number | null)[] | undefined>;

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  elevation?: number;
  current?: Record<string, number | null | undefined>;
  hourly?: Series;
  daily?: Series;
}

interface BrightSkyAlert {
  alert_id?: string;
  id?: number;
  status?: string;
  effective?: string;
  onset?: string;
  expires?: string | null;
  severity?: string;
  event_de?: string | null;
  event_en?: string | null;
  headline_de?: string | null;
  headline_en?: string | null;
  description_de?: string | null;
  description_en?: string | null;
  instruction_de?: string | null;
  instruction_en?: string | null;
}

interface BrightSkyResponse {
  alerts?: BrightSkyAlert[];
  location?: { name?: string } | null;
}

const iso = (unix: number | null | undefined) => (typeof unix === 'number' ? new Date(unix * 1000).toISOString() : null);
const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Antwort von Open-Meteo (timeformat=unixtime, wind_speed_unit=ms) → Prognose */
export function toForecast(r: OpenMeteoResponse, fetchedAt: Date): WeatherForecast {
  const c = r.current ?? {};
  const h = r.hourly ?? {};
  const d = r.daily ?? {};
  const at = (s: Series, key: string, i: number) => num(s[key]?.[i]);
  return {
    lat: r.latitude,
    lon: r.longitude,
    elevationM: num(r.elevation),
    fetchedAt: fetchedAt.toISOString(),
    current: {
      time: iso(c.time) ?? fetchedAt.toISOString(),
      temperatureC: num(c.temperature_2m),
      feelsLikeC: num(c.apparent_temperature),
      humidityPercent: num(c.relative_humidity_2m),
      precipitationMm: num(c.precipitation),
      weatherCode: num(c.weather_code),
      cloudCoverPercent: num(c.cloud_cover),
      pressureHpa: num(c.pressure_msl),
      windSpeedMs: num(c.wind_speed_10m),
      windGustMs: num(c.wind_gusts_10m),
      windDirectionDeg: num(c.wind_direction_10m),
      isDay: c.is_day !== 0,
    },
    hourly: (h.time ?? []).flatMap((t, i) =>
      t === null
        ? []
        : [
            {
              time: iso(t)!,
              temperatureC: at(h, 'temperature_2m', i),
              precipitationMm: at(h, 'precipitation', i),
              precipitationProbability: at(h, 'precipitation_probability', i),
              weatherCode: at(h, 'weather_code', i),
              windSpeedMs: at(h, 'wind_speed_10m', i),
              windGustMs: at(h, 'wind_gusts_10m', i),
              windDirectionDeg: at(h, 'wind_direction_10m', i),
              isDay: at(h, 'is_day', i) !== 0,
            },
          ],
    ),
    daily: (d.time ?? []).flatMap((t, i) =>
      t === null
        ? []
        : [
            {
              date: iso(t)!,
              weatherCode: at(d, 'weather_code', i),
              tempMinC: at(d, 'temperature_2m_min', i),
              tempMaxC: at(d, 'temperature_2m_max', i),
              precipitationMm: at(d, 'precipitation_sum', i),
              precipitationProbability: at(d, 'precipitation_probability_max', i),
              windSpeedMaxMs: at(d, 'wind_speed_10m_max', i),
              windGustMaxMs: at(d, 'wind_gusts_10m_max', i),
              windDirectionDeg: at(d, 'wind_direction_10m_dominant', i),
              sunrise: iso(at(d, 'sunrise', i)),
              sunset: iso(at(d, 'sunset', i)),
            },
          ],
    ),
  };
}

const SEVERITIES: WarningSeverity[] = ['minor', 'moderate', 'severe', 'extreme'];

/** Antwort von Bright Sky (/alerts) → Warnungen, schwerste zuerst; Tests und Übungen des DWD fallen weg */
export function toWarnings(r: BrightSkyResponse, fetchedAt: Date): WeatherWarnings {
  const items = (r.alerts ?? [])
    .filter((a) => (a.status ?? 'actual') === 'actual')
    .map(
      (a): WeatherWarning => ({
        id: a.alert_id ?? String(a.id),
        event: a.event_de ?? a.event_en ?? '',
        headline: a.headline_de ?? a.headline_en ?? '',
        description: a.description_de ?? a.description_en ?? '',
        instruction: a.instruction_de ?? a.instruction_en ?? '',
        severity: SEVERITIES.includes(a.severity as WarningSeverity) ? (a.severity as WarningSeverity) : 'minor',
        effective: a.effective ?? fetchedAt.toISOString(),
        onset: a.onset ?? a.effective ?? fetchedAt.toISOString(),
        expires: a.expires ?? null,
      }),
    )
    .filter((w) => !w.expires || new Date(w.expires).getTime() > fetchedAt.getTime())
    .sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.onset.localeCompare(b.onset));
  return { area: r.location?.name ?? null, fetchedAt: fetchedAt.toISOString(), items };
}

interface Entry<T> {
  value: T | null;
  /** Zeitpunkt des letzten erfolgreichen Abrufs */
  okAt: number;
  /** Zeitpunkt des letzten Versuchs */
  triedAt: number;
  error: string | null;
  pending: Promise<void> | null;
}

/** Ruft Prognose und Warnungen ab und hält sie je Standort (auf ca. 1 km gerundet) kurz vor. */
export class WeatherService {
  private forecasts = new Map<string, Entry<WeatherForecast>>();
  private warnings = new Map<string, Entry<WeatherWarnings>>();

  constructor(
    private opts: WeatherOptions,
    private fetchJson: WeatherFetch = defaultFetch,
    private now: () => number = Date.now,
  ) {}

  async report(lat: number, lon: number): Promise<WeatherReport> {
    const la = Math.round(lat * 100) / 100;
    const lo = Math.round(lon * 100) / 100;
    const key = `${la},${lo}`;
    const base = (url: string) => url.replace(/\/+$/, '');
    const [forecast, warnings] = await Promise.all([
      this.opts.forecastUrl
        ? this.cached(this.forecasts, key, FORECAST_MS, async () =>
            toForecast(
              (await this.fetchJson(
                `${base(this.opts.forecastUrl!)}/v1/forecast?latitude=${la}&longitude=${lo}&current=${CURRENT}&hourly=${HOURLY}&daily=${DAILY}` +
                  '&forecast_hours=24&forecast_days=7&wind_speed_unit=ms&timeformat=unixtime&timezone=auto',
                { timeoutMs: TIMEOUT_MS, userAgent: this.opts.userAgent },
              )) as OpenMeteoResponse,
              new Date(this.now()),
            ),
          )
        : { value: null, error: 'Wetterprognose ist abgeschaltet' },
      this.opts.warningsUrl
        ? this.cached(this.warnings, key, WARNINGS_MS, async () =>
            toWarnings(
              (await this.fetchJson(`${base(this.opts.warningsUrl!)}/alerts?lat=${la}&lon=${lo}`, {
                timeoutMs: TIMEOUT_MS,
                userAgent: this.opts.userAgent,
              })) as BrightSkyResponse,
              new Date(this.now()),
            ),
          )
        : { value: null, error: 'Wetterwarnungen sind abgeschaltet' },
    ]);
    return { forecast: forecast.value, forecastError: forecast.error, warnings: warnings.value, warningsError: warnings.error };
  }

  private async cached<T>(cache: Map<string, Entry<T>>, key: string, maxAge: number, load: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
    let e = cache.get(key);
    if (!e) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      e = { value: null, okAt: 0, triedAt: 0, error: null, pending: null };
      cache.set(key, e);
    }
    const entry = e;
    const now = this.now();
    const fresh = entry.value !== null && now - entry.okAt < maxAge;
    if (!fresh && !entry.pending && now - entry.triedAt >= (entry.error ? RETRY_MS : 0)) {
      entry.triedAt = now;
      entry.pending = load()
        .then((v) => {
          entry.value = v;
          entry.okAt = this.now();
          entry.error = null;
        })
        .catch((err: unknown) => {
          entry.error = `Dienst nicht erreichbar (${err instanceof Error ? err.message : String(err)})`;
        })
        .finally(() => {
          entry.pending = null;
        });
    }
    if (entry.pending) await entry.pending;
    const usable = entry.value !== null && this.now() - entry.okAt < STALE_MS;
    return { value: usable ? entry.value : null, error: entry.error };
  }
}

/** DWD-Warnungen gelten nur in Deutschland – Zeiten daher immer in deutscher Ortszeit, unabhängig vom Server */
const warnTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Unwetterwarnungen (ab Stufe 3) als Meldungen; abgelaufene fallen weg */
export function warningAlerts(warnings: WeatherWarnings | null, now: Date): AlertDraft[] {
  if (!warnings) return [];
  return warnings.items
    .filter((w) => WARNING_LEVEL[w.severity].level >= 3 && (!w.expires || new Date(w.expires).getTime() > now.getTime()))
    .map((w) => {
      const started = new Date(w.onset).getTime() <= now.getTime();
      const period = [!started && `ab ${warnTime.format(new Date(w.onset))}`, w.expires && `bis ${warnTime.format(new Date(w.expires))}`].filter(Boolean).join(' ');
      return {
        id: `dwd:${w.id}`,
        severity: w.severity === 'extreme' ? 'alarm' : 'warn',
        system: 'weather',
        title: `${WARNING_LEVEL[w.severity].label}: ${w.event.charAt(0)}${w.event.slice(1).toLowerCase()}`,
        detail: [period, warnings.area].filter(Boolean).join(' · ') || undefined,
      };
    });
}

const WATCH_MS = 60_000;

/**
 * Prüft regelmäßig die amtlichen Warnungen am Fahrzeugstandort und meldet Unwetter. Der Dienst hält die Antworten
 * selbst vor; jede Minute wird nur neu bewertet (Standortwechsel, abgelaufene Warnungen).
 */
export class WeatherAlertWatch {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** Alle Warnungen am Fahrzeugstandort (für Bildschirme), null = kein Standort oder nicht abrufbar */
  private latest: WeatherWarnings | null = null;

  constructor(
    private weather: WeatherService,
    private position: () => { lat: number; lon: number } | null,
    private publish: (alerts: AlertDraft[]) => void,
    private now: () => Date = () => new Date(),
  ) {}

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), WATCH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Prognose und Warnungen am Fahrzeugstandort; null = kein Standort bekannt */
  async vehicleReport(): Promise<WeatherReport | null> {
    const pos = this.position();
    return pos ? this.weather.report(pos.lat, pos.lon) : null;
  }

  /** Noch gültige Warnungen am Fahrzeugstandort */
  warnings(): WeatherWarnings | null {
    if (!this.latest) return null;
    const now = this.now().getTime();
    return { ...this.latest, items: this.latest.items.filter((w) => !w.expires || new Date(w.expires).getTime() > now) };
  }

  /** Einmal prüfen; ohne Standort oder bei Ausfall des Dienstes bleiben keine alten Warnungen stehen */
  check(): Promise<void> {
    this.running ??= (async () => {
      const pos = this.position();
      const report = pos ? await this.weather.report(pos.lat, pos.lon) : null;
      this.latest = report?.warnings ?? null;
      this.publish(warningAlerts(this.latest, this.now()));
    })()
      .catch(() => {
        this.latest = null;
        this.publish([]);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
