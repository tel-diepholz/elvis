import type { FastifyInstance } from 'fastify';
import { scanAssignSchema, scanSettingsInputSchema, type ScanInbox, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { ScanService } from '../services/scanning.js';
import { idParam, operatorOf, parse } from './util.js';

export function scanningRoutes(app: FastifyInstance, deps: { scanning: ScanService; store: Store; notify: (t: Topic[]) => void }): void {
  const { scanning } = deps;

  // --- Scan-Eingang (Anmeldung nötig) ---

  app.get('/api/scans', async (): Promise<ScanInbox> => ({ status: scanning.status(), scans: scanning.list() }));

  app.get('/api/scans/:id/file', async (req, reply) => {
    const f = await scanning.file(parse(idParam, req.params).id);
    const disposition = (req.query as { download?: string }).download ? 'attachment' : 'inline';
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .send(f.content);
  });

  app.post('/api/scans/:id/assign', async (req) => scanning.assign(parse(idParam, req.params).id, parse(scanAssignSchema, req.body), operatorOf(req)));

  app.delete('/api/scans/:id', async (req, reply) => {
    await scanning.remove(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });

  // --- Einstellungen (nur Admins über /api/system/) ---

  app.get('/api/system/scanning', async () => scanning.settings());

  app.put('/api/system/scanning', async (req) => {
    const input = parse(scanSettingsInputSchema, req.body);
    const next = scanning.setSettings(input, operatorOf(req));
    deps.store.addAudit({
      operator: operatorOf(req),
      target: 'scan',
      action: 'einstellungen',
      params: '',
      success: true,
      message: [
        input.enabled ? 'Empfang an' : 'Empfang aus',
        input.archive ? `Ablage unter „${input.folderPath || '/'}“` : 'Ablage aus',
        input.allowedHosts.length ? `nur ${input.allowedHosts.join(', ')}` : 'alle Absender',
        input.username ? 'mit Anmeldung' : 'ohne Anmeldung',
      ].join(', '),
    });
    deps.notify(['audit']);
    return next;
  });
}
