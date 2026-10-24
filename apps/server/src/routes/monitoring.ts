import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MONITORING_KIND_LABELS, type MonitoringTargetInput, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { MonitoringService } from '../services/monitoring.js';
import { operatorOf, parse } from './util.js';

interface Deps {
  monitoring: MonitoringService;
  store: Store;
  notify: (topics: Topic[]) => void;
}

/** Ziele des Monitorings – nur Admins (/api/system/, siehe auth/access.ts). Die Messwerte kommen live über das Modul. */
export function monitoringRoutes(app: FastifyInstance, d: Deps): void {
  const audit = (req: Parameters<typeof operatorOf>[0], target: string, action: string, message: string) => {
    d.store.addAudit({ operator: operatorOf(req), target, action, params: '{}', success: true, message });
    d.notify(['audit']);
  };

  app.get('/api/system/monitoring', async () => d.monitoring.list());

  app.post('/api/system/monitoring', async (req, reply) => {
    const t = d.monitoring.create(req.body as MonitoringTargetInput);
    audit(req, `monitoring:${t.id}`, 'create', `Monitoring-Ziel „${t.name}“ angelegt (${MONITORING_KIND_LABELS[t.kind]}, ${t.host})`);
    return reply.code(201).send(t);
  });

  app.put('/api/system/monitoring/order', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()) }), req.body);
    d.monitoring.reorder(ids);
    return d.monitoring.list();
  });

  app.post('/api/system/monitoring/test', async (req) => d.monitoring.test(req.body as MonitoringTargetInput));

  app.put<{ Params: { id: string } }>('/api/system/monitoring/:id', async (req) => {
    const t = d.monitoring.update(req.params.id, req.body as MonitoringTargetInput);
    audit(req, `monitoring:${t.id}`, 'update', `Monitoring-Ziel „${t.name}“ geändert`);
    return t;
  });

  app.delete<{ Params: { id: string } }>('/api/system/monitoring/:id', async (req, reply) => {
    const t = d.monitoring.remove(req.params.id);
    audit(req, `monitoring:${t.id}`, 'delete', `Monitoring-Ziel „${t.name}“ entfernt`);
    return reply.code(204).send();
  });
}
