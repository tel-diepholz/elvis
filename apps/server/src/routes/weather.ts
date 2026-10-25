import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WeatherAlertWatch, WeatherService } from '../services/weather.js';
import { parse } from './util.js';

const position = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

export function weatherRoutes(app: FastifyInstance, weather: WeatherService, watch: WeatherAlertWatch): void {
  /** Prognose und amtliche Warnungen für einen Standort */
  app.get('/api/weather', async (req) => {
    const { lat, lon } = parse(position, req.query);
    return weather.report(lat, lon);
  });

  /** Warnungen am Fahrzeugstandort, wie sie der Server für die Meldungen auswertet (Bildschirme ohne Anmeldung) */
  app.get('/api/weather/warnings', async () => watch.warnings());

  /** Prognose am Fahrzeugstandort (Kachel „Wettervorhersage“ der Bildschirme) */
  app.get('/api/weather/vehicle', async () => watch.vehicleReport());
}
