import type { WeatherState } from '@elvis/shared';
import { SimAdapter, clamp, drift, jitter, round } from './sim-adapter.js';

const HOME = { lat: 51.1657, lon: 10.4515 };

/** Wetterstation mit GPS (wie Airmar 150WX) – relevant für Ausbreitung (Rauch, Gefahrstoffe) und Fahrzeugstandort. */
export class WeatherSim extends SimAdapter<'weather'> {
  protected readonly commands = {};

  constructor() {
    super(
      'weather',
      {
        position: { ...HOME, headingDeg: 90, fix: true },
        windSpeedMs: 4.2,
        windGustMs: 6.1,
        windDirectionDeg: 245,
        temperatureC: 12,
        humidityPercent: 71,
        pressureHpa: 1013,
        precipitationMmH: 0,
        gnss: { method: 'gnss', satellites: 9, hdop: 0.9, altitudeM: 230, speedMs: 0, courseDeg: null, pitchDeg: 0.5, rollDeg: -1.2, time: null, clockOffsetS: 0 },
      } satisfies WeatherState,
      { tickMs: 2000 },
    );
  }

  protected tick(): void {
    this.update((s) => {
      // Simulator liefert immer alle Werte (null nur bei echten Sensoren ohne Messwert)
      const v = (x: number | null, d: number) => x ?? d;
      // Fahrzeug steht: nur GPS-Rauschen (~1 m)
      if (s.position) {
        s.position.lat = round(drift(s.position.lat, HOME.lat, 0.000005, 0.1), 6);
        s.position.lon = round(drift(s.position.lon, HOME.lon, 0.000005, 0.1), 6);
      }
      if (s.gnss) {
        s.gnss.satellites = Math.round(clamp(drift(v(s.gnss.satellites, 9), 9, 0.4, 0.1), 4, 14));
        s.gnss.hdop = round(clamp(drift(v(s.gnss.hdop, 0.9), 0.9, 0.05, 0.1), 0.6, 3));
        s.gnss.time = new Date().toISOString();
      }
      s.windSpeedMs = round(clamp(drift(v(s.windSpeedMs, 5), 5, 0.6, 0.03), 0, 35));
      s.windGustMs = round(Math.max(s.windSpeedMs, s.windSpeedMs * (1.2 + Math.random() * 0.6)));
      s.windDirectionDeg = Math.round((v(s.windDirectionDeg, 245) + jitter(6) + 360) % 360);
      s.temperatureC = round(drift(v(s.temperatureC, 12), 12, 0.05, 0.01));
      s.humidityPercent = Math.round(clamp(drift(v(s.humidityPercent, 70), 70, 0.5, 0.02), 10, 100));
      s.pressureHpa = round(drift(v(s.pressureHpa, 1013), 1013, 0.05, 0.01));
      s.precipitationMmH = round(Math.max(0, drift(v(s.precipitationMmH, 0), 0, 0.05, 0.1)));
    });
  }
}
