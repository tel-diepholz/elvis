import type { FastifyInstance } from 'fastify';
import type { Store } from '../db/store.js';
import type { UpdateService } from '../services/updates.js';
import { operatorOf } from './util.js';

/** Einstellungen → Update (Admins, /api/system/…): nach Updates suchen und installieren */
export function updateRoutes(app: FastifyInstance, deps: { updates: UpdateService; store: Store }): void {
  const { updates, store } = deps;

  app.get('/api/system/updates', async () => updates.status());
  app.post('/api/system/updates/check', async () => updates.check());
  // Startet im Hintergrund; Fortschritt über GET /api/system/updates
  app.post('/api/system/updates/install', async (req, reply) => {
    const before = updates.status();
    const target = before.latest?.version ?? '?';
    try {
      const status = updates.install();
      store.addAudit({ operator: operatorOf(req), target: 'update', action: 'install', params: '', success: true, message: `Update ${before.current} → ${target} gestartet` });
      return reply.code(202).send(status);
    } catch (err) {
      store.addAudit({ operator: operatorOf(req), target: 'update', action: 'install', params: '', success: false, message: (err as Error).message });
      throw err;
    }
  });
}
