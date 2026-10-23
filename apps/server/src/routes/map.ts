import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_PRINT_ZOOM, MIN_PRINT_ZOOM, formatDtg, type MapPrintRequest } from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { renderMapPdf } from '../services/print.js';
import type { SettingsService } from '../services/settings.js';
import type { TileService } from '../services/tiles.js';
import { operatorOf, parse } from './util.js';

const latLon = z.object({ lat: z.number().min(-85).max(85), lon: z.number().min(-180).max(180) });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const printRequest: z.ZodType<MapPrintRequest> = z.object({
  paper: z.enum(['A4', 'A3', 'A2', 'A1']),
  orientation: z.enum(['portrait', 'landscape']),
  zoom: z.number().int().min(MIN_PRINT_ZOOM).max(MAX_PRINT_ZOOM),
  center: latLon,
  sourceId: z.string(),
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  markers: z
    .array(latLon.extend({ kind: z.enum(['vehicle', 'incident']), label: z.string().max(80) }))
    .max(20),
  polygons: z
    .array(
      z.object({
        points: z.array(z.tuple([z.number(), z.number()])).max(2000),
        stroke: color,
        fill: color,
        fillOpacity: z.number().min(0).max(1),
        dashed: z.boolean().optional(),
      }),
    )
    .max(20),
  legend: z.array(z.object({ color, label: z.string().max(120) })).max(10),
  notes: z.array(z.string().max(400)).max(10),
});

const tileParams = z.object({
  source: z.string(),
  z: z.coerce.number().int().min(0).max(22),
  x: z.coerce.number().int(),
  y: z.coerce.number().int(),
});

export function mapRoutes(app: FastifyInstance, tiles: TileService, store: Store, settings: SettingsService, notifyAudit: () => void): void {
  app.get('/api/map/sources', async () => tiles.list());

  app.get('/api/map/tiles/:source/:z/:x/:y', async (req, reply) => {
    const { source, z: zoom, x, y } = parse(tileParams, req.params);
    const tile = await tiles.get(source, zoom, x, y);
    if (!tile) return reply.code(404).send({ error: 'Kachel nicht verfügbar' });
    return reply.header('content-type', tile.contentType).header('cache-control', 'public, max-age=86400').send(tile.data);
  });

  app.post('/api/print/map', async (req, reply) => {
    const body = parse(printRequest, req.body);
    const source = tiles.source(body.sourceId);
    if (body.zoom > source.maxZoom) throw new HttpError(400, `${source.name} unterstützt höchstens Zoomstufe ${source.maxZoom}`);
    const operator = operatorOf(req);
    const { vehicle, mapSign } = settings.get();
    const { pdf, missingTiles } = await renderMapPdf(body, tiles, { vehicle, vehicleSign: mapSign, operator });
    store.addAudit({
      operator,
      target: 'karte',
      action: 'print',
      params: JSON.stringify({ paper: body.paper, orientation: body.orientation, zoom: body.zoom, source: body.sourceId }),
      success: true,
      message: missingTiles ? `${missingTiles} Kacheln fehlten` : '',
    });
    notifyAudit();
    const name = `Lagekarte_${body.paper}_${formatDtg(new Date())}.pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('x-missing-tiles', String(missingTiles))
      .send(pdf);
  });
}
