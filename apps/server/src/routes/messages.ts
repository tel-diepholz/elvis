import type { FastifyInstance, FastifyRequest } from 'fastify';
import { messageClaimSchema, messageInputSchema, messageReplySchema, messageRouteSchema, messageSettingsSchema, messageSnoozeSchema, unitPatchSchema, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { ForceService } from '../services/forces.js';
import type { IncidentService } from '../services/incidents.js';
import type { MailService } from '../services/mail.js';
import type { MessageService } from '../services/messages.js';
import type { TaskViewer } from '../services/tasks.js';
import { actorOf, idParam, operatorOf, parse } from './util.js';

const viewerOf = (req: FastifyRequest): TaskViewer => ({ userId: actorOf(req).id, roleIds: req.roleIds });

export function messageRoutes(app: FastifyInstance, deps: { messages: MessageService; store: Store; incidents: IncidentService; forces: ForceService; mail: MailService; notify: (t: Topic[]) => void }): void {
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

  app.post('/api/incidents/:id/messages', async (req, reply) => {
    const input = parse(messageInputSchema, req.body);
    // Aus einer E-Mail erfasst: Kraft bzw. Systemeinheit (z. B. Leitstelle) merkt sich die Absenderadresse – für Ausgangsmeldungen per Mail
    const mailFrom = input.direction === 'in' && input.mailId !== null ? deps.mail.message(input.mailId).fromAddress : null;
    const created = messages.create(id(req), input, actorOf(req), viewerOf(req));
    const unit = created.senderUnitId !== null ? deps.store.unit(created.senderUnitId) : null;
    if (mailFrom && unit && unit.email !== mailFrom) deps.incidents.patchUnit(unit.id, parse(unitPatchSchema, { email: mailFrom }), operatorOf(req));
    if (mailFrom && created.senderForceUnitId !== null) {
      deps.forces.setEmail(created.senderForceUnitId, mailFrom);
      deps.notify(['forces']);
    }
    return reply.code(201).send(created);
  });

  app.post('/api/messages/:id/claim', async (req) => messages.claim(id(req), parse(messageClaimSchema, req.body ?? {}).force, actorOf(req), viewerOf(req)));

  app.post('/api/messages/:id/release', async (req) => messages.release(id(req), viewerOf(req)));

  app.post('/api/messages/:id/snooze', async (req) => messages.snooze(id(req), parse(messageSnoozeSchema, req.body ?? {}).minutes, actorOf(req), viewerOf(req)));

  app.post('/api/messages/:id/reply', async (req) => messages.reply(id(req), parse(messageReplySchema, req.body).body, actorOf(req), viewerOf(req)));

  app.post('/api/messages/:id/done', async (req) => messages.done(id(req), actorOf(req), viewerOf(req)));

  app.post('/api/messages/:id/route', async (req) => messages.route(id(req), parse(messageRouteSchema, req.body).roleId, viewerOf(req)));

  app.post('/api/messages/:id/ack', async (req) => messages.ack(id(req), actorOf(req), viewerOf(req)));
}
