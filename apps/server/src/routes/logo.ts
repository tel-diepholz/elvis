import type { FastifyInstance } from 'fastify';
import type { LogoLinkInput, LogoRuleInput, Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { LogoService } from '../services/logo.js';
import { operatorOf } from './util.js';

interface Deps {
  logo: LogoService;
  store: Store;
  notify: (topics: Topic[]) => void;
}

/**
 * Bezeichnungen, Regeln und Verknüpfungen der LOGO – angemeldete Nutzer (Standardregel in auth/access.ts). Die Werte
 * kommen live über das Modul „logo“; der Taster-Impuls läuft als Befehl „pulse“ über /api/devices/logo/….
 */
export function logoRoutes(app: FastifyInstance, d: Deps): void {
  const audit = (req: Parameters<typeof operatorOf>[0], target: string, action: string, message: string) => {
    d.store.addAudit({ operator: operatorOf(req), target, action, params: '{}', success: true, message });
    d.notify(['audit']);
  };

  app.get('/api/logo', async () => d.logo.get());

  app.put<{ Params: { signal: string } }>('/api/logo/labels/:signal', async (req) => {
    const label = d.logo.setLabel(req.params.signal, req.body);
    audit(req, `logo:${req.params.signal}`, 'label', label ? `LOGO ${req.params.signal} bezeichnet als „${label}“` : `LOGO: Bezeichnung von ${req.params.signal} entfernt`);
    return { label };
  });

  app.post('/api/logo/rules', async (req, reply) => {
    const r = d.logo.createRule(req.body as LogoRuleInput);
    audit(req, `logo:rule:${r.id}`, 'create', `LOGO-Regel „${r.title}“ angelegt (${r.signal} ${r.op} ${r.value})`);
    return reply.code(201).send(r);
  });

  app.put<{ Params: { id: string } }>('/api/logo/rules/:id', async (req) => {
    const r = d.logo.updateRule(req.params.id, req.body as LogoRuleInput);
    audit(req, `logo:rule:${r.id}`, 'update', `LOGO-Regel „${r.title}“ geändert`);
    return r;
  });

  app.delete<{ Params: { id: string } }>('/api/logo/rules/:id', async (req, reply) => {
    const r = d.logo.removeRule(req.params.id);
    audit(req, `logo:rule:${r.id}`, 'delete', `LOGO-Regel „${r.title}“ entfernt`);
    return reply.code(204).send();
  });

  app.post('/api/logo/links', async (req, reply) => {
    const l = d.logo.createLink(req.body as LogoLinkInput);
    audit(req, `logo:link:${l.id}`, 'create', `LOGO-Verknüpfung „${l.name}“ angelegt (${l.button} → ${l.output})`);
    return reply.code(201).send(l);
  });

  app.put<{ Params: { id: string } }>('/api/logo/links/:id', async (req) => {
    const l = d.logo.updateLink(req.params.id, req.body as LogoLinkInput);
    audit(req, `logo:link:${l.id}`, 'update', `LOGO-Verknüpfung „${l.name}“ geändert`);
    return l;
  });

  app.delete<{ Params: { id: string } }>('/api/logo/links/:id', async (req, reply) => {
    const l = d.logo.removeLink(req.params.id);
    audit(req, `logo:link:${l.id}`, 'delete', `LOGO-Verknüpfung „${l.name}“ entfernt`);
    return reply.code(204).send();
  });
}
