import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requestAttachSchema, requestFollowUpSchema, requestForwardSchema, requestInputSchema, requestNoteSchema, requestPatchSchema, requestSettingsSchema, requestStatusSchema, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { RequestService } from '../services/requests.js';
import type { TaskViewer } from '../services/tasks.js';
import { actorOf, idParam, operatorOf, parse } from './util.js';

const viewerOf = (req: FastifyRequest): TaskViewer => ({ userId: actorOf(req).id, roleIds: req.roleIds });

export function requestRoutes(app: FastifyInstance, deps: { requests: RequestService; store: Store; notify: (t: Topic[]) => void }): void {
  const { requests } = deps;
  const id = (req: FastifyRequest) => parse(idParam, req.params).id;

  // --- Einstellungen: Beschaffungsrolle (nur Admins) ---

  app.get('/api/system/requests', async () => requests.settings());

  app.put('/api/system/requests', async (req) => {
    const s = requests.setSettings(parse(requestSettingsSchema, req.body), operatorOf(req));
    deps.store.addAudit({ operator: operatorOf(req), target: 'anforderungen', action: 'settings', params: '', success: true, message: 'Beschaffungsrolle geändert' });
    deps.notify(['audit']);
    return s;
  });

  // --- Anforderungen im Einsatz ---

  app.get('/api/requests/settings', async () => requests.settings());

  app.get('/api/incidents/:id/requests', async (req) => requests.list(id(req), viewerOf(req)));

  app.post('/api/incidents/:id/requests', async (req, reply) => reply.code(201).send(requests.create(id(req), parse(requestInputSchema, req.body), actorOf(req), viewerOf(req))));

  app.get('/api/requests/:id', async (req) => requests.get(id(req), viewerOf(req)));

  app.put('/api/requests/:id', async (req) => requests.update(id(req), parse(requestPatchSchema, req.body), actorOf(req), viewerOf(req)));

  app.get('/api/requests/:id/journal', async (req) => requests.journal(id(req)));

  app.post('/api/requests/:id/status', async (req) => requests.setStatus(id(req), parse(requestStatusSchema, req.body), actorOf(req), viewerOf(req)));

  app.post('/api/requests/:id/follow-up', async (req) => requests.setFollowUp(id(req), parse(requestFollowUpSchema, req.body), actorOf(req), viewerOf(req)));

  app.post('/api/requests/:id/forward', async (req) => requests.forward(id(req), parse(requestForwardSchema, req.body), actorOf(req), viewerOf(req)));

  app.post('/api/requests/:id/messages', async (req) => requests.attachMessage(id(req), parse(requestAttachSchema, req.body).messageId, actorOf(req), viewerOf(req)));

  app.post('/api/requests/:id/notes', async (req, reply) => reply.code(201).send(requests.addNote(id(req), parse(requestNoteSchema, req.body), actorOf(req))));
}
