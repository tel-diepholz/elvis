import { DEFAULT_VEHICLE_SIGN, settingsInputSchema, tacticalSignSchema, type Settings, type SettingsInput, type VehicleInfo } from '@elvis/shared';
import type { Db } from '../db/index.js';

interface Row {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string;
}

/**
 * Einstellungen, die Admins in der Oberfläche pflegen. Fehlt ein Wert, gelten die Vorgaben aus
 * config/elvis.json (Fahrzeug) bzw. das Standard-Kartenzeichen (ELW 2 der Feuerwehr).
 */
export class SettingsService {
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(
    private readonly db: Db,
    private readonly defaults: { vehicle: VehicleInfo },
  ) {}

  get(): Settings {
    // device:<id> gehört zur Modulkonfiguration (DeviceConfigStore), wifi:* zum WLAN (WifiService), documents:* zu den Dokumenten, print:* zum Druckserver, app:* zur App-Anbindung, map:* zu den Kartenquellen (TileService), traffic:* zum Luft- und Schiffsverkehr, messages:* zu den Meldungen, requests:* zu den Anforderungen, mail:* zum Postfach, backup:* zum Backup
    const rows = this.db
      .prepare("SELECT * FROM settings WHERE key NOT LIKE 'device:%' AND key NOT LIKE 'wifi:%' AND key NOT LIKE 'documents:%' AND key NOT LIKE 'print:%' AND key NOT LIKE 'app:%' AND key NOT LIKE 'map:%' AND key NOT LIKE 'traffic:%' AND key NOT LIKE 'messages:%' AND key NOT LIKE 'requests:%' AND key NOT LIKE 'mail:%' AND key NOT LIKE 'backup:%'")
      .all() as Row[];
    const value = <T>(key: string): T | undefined => {
      const r = rows.find((x) => x.key === key);
      return r ? (JSON.parse(r.value) as T) : undefined;
    };
    const latest = rows.reduce<Row | null>((a, r) => (!a || r.updated_at > a.updated_at ? r : a), null);
    // Gespeicherte Zeichen durch das Schema führen, damit neue Felder Defaults bekommen.
    const sign = tacticalSignSchema.safeParse(value('mapSign') ?? DEFAULT_VEHICLE_SIGN);
    return {
      vehicle: { ...this.defaults.vehicle, ...value<VehicleInfo>('vehicle') },
      mapSign: sign.success ? sign.data : DEFAULT_VEHICLE_SIGN,
      updatedAt: latest?.updated_at ?? null,
      updatedBy: latest?.updated_by ?? null,
    };
  }

  update(input: SettingsInput, actor: string): Settings {
    const s = settingsInputSchema.parse(input);
    const ts = new Date().toISOString();
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    );
    this.db.transaction(() => {
      upsert.run('vehicle', JSON.stringify(s.vehicle), ts, actor);
      upsert.run('mapSign', JSON.stringify(s.mapSign), ts, actor);
    })();
    const next = this.get();
    this.listeners.forEach((l) => l(next));
    return next;
  }

  onChange(l: (s: Settings) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
