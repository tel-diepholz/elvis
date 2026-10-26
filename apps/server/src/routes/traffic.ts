import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_TRAFFIC_RADIUS_NM, trafficSettingsInputSchema, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { TrafficService } from '../services/traffic.js';
import { operatorOf, parse } from './util.js';

const lat = z.coerce.number().min(-90).max(90);
const lon = z.coerce.number().min(-180).max(180);
const near = z.object({ lat, lon, radius: z.coerce.number().min(1).max(MAX_TRAFFIC_RADIUS_NM) });
const box = z.object({ south: lat, west: lon, north: lat, east: lon });

export function trafficRoutes(app: FastifyInstance, deps: { traffic: TrafficService; store: Store; notify: (topics: Topic[]) => void }): void {
  const { traffic } = deps;

  /** Flugzeuge im Umkreis (Radius in NM) */
  app.get('/api/traffic/aircraft', async (req) => {
    const q = parse(near, req.query);
    return traffic.aircraftNear(q.lat, q.lon, q.radius);
  });

  /** Schiffe im Kartenausschnitt (nur innerhalb des AIS-Abos um Einsatzort bzw. Fahrzeug) */
  app.get('/api/traffic/ships', async (req) => traffic.shipsIn(parse(box, req.query)));

  /** Einzelnes Flugzeug oder Schiff suchen: Rufzeichen, Kennzeichen, ICAO-Adresse, Schiffsname, MMSI */
  app.get('/api/traffic/search', async (req) => traffic.search(parse(z.object({ q: z.string().max(40) }), req.query).q));

  // --- Einstellungen (nur Admins über /api/system/) ---

  app.get('/api/system/traffic', async () => traffic.settings());

  app.put('/api/system/traffic', async (req) => {
    const input = parse(trafficSettingsInputSchema, req.body);
    const next = traffic.setSettings(input, operatorOf(req));
    deps.store.addAudit({
      operator: operatorOf(req),
      target: 'verkehr',
      action: 'einstellungen',
      params: '',
      success: true,
      message: [
        `Flugzeuge ${next.aircraft ? 'an' : 'aus'}`,
        `Schiffe ${next.ships ? 'an' : 'aus'}`,
        input.aisKey === null ? 'AIS-Schlüssel entfernt' : input.aisKey ? 'AIS-Schlüssel geändert' : '',
      ]
        .filter(Boolean)
        .join(', '),
    });
    deps.notify(['audit']);
    return next;
  });
}
