import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_SHEET_PERSONS, personInputSchema, personnelFormInputSchema, sheetAssignSchema } from '@elvis/shared';
import type { PersonnelService } from '../services/personnel.js';
import { idParam, operatorOf, parse } from './util.js';

const transferSchema = z.object({ personIds: z.array(z.number().int().positive()).min(1, 'Keine Person ausgewählt').max(500), unitId: z.number().int().positive() });
const personsSchema = z.object({ persons: z.array(personInputSchema).min(1, 'Mindestens eine Person').max(MAX_SHEET_PERSONS) });

/** Personal der Einheiten, Personalbögen im Eingang und Online-Formular (alle Angemeldeten) */
export function personnelRoutes(app: FastifyInstance, personnel: PersonnelService): void {
  app.get('/api/incidents/:id/personnel', async (req) => personnel.listIncident(parse(idParam, req.params).id));
  app.get('/api/units/:id/personnel', async (req) => personnel.list(parse(idParam, req.params).id));

  app.post('/api/units/:id/personnel', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(personnel.add(id, parse(personsSchema, req.body).persons, operatorOf(req)));
  });

  app.post('/api/units/:id/personnel/transfer', async (req) => {
    const { personIds, unitId } = parse(transferSchema, req.body);
    return personnel.transfer(parse(idParam, req.params).id, personIds, unitId, operatorOf(req));
  });

  app.put('/api/personnel/:id', async (req) => personnel.update(parse(idParam, req.params).id, parse(personInputSchema, req.body)));

  app.delete('/api/personnel/:id', async (req, reply) => {
    personnel.remove(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });

  app.get('/api/personnel-sheets', async () => personnel.inbox());
  app.get('/api/personnel-sheets/unread', async () => ({ count: personnel.unread() }));

  app.post('/api/personnel-sheets/read', async (_req, reply) => {
    personnel.markRead();
    return reply.code(204).send();
  });

  app.post('/api/personnel-sheets/:id/assign', async (req) =>
    personnel.assign(parse(idParam, req.params).id, parse(sheetAssignSchema, req.body), operatorOf(req)),
  );

  app.delete('/api/personnel-sheets/:id', async (req, reply) => {
    personnel.removeSheet(parse(idParam, req.params).id);
    return reply.code(204).send();
  });

  app.post('/api/personnel-form', async (req, reply) =>
    reply.code(201).send(await personnel.createForm(parse(personnelFormInputSchema, req.body ?? {}).validHours, operatorOf(req))),
  );

  app.delete('/api/personnel-form', async (req, reply) => {
    await personnel.closeForm(operatorOf(req));
    return reply.code(204).send();
  });
}
