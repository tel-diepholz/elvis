import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { georefRequestSchema } from '@elvis/shared';
import type { GeorefService } from '../services/georef.js';
import { idParam, operatorOf, parse } from './util.js';

const pageParams = idParam.extend({ page: z.coerce.number().int().min(1) });
const overlayTileParams = z.object({
  id: z.coerce.number().int().positive(),
  z: z.coerce.number().int().min(0).max(22),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
});

/** Dokumente → Tools → „PDF in Karte integrieren“ (siehe services/georef.ts) */
export function georefRoutes(app: FastifyInstance, georef: GeorefService): void {
  app.get('/api/georef/status', async () => georef.status());
  app.get('/api/georef/jobs/:job', async (req) => georef.job(parse(z.object({ job: z.string().uuid() }), req.params).job));

  // Seiten eines PDFs rendern und abrufen
  app.post('/api/documents/:id/georef/pages', async (req, reply) => reply.code(202).send(georef.renderPages(parse(idParam, req.params).id, req.user?.id ?? null)));
  app.get('/api/documents/:id/georef/pages', async (req) => (await georef.pages(parse(idParam, req.params).id, req.user?.id ?? null)) ?? []);
  app.get('/api/documents/:id/georef/pages/:page', async (req, reply) => {
    const { id, page } = parse(pageParams, req.params);
    const thumb = !!(req.query as { thumb?: string }).thumb;
    return reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=3600').send(createReadStream(georef.pagePath(id, req.user?.id ?? null, page, thumb)));
  });

  // Seite mit Passpunkten als Overlay in die Karte übernehmen (Radierer-Striche bringen viele Punkte mit)
  app.post('/api/documents/:id/georef/overlay', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(202).send(georef.createOverlay(id, req.user?.id ?? null, parse(georefRequestSchema, req.body), operatorOf(req)));
  });

  // Kacheln (öffentlich lesbar wie alle Kartenkacheln, damit Bildschirme sie zeigen)
  app.get('/api/map/overlays/:id/:z/:x/:y', async (req, reply) => {
    const { id, z: zoom, x, y } = parse(overlayTileParams, req.params);
    const tile = await georef.tile(id, zoom, x, y);
    if (!tile) return reply.code(404).send({ error: 'Kachel nicht vorhanden' });
    return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=86400').send(tile);
  });
}
