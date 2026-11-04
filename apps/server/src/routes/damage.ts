import type { FastifyInstance, FastifyRequest } from 'fastify';
import { damageAccountInputSchema, damageAccountPatchSchema, damageCountInputSchema, damageEntryInputSchema, damageEntryPatchSchema } from '@elvis/shared';
import type { DamageService } from '../services/damage.js';
import { idParam, operatorOf, parse } from './util.js';

export function damageRoutes(app: FastifyInstance, deps: { damage: DamageService }): void {
  const { damage } = deps;
  const id = (req: FastifyRequest) => parse(idParam, req.params).id;

  app.get('/api/incidents/:id/damage-accounts', async (req) => damage.list(id(req)));

  app.post('/api/incidents/:id/damage-accounts', async (req, reply) => reply.code(201).send(damage.create(id(req), parse(damageAccountInputSchema, req.body), operatorOf(req))));

  app.get('/api/damage-accounts/:id', async (req) => damage.get(id(req)));

  app.patch('/api/damage-accounts/:id', async (req) => damage.update(id(req), parse(damageAccountPatchSchema, req.body), operatorOf(req)));

  app.post('/api/damage-accounts/:id/close', async (req) => damage.close(id(req), operatorOf(req)));

  app.post('/api/damage-accounts/:id/entries', async (req, reply) => reply.code(201).send(damage.addEntry(id(req), parse(damageEntryInputSchema, req.body), operatorOf(req))));

  app.patch('/api/damage-entries/:id', async (req) => damage.updateEntry(id(req), parse(damageEntryPatchSchema, req.body), operatorOf(req)));

  app.get('/api/damage-accounts/:id/counts', async (req) => damage.counts(id(req)));

  app.post('/api/damage-accounts/:id/counts', async (req) => damage.book(id(req), parse(damageCountInputSchema, req.body), operatorOf(req)));
}
