import type { FastifyInstance } from 'fastify';
import { elevationRequestSchema, formatDtg, waterSupplyPrintSchema, waterSupplyRequestSchema, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { ElevationService } from '../services/elevation.js';
import type { SettingsService } from '../services/settings.js';
import type { TileService } from '../services/tiles.js';
import { renderWaterSupplyPdf } from '../services/water-print.js';
import type { WaterSupplyService } from '../services/watersupply.js';
import { operatorOf, parse } from './util.js';

/** Wasserversorgung auf der Karte (Menü „Objekte“); nur angemeldet */
export function waterSupplyRoutes(
  app: FastifyInstance,
  deps: { water: WaterSupplyService; elevation: ElevationService; tiles: TileService; settings: SettingsService; store: Store; notify: (topics: Topic[]) => void },
): void {
  /** Nächste Wasserentnahmestellen zum Einsatzort mit Fußweg, kürzester Weg zuerst */
  app.post('/api/map/water-supply', async (req) => deps.water.find(parse(waterSupplyRequestSchema, req.body)));

  /** Höhenschnitt entlang eines Wegs */
  app.post('/api/map/elevation', async (req) => deps.elevation.profile(parse(elevationRequestSchema, req.body).path));

  /** Ausdruck A4 quer: Karte mit Schlauchweg und Pumpen, Kennzahlen, Pumpentabelle und Höhenschnitt */
  app.post('/api/print/water-supply', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const body = parse(waterSupplyPrintSchema, req.body);
    const operator = operatorOf(req);
    const { pdf, missingTiles } = await renderWaterSupplyPdf(body, deps.tiles, { vehicle: deps.settings.get().vehicle, operator });
    deps.store.addAudit({
      operator,
      target: 'karte',
      action: 'print-water-supply',
      params: JSON.stringify({ water: body.water.name, pumps: body.pumpDs.length + 1, hose: body.hydraulics.hose, source: body.sourceId }),
      success: true,
      message: missingTiles ? `${missingTiles} Kacheln fehlten` : '',
    });
    deps.notify(['audit']);
    const name = `Wasserversorgung_${formatDtg(new Date())}.pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('x-missing-tiles', String(missingTiles))
      .send(pdf);
  });
}
