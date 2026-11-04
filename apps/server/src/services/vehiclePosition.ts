import { manualPositionInputSchema, vehiclePosition, type GeoPosition, type ManualPosition, type ManualPositionInput, type VehiclePosition } from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';

const KEY = 'position:manual';

/**
 * Fahrzeugstandort für Server-Dienste (Unwetter, Verkehr) und den von Hand gesetzten Standort.
 * Von Hand setzen geht nur ohne GPS-Fix. Kommt der Fix zurück, wird die Position verworfen,
 * damit sie bei einem späteren Ausfall nicht die neuere letzte GPS-Position überdeckt.
 */
export class VehiclePositionService {
  constructor(
    private readonly db: Db,
    private readonly gps: () => GeoPosition | null | undefined,
    private readonly notify: () => void,
  ) {}

  manual(): ManualPosition | null {
    const r = this.db.prepare('SELECT value, updated_at, updated_by FROM settings WHERE key = ?').get(KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
    if (!r) return null;
    const v = JSON.parse(r.value) as ManualPositionInput;
    return { lat: v.lat, lon: v.lon, setAt: r.updated_at, setBy: r.updated_by };
  }

  current(): VehiclePosition | null {
    return vehiclePosition(this.gps(), this.manual());
  }

  set(raw: ManualPositionInput, actor: string): ManualPosition {
    if (this.gps()?.fix) throw new HttpError(409, 'Das Fahrzeug hat GPS-Empfang – die Position kommt vom GPS');
    const input = manualPositionInputSchema.parse(raw);
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(KEY, JSON.stringify({ lat: input.lat, lon: input.lon }), new Date().toISOString(), actor);
    this.notify();
    return this.manual()!;
  }

  clear(): boolean {
    const removed = this.db.prepare('DELETE FROM settings WHERE key = ?').run(KEY).changes > 0;
    if (removed) this.notify();
    return removed;
  }

  /** Bei jeder neuen Wetterstationsmeldung aufrufen: mit GPS-Fix gilt wieder das GPS. */
  gpsChanged(): void {
    if (this.gps()?.fix && this.manual()) this.clear();
  }
}
