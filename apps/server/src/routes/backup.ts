import type { FastifyInstance } from 'fastify';
import { backupConfirmSchema, backupSettingsSchema, backupSetupSchema, restoreListSchema, restoreStartSchema } from '@elvis/shared';
import type { BackupService } from '../services/backup/service.js';
import type { RestoreService } from '../services/backup/restore.js';
import { operatorOf, parse } from './util.js';

/** Backup einrichten und steuern (Admins, /api/system/…); Wiederherstellen nur bei der Ersteinrichtung (/api/restore/…) */
export function backupRoutes(app: FastifyInstance, deps: { backup: BackupService; restore: RestoreService }): void {
  const { backup, restore } = deps;

  app.get('/api/system/backup', async () => backup.status());
  app.put('/api/system/backup', async (req) => backup.update(parse(backupSettingsSchema, req.body), operatorOf(req)));
  app.delete('/api/system/backup', async (req, reply) => {
    backup.disable(operatorOf(req));
    return reply.code(204).send();
  });
  app.post('/api/system/backup/setup', async (req) => backup.beginSetup(parse(backupSetupSchema, req.body).driver));
  app.post('/api/system/backup/setup/confirm', async (req) => backup.confirmSetup(parse(backupConfirmSchema, req.body), operatorOf(req)));
  // Startet im Hintergrund; der Fortschritt kommt über das Topic „backup“
  app.post('/api/system/backup/run', async (_req, reply) => {
    backup.trigger();
    return reply.code(202).send(await backup.status());
  });

  app.post('/api/restore/list', async (req) => restore.list(parse(restoreListSchema, req.body)));
  app.post('/api/restore/start', async (req, reply) => reply.code(202).send(await restore.start(parse(restoreStartSchema, req.body))));
  app.get('/api/restore/status', async () => restore.status());
}
