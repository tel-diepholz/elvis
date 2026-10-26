import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_PRINT_ZOOM, MIN_PRINT_ZOOM, formatDtg, mapSourceInputSchema, mapSourceListSchema, overpassQueryListSchema, overpassRunSchema, tacticalSignSchema, type MapPrintRequest, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { renderMapPdf } from '../services/print.js';
import type { SettingsService } from '../services/settings.js';
import type { GeocoderService } from '../services/geocoder.js';
import type { OverpassService } from '../services/overpass.js';
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
    .array(latLon.extend({ kind: z.enum(['vehicle', 'incident', 'point', 'unit']), label: z.string().max(120), color: color.optional(), icon: z.string().max(60).optional(), sign: tacticalSignSchema.optional() }))
    .max(300),
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
    .max(100),
  lines: z.array(z.object({ points: z.array(z.tuple([z.number(), z.number()])).min(2).max(2000), color })).max(200).optional(),
  legend: z.array(z.object({ color, label: z.string().max(160) })).max(30),
  notes: z.array(z.string().max(400)).max(20),
});

const tileParams = z.object({
  source: z.string(),
  z: z.coerce.number().int().min(0).max(22),
  x: z.coerce.number().int(),
  y: z.coerce.number().int(),
});

/** Ohne Einsatzort prüft „Testen“ eine Kachel in der Mitte Niedersachsens. */
const TEST_FALLBACK = { lat: 52.64, lon: 9.35 };

const searchQuery = z.object({
  q: z.string().max(200).default(''),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});

export function mapRoutes(app: FastifyInstance, tiles: TileService, store: Store, settings: SettingsService, notify: (topics: Topic[]) => void, geocoder: GeocoderService, overpass: OverpassService): void {
  app.get('/api/map/sources', async () => tiles.list());

  /** Ortssuche: Straßen, Orte, Adressen sowie Koordinaten und UTMREF; lat/lon bevorzugen Treffer in der Nähe */
  app.get('/api/map/search', async (req) => {
    const { q, lat, lon } = parse(searchQuery, req.query);
    return geocoder.search(q, lat !== undefined && lon !== undefined ? { lat, lon } : null);
  });

  /** Umriss eines Orts oder Gebiets zu einem Suchtreffer (osm = „R1461203“) */
  app.get<{ Params: { osm: string } }>('/api/map/outline/:osm', async (req) => {
    const outline = await geocoder.outline(req.params.osm);
    if (!outline) throw new HttpError(404, 'Kein Umriss verfügbar');
    return outline;
  });

  /** Overpass-Abfrage für den Kartenausschnitt (lokal, sonst öffentlich); nur angemeldet */
  app.post('/api/map/overpass', async (req) => {
    const { query, bounds } = parse(overpassRunSchema, req.body);
    return overpass.run(query, bounds);
  });

  app.get('/api/map/overpass/status', async () => overpass.status());

  /** Vorlagen aus den Einstellungen (Menü „Objekte“) */
  app.get('/api/map/overpass/queries', async () => overpass.settings().queries);

  app.get('/api/map/tiles/:source/:z/:x/:y', async (req, reply) => {
    const { source, z: zoom, x, y } = parse(tileParams, req.params);
    const tile = await tiles.get(source, zoom, x, y);
    if (!tile) return reply.code(404).send({ error: 'Kachel nicht verfügbar' });
    return reply.header('content-type', tile.contentType).header('cache-control', 'public, max-age=86400').send(tile.data);
  });

  // Flächen aus der Objektliste bringen viele Punkte mit
  app.post('/api/print/map', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
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
    notify(['audit']);
    const name = `Lagekarte_${body.paper}_${formatDtg(new Date())}.pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('x-missing-tiles', String(missingTiles))
      .send(pdf);
  });

  // --- Kartenquellen in den Einstellungen (nur Admins über /api/system/) ---

  app.get('/api/system/map-sources', async () => tiles.settings());

  app.put('/api/system/map-sources', async (req) => {
    const { sources } = parse(z.object({ sources: mapSourceListSchema }), req.body);
    const before = new Set(tiles.settings().sources.filter((s) => s.origin === 'settings').map((s) => s.name));
    const next = await tiles.setSettingsSources(sources, operatorOf(req));
    const after = next.sources.filter((s) => s.origin === 'settings').map((s) => s.name);
    store.addAudit({
      operator: operatorOf(req),
      target: 'karte',
      action: 'kartenquellen',
      params: '',
      success: true,
      message: [
        ...after.filter((n) => !before.has(n)).map((n) => `„${n}“ hinzugefügt`),
        ...[...before].filter((n) => !after.includes(n)).map((n) => `„${n}“ entfernt`),
      ].join(', ') || 'geändert',
    });
    notify(['mapSources', 'audit']);
    return next;
  });

  // --- Overpass-Standardabfragen ---

  app.get('/api/system/overpass-queries', async () => overpass.settings());

  app.put('/api/system/overpass-queries', async (req) => {
    const { queries } = parse(z.object({ queries: overpassQueryListSchema }), req.body);
    const next = overpass.setQueries(queries, operatorOf(req));
    store.addAudit({
      operator: operatorOf(req),
      target: 'karte',
      action: 'overpass-abfragen',
      params: '',
      success: true,
      message: `${queries.length} Overpass-Vorlagen gespeichert`,
    });
    notify(['overpassQueries', 'audit']);
    return next;
  });

  app.post('/api/system/map-sources/test', async (req) => {
    const source = parse(mapSourceInputSchema, req.body);
    const incident = store.activeIncident();
    const at = incident?.lat != null && incident.lon != null ? { lat: incident.lat, lon: incident.lon } : TEST_FALLBACK;
    return tiles.test(source, at);
  });
}
