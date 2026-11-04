import type { FastifyInstance } from 'fastify';
import type { Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { ReportService } from '../services/report/index.js';
import { idParam, operatorOf, parse } from './util.js';

export interface ReportRouteDeps {
  report: ReportService;
  store: Store;
  notify: (topics: Topic[]) => void;
}

export function reportRoutes(app: FastifyInstance, { report, store, notify }: ReportRouteDeps): void {
  /** Einsatzbericht frisch erzeugen (laufender Einsatz = Zwischenbericht) */
  app.get('/api/incidents/:id/report.pdf', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const operator = operatorOf(req);
    const { pdf, filename } = await report.generate(id, operator);
    store.addAudit({ operator, target: 'einsatzbericht', action: 'export', params: JSON.stringify({ incidentId: id }), success: true, message: `${Math.round(pdf.length / 1024)} KB` });
    notify(['audit']);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(pdf);
  });
}
