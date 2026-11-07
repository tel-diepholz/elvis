import { WATER_SUPPLY_MAX_RADIUS_M, distanceM, type WaterSupplyCandidate, type WaterSupplyRequest, type WaterSupplyResult } from '@elvis/shared';
import { HttpError } from '../errors.js';
import type { LibraryService } from './library.js';
import type { RouterService } from './router.js';

/** Suchradien (Luftlinie) für die Vorauswahl; der nächste kommt nur dran, wenn zu wenige gefunden wurden */
const RADII_M = [2_000, 5_000, WATER_SUPPLY_MAX_RADIUS_M];

/**
 * Nächste Wasserentnahmestellen zum Einsatzort: Vorauswahl nach Luftlinie aus der Objektbibliothek (Typ
 * „Wasserentnahmestelle“, lokal und aus der Cloud), dann Fußweg über Valhalla zum Einsatzort, sortiert nach
 * Wegstrecke.
 */
export class WaterSupplyService {
  constructor(
    private readonly library: LibraryService,
    private readonly router: RouterService,
  ) {}

  /** Entnahmestellen nach Luftlinie, nächste zuerst */
  nearest(origin: { lat: number; lon: number }, count: number): { object: WaterSupplyCandidate['object']; airDistanceM: number }[] {
    const typeIds = this.library
      .types()
      .filter((t) => t.builtin === 'water')
      .map((t) => t.id);
    if (!typeIds.length) return [];
    let found: { object: WaterSupplyCandidate['object']; airDistanceM: number }[] = [];
    for (const r of RADII_M) {
      const dLat = r / 111_195;
      const dLon = r / (111_195 * Math.cos((origin.lat * Math.PI) / 180));
      const bbox = { s: origin.lat - dLat, n: origin.lat + dLat, w: origin.lon - dLon, e: origin.lon + dLon };
      found = this.library
        .objects({ bbox, typeIds })
        .map((object) => ({ object, airDistanceM: Math.round(distanceM(origin, object)) }))
        .filter((x) => x.airDistanceM <= r)
        .sort((a, b) => a.airDistanceM - b.airDistanceM);
      if (found.length >= count) break;
    }
    return found.slice(0, count);
  }

  async find(req: Required<WaterSupplyRequest>): Promise<WaterSupplyResult> {
    if (!this.router.status().available) throw new HttpError(503, 'Routing nicht verfügbar – Addon „OSM-Daten“ installieren');
    const near = this.nearest(req, req.count);
    let source: string | null = null;
    // Öffentlicher Server: nur wenige Anfragen gleichzeitig (Nutzungsbedingungen), lokal alle auf einmal
    const parallel = this.router.onlineOnly ? 2 : Math.max(1, near.length);
    const candidates: WaterSupplyCandidate[] = [];
    for (let i = 0; i < near.length; i += parallel) {
      const batch = await Promise.all(
        near.slice(i, i + parallel).map(async ({ object, airDistanceM }): Promise<WaterSupplyCandidate> => {
          try {
            const r = await this.router.walkPath(object, req);
            source = r.source;
            return { object, airDistanceM, route: { distanceM: r.distanceM, path: r.path }, error: null };
          } catch (e) {
            return { object, airDistanceM, route: null, error: (e as Error).message };
          }
        }),
      );
      candidates.push(...batch);
    }
    candidates.sort((a, b) => (a.route?.distanceM ?? Infinity) - (b.route?.distanceM ?? Infinity) || a.airDistanceM - b.airDistanceM);
    return { candidates, source };
  }
}
