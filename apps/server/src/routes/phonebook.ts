import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { PhonebookService } from '../services/phonebook.js';
import { operatorOf, parse } from './util.js';

const tokenParam = z.object({ token: z.string().max(100) });
const categoryParam = tokenParam.extend({ id: z.coerce.number().int().positive() });

/**
 * Telefonbuch für DECT-Basen: Abruf ohne Anmeldung über das Token in der URL (/api/phonebook/…, siehe auth/access.ts),
 * Token anzeigen und neu erzeugen nur Admins (/api/system/phonebook).
 */
export function phonebookRoutes(app: FastifyInstance, deps: { phonebook: PhonebookService; store: Store; notify: (t: Topic[]) => void }): void {
  const { phonebook } = deps;
  const xml = (body: string) => ({ body, type: 'application/xml; charset=utf-8' });

  app.get('/api/phonebook/:token/yealink.xml', async (req, reply) => {
    const r = xml(phonebook.yealinkXml(parse(tokenParam, req.params).token));
    return reply.type(r.type).header('cache-control', 'no-store').send(r.body);
  });
  app.get('/api/phonebook/:token/kategorie/:id/yealink.xml', async (req, reply) => {
    const p = parse(categoryParam, req.params);
    const r = xml(phonebook.yealinkXml(p.token, p.id));
    return reply.type(r.type).header('cache-control', 'no-store').send(r.body);
  });

  app.get('/api/system/phonebook', async () => phonebook.status());
  app.post('/api/system/phonebook/token', async (req) => {
    const s = phonebook.regenerate(operatorOf(req));
    deps.store.addAudit({ operator: operatorOf(req), target: 'telefonbuch', action: 'token', params: '', success: true, message: 'Telefonbuch-URL neu erzeugt' });
    deps.notify(['audit']);
    return s;
  });
}
