/** Wetterprognose und amtliche Warnungen für einen Standort (Open-Meteo bzw. DWD über Bright Sky). */

export interface WeatherNow {
  time: string;
  temperatureC: number | null;
  feelsLikeC: number | null;
  humidityPercent: number | null;
  precipitationMm: number | null;
  /** WMO-Wettercode (https://open-meteo.com/en/docs → „Weather variable documentation“) */
  weatherCode: number | null;
  cloudCoverPercent: number | null;
  pressureHpa: number | null;
  windSpeedMs: number | null;
  windGustMs: number | null;
  windDirectionDeg: number | null;
  isDay: boolean;
}

export interface WeatherHour {
  time: string;
  temperatureC: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null;
  weatherCode: number | null;
  windSpeedMs: number | null;
  windGustMs: number | null;
  windDirectionDeg: number | null;
  isDay: boolean;
}

export interface WeatherDay {
  /** Ortszeit-Mitternacht des Tages */
  date: string;
  weatherCode: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null;
  windSpeedMaxMs: number | null;
  windGustMaxMs: number | null;
  windDirectionDeg: number | null;
  sunrise: string | null;
  sunset: string | null;
}

export interface WeatherForecast {
  /** Gitterpunkt des Modells */
  lat: number;
  lon: number;
  elevationM: number | null;
  fetchedAt: string;
  current: WeatherNow;
  /** Die nächsten 24 Stunden */
  hourly: WeatherHour[];
  /** Heute und die folgenden Tage */
  daily: WeatherDay[];
}

/** Warnstufen des DWD: 1 Wetterwarnung, 2 markante Warnung, 3 Unwetterwarnung, 4 extremes Unwetter */
export type WarningSeverity = 'minor' | 'moderate' | 'severe' | 'extreme';

export interface WeatherWarning {
  id: string;
  event: string;
  headline: string;
  description: string;
  instruction: string;
  severity: WarningSeverity;
  effective: string;
  onset: string;
  expires: string | null;
}

export interface WeatherWarnings {
  /** Warngebiet (Gemeinde), null außerhalb Deutschlands */
  area: string | null;
  fetchedAt: string;
  items: WeatherWarning[];
}

export interface WeatherReport {
  forecast: WeatherForecast | null;
  /** Grund, warum die Prognose fehlt oder veraltet ist */
  forecastError: string | null;
  warnings: WeatherWarnings | null;
  warningsError: string | null;
}

export const WARNING_LEVEL: Record<WarningSeverity, { level: number; label: string }> = {
  minor: { level: 1, label: 'Wetterwarnung' },
  moderate: { level: 2, label: 'Markante Wetterwarnung' },
  severe: { level: 3, label: 'Unwetterwarnung' },
  extreme: { level: 4, label: 'Extremes Unwetter' },
};

/** WMO-Wettercode → Kurzbeschreibung */
export function weatherCodeText(code: number | null): string {
  if (code === null) return '–';
  const texts: Record<number, string> = {
    0: 'Klar',
    1: 'Überwiegend klar',
    2: 'Teils bewölkt',
    3: 'Bedeckt',
    45: 'Nebel',
    48: 'Nebel mit Reif',
    51: 'Leichter Nieselregen',
    53: 'Nieselregen',
    55: 'Starker Nieselregen',
    56: 'Gefrierender Nieselregen',
    57: 'Starker gefrierender Nieselregen',
    61: 'Leichter Regen',
    63: 'Regen',
    65: 'Starker Regen',
    66: 'Gefrierender Regen',
    67: 'Starker gefrierender Regen',
    71: 'Leichter Schneefall',
    73: 'Schneefall',
    75: 'Starker Schneefall',
    77: 'Schneegriesel',
    80: 'Leichte Regenschauer',
    81: 'Regenschauer',
    82: 'Heftige Regenschauer',
    85: 'Schneeschauer',
    86: 'Starke Schneeschauer',
    95: 'Gewitter',
    96: 'Gewitter mit Hagel',
    99: 'Schweres Gewitter mit Hagel',
  };
  return texts[code] ?? `Code ${code}`;
}
