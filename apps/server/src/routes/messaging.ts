import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { regionArsSchema } from '@elvis/shared';
import type { MessagingService } from '../services/messaging/index.js';
import { operatorOf, parse } from './util.js';

const regionsQuery = z.object({ parent: regionArsSchema.optional(), q: z.string().trim().max(100).optional(), ars: regionArsSchema.optional() });
const directoryQuery = z.object({ q: z.string().trim().max(100).default(''), region: regionArsSchema.default('') });
const conversationParams = z.object({ id: z.string().uuid(), action: z.enum(['accept', 'decline', 'close']) });

/**
 * Cloud Messaging: Registrieren im Verzeichnis (Admins, /api/system/…), suchen, anfragen, annehmen (alle Angemeldeten).
 * Die Nachrichten selbst laufen über die Nachrichten (Kanal „Fahrzeug-Chat“, routes/chat.ts).
 */
export function messagingRoutes(app: FastifyInstance, messaging: MessagingService): void {
  app.put('/api/system/messaging', async (req) => messaging.register(req.body, operatorOf(req)));
  app.delete('/api/system/messaging', async (req) => messaging.unregister(operatorOf(req)));

  app.get('/api/messaging/status', async () => messaging.status());
  app.get('/api/messaging/regions', async (req) => messaging.regions(parse(regionsQuery, req.query)));
  app.get('/api/messaging/directory', async (req) => {
    const { q, region } = parse(directoryQuery, req.query);
    return messaging.directory(q, region);
  });
  app.get('/api/messaging/conversations', async () => messaging.conversations());
  app.post('/api/messaging/conversations', async (req, reply) => reply.code(201).send(await messaging.request(req.body, operatorOf(req))));
  app.post('/api/messaging/conversations/:id/:action', async (req) => {
    const { id, action } = parse(conversationParams, req.params);
    return messaging.decide(id, action, operatorOf(req));
  });
}
