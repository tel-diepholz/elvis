import type { FastifyInstance } from 'fastify';
import { cloudLinkInputSchema } from '@elvis/shared';
import type { CloudService } from '../services/cloud.js';
import type { CloudSyncService } from '../services/cloudsync.js';
import { operatorOf, parse } from './util.js';

/** Cloud-Zugang: Verknüpfung mit dem Portal (nur Admins) */
export function cloudRoutes(app: FastifyInstance, cloud: CloudService, sync: CloudSyncService): void {
  app.get('/api/system/cloud', async (req) => cloud.status((req.query as { refresh?: string }).refresh === '1'));
  app.post('/api/system/cloud/link', async (req) => cloud.requestLink(parse(cloudLinkInputSchema, req.body).name, operatorOf(req)));
  app.delete('/api/system/cloud', async (req) => cloud.unlink(operatorOf(req)));

  // Stammdaten-Abgleich
  app.get('/api/system/cloud/sync', async () => sync.status());
  app.post('/api/system/cloud/sync/enable', async (req) => sync.enable(operatorOf(req)));
  app.post('/api/system/cloud/sync/disable', async (req) => sync.disable(operatorOf(req)));
  app.post('/api/system/cloud/sync/resync', async (req) => sync.resync(operatorOf(req)));
  app.post('/api/system/cloud/sync/run', async () => (await sync.run(), sync.status()));
}
