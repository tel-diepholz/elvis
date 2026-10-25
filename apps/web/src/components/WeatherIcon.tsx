import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Navigation2, Snowflake, Sun } from 'lucide-react';
import { weatherCodeText } from '@elvis/shared';
import { compass } from '../lib/format';
import type { Tone } from './ui';

/** WMO-Wettercode → Symbol */
export function WeatherIcon({ code, isDay = true, size = 24 }: { code: number | null; isDay?: boolean; size?: number }) {
  const Icon =
    code === null
      ? Cloud
      : code === 0 || code === 1
        ? isDay
          ? Sun
          : Moon
        : code === 2
          ? isDay
            ? CloudSun
            : CloudMoon
          : code === 3
            ? Cloud
            : code === 45 || code === 48
              ? CloudFog
              : code >= 51 && code <= 57
                ? CloudDrizzle
                : (code >= 61 && code <= 67) || (code >= 80 && code <= 82)
                  ? CloudRain
                  : code === 77
                    ? Snowflake
                    : (code >= 71 && code <= 75) || code === 85 || code === 86
                      ? CloudSnow
                      : code >= 95
                        ? CloudLightning
                        : Cloud;
  return <Icon size={size} aria-label={weatherCodeText(code)} />;
}

/** Pfeil in Zugrichtung des Winds (Wind aus Süd → Pfeil nach Nord) */
export function WindArrow({ deg, size = 14 }: { deg: number | null; size?: number }) {
  if (deg === null) return null;
  return <Navigation2 size={size} className="wx-arrow" style={{ transform: `rotate(${(deg + 180) % 360}deg)` }} aria-label={`Wind aus ${compass(deg)}`} />;
}

/** Böen ab 70 % der Sturmwarnschwelle gelb, ab der Schwelle rot */
export const gustTone = (gust: number | null, limit: number): Tone | undefined => (gust === null ? undefined : gust >= limit ? 'alarm' : gust >= limit * 0.7 ? 'warn' : undefined);
