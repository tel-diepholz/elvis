import type { FastifyInstance } from 'fastify';
import { pairInputSchema } from '@elvis/shared';
import type { AppLinkService } from '../services/applinks.js';
import { idParam, operatorOf, parse } from './util.js';

/** App-Anbindung: Apps mit Einheiten koppeln (alle Angemeldeten), Zustand des Relays (Admins) */
export function appLinkRoutes(app: FastifyInstance, appLinks: AppLinkService): void {
  app.get('/api/app-relay', async () => {
    const { enabled } = appLinks.status();
    return { enabled };
  });

  app.get('/api/system/app-relay', async () => appLinks.status());

  app.get('/api/incidents/:id/app-links', async (req) => appLinks.list(parse(idParam, req.params).id));

  app.post('/api/units/:id/app-link', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(await appLinks.pair(id, parse(pairInputSchema, req.body), operatorOf(req)));
  });

  app.delete('/api/units/:id/app-link', async (req, reply) => {
    await appLinks.unpair(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });
}
