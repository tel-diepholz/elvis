import type { FastifyInstance } from 'fastify';
import { manualPositionInputSchema, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { VehiclePositionService } from '../services/vehiclePosition.js';
import { operatorOf, parse } from './util.js';

/** Fahrzeugstandort: lesen wie der Fahrzeugzustand, von Hand setzen nach Anmeldung (nur ohne GPS-Fix) */
export function vehiclePositionRoutes(app: FastifyInstance, deps: { position: VehiclePositionService; store: Store; notify: (t: Topic[]) => void }): void {
  const { position, store, notify } = deps;
  app.get('/api/map/vehicle-position', async () => ({ manual: position.manual(), current: position.current() }));

  app.put('/api/map/vehicle-position', async (req) => {
    const m = position.set(parse(manualPositionInputSchema, req.body), operatorOf(req));
    store.addAudit({ operator: operatorOf(req), target: 'fahrzeug', action: 'position', params: `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}`, success: true, message: 'Fahrzeugposition von Hand gesetzt' });
    notify(['audit']);
    return m;
  });

  app.delete('/api/map/vehicle-position', async (req, reply) => {
    if (position.clear()) {
      store.addAudit({ operator: operatorOf(req), target: 'fahrzeug', action: 'position', params: '', success: true, message: 'Von Hand gesetzte Fahrzeugposition entfernt' });
      notify(['audit']);
    }
    return reply.code(204).send();
  });
}
