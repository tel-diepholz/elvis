import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contactCategoryInputSchema, contactInputSchema } from '@elvis/shared';
import type { ContactService } from '../services/contacts.js';
import type { PersonnelService } from '../services/personnel.js';
import { idParam, operatorOf, parse } from './util.js';

const suggestQuery = z.object({ q: z.string().max(100).default('') });

/** Kontakte und Kategorien: lesen und pflegen alle Angemeldeten */
export function contactRoutes(app: FastifyInstance, deps: { contacts: ContactService; personnel: PersonnelService }): void {
  const { contacts, personnel } = deps;

  app.get('/api/contacts', async () => contacts.list());
  app.post('/api/contacts', async (req, reply) => reply.code(201).send(contacts.create(parse(contactInputSchema, req.body), operatorOf(req))));
  app.put('/api/contacts/:id', async (req) => contacts.update(parse(idParam, req.params).id, parse(contactInputSchema, req.body), operatorOf(req)));
  app.delete('/api/contacts/:id', async (req, reply) => {
    contacts.remove(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });

  app.get('/api/contact-categories', async () => contacts.categories());
  app.post('/api/contact-categories', async (req, reply) => reply.code(201).send(contacts.createCategory(parse(contactCategoryInputSchema, req.body), operatorOf(req))));
  app.put('/api/contact-categories/:id', async (req) => contacts.updateCategory(parse(idParam, req.params).id, parse(contactCategoryInputSchema, req.body), operatorOf(req)));
  app.delete('/api/contact-categories/:id', async (req, reply) => {
    contacts.removeCategory(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });

  // Personal einer Einheit übernehmen (auch aus abgeschlossenen Einsätzen – Kontakte sind global)
  app.post('/api/personnel/:id/contact', async (req, reply) => reply.code(201).send(contacts.fromPerson(personnel.person(parse(idParam, req.params).id), operatorOf(req))));

  // Vorschläge für die Adresszeilen einer Mail
  app.get('/api/mail/suggest', async (req) => contacts.mailSuggestions(parse(suggestQuery, req.query).q));
}
