import type { FastifyInstance, FastifyRequest } from 'fastify';
import { messageClaimSchema, messageInputSchema, messageReplySchema, messageRouteSchema, messageSettingsSchema, messageSnoozeSchema, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { MessageService } from '../services/messages.js';
import type { TaskViewer } from '../services/tasks.js';
import { actorOf, idParam, operatorOf, parse } from './util.js';

const viewerOf = (req: FastifyRequest): TaskViewer => ({ userId: actorOf(req).id, roleIds: req.roleIds });

export function messageRoutes(app: FastifyInstance, deps: { messages: MessageService; store: Store; notify: (t: Topic[]) => void }): void {
  const { messages } = deps;
  const id = (req: FastifyRequest) => parse(idParam, req.params).id;

  // --- Einstellungen: Fernmelder- und Dispatcher-Rollen (nur Admins) ---

  app.get('/api/system/messages', async () => messages.settings());

  app.put('/api/system/messages', async (req) => {
    const s = messages.setSettings(parse(messageSettingsSchema, req.body), operatorOf(req));
    deps.store.addAudit({ operator: operatorOf(req), target: 'meldungen', action: 'settings', params: '', success: true, message: 'Rollen für Meldungen geändert' });
    deps.notify(['audit']);
    return s;
  });

  // --- Meldungen im Einsatz ---

  app.get('/api/messages/context', async (req) => messages.context(viewerOf(req)));

  app.get('/api/incidents/:id/messages', async (req) => messages.list(id(req), viewerOf(req)));

  app.post('/api/incidents/:id/messages', async (req, reply) => reply.code(201).send(messages.create(id(req), parse(messageInputSchema, req.body), actorOf(req), viewerOf(req))));

  app.post('/api/messages/:id/claim', async (req) => messages.claim(id(req), parse(messageClaimSchema, req.body ?? {}).force, actorOf(req), viewerOf(req)));

  app.post('/api/messages/:id/release', async (req) => messages.release(id(req), viewerOf(req)));

  app.post('/api/messages/:id/snooze', async (req) => messages.snooze(id(req), parse(messageSnoozeSchema, req.body ?? {}).minutes, actorOf(req), viewerOf(req)));

  app.post('/api/messages/:id/reply', async (req) => messages.reply(id(req), parse(messageReplySchema, req.body).body, actorOf(req), viewerOf(req)));

  app.post('/api/messages/:id/done', async (req) => messages.done(id(req), actorOf(req), viewerOf(req)));

  app.post('/api/messages/:id/route', async (req) => messages.route(id(req), parse(messageRouteSchema, req.body).roleId, viewerOf(req)));

  app.post('/api/messages/:id/ack', async (req) => messages.ack(id(req), actorOf(req), viewerOf(req)));
}
