import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatDtg, type DeviceSnapshot, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { SettingsService } from '../services/settings.js';
import type { WeatherAlertWatch, WeatherService } from '../services/weather.js';
import { renderWeatherPdf } from '../services/weather-print.js';
import { operatorOf, parse } from './util.js';

const position = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

export interface WeatherPrintDeps {
  settings: SettingsService;
  store: Store;
  notify: (topics: Topic[]) => void;
  /** Wetterstation, null wenn das Modul nicht aktiviert ist */
  station: () => DeviceSnapshot<'weather'> | null;
  stormLimitMs: number;
}

export function weatherRoutes(app: FastifyInstance, weather: WeatherService, watch: WeatherAlertWatch, print: WeatherPrintDeps): void {
  /** Prognose und amtliche Warnungen für einen Standort */
  app.get('/api/weather', async (req) => {
    const { lat, lon } = parse(position, req.query);
    return weather.report(lat, lon);
  });

  /** Warnungen am Fahrzeugstandort, wie sie der Server für die Meldungen auswertet (Bildschirme ohne Anmeldung) */
  app.get('/api/weather/warnings', async () => watch.warnings());

  /** Prognose am Fahrzeugstandort (Kachel „Wettervorhersage“ der Bildschirme) */
  app.get('/api/weather/vehicle', async () => watch.vehicleReport());

  /** Wetterbericht als PDF (A4): Warnungen, Messwerte der Wetterstation ohne GPS-Angaben, Prognose */
  app.post('/api/print/weather', async (req, reply) => {
    const { lat, lon } = parse(position, req.body);
    const report = await weather.report(lat, lon);
    const operator = operatorOf(req);
    const station = print.station();
    const pdf = await renderWeatherPdf(report, {
      vehicle: print.settings.get().vehicle,
      operator,
      place: report.warnings?.area ?? `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
      station: station && { state: station.state, online: station.online, updatedAt: station.updatedAt },
      stormLimitMs: print.stormLimitMs,
    });
    print.store.addAudit({ operator, target: 'wetter', action: 'print', params: JSON.stringify({ lat, lon }), success: true, message: '' });
    print.notify(['audit']);
    const name = `Wetterbericht_${formatDtg(new Date())}.pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(pdf);
  });
}
