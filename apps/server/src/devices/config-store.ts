import { optionsSchema, type AddonOption, type DeviceId, type DeviceModuleConfig, type OptionValues } from '@elvis/shared';
import type { ElvisConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { DEVICE_DEFINITIONS } from './drivers.js';

/** Werte auf die Felder des Treibers bringen: Vorgaben ergänzen, Typen angleichen, Unbekanntes verwerfen. */
export function normalizeOptions(defs: Record<string, AddonOption>, raw: Record<string, unknown>): OptionValues {
  const out: OptionValues = {};
  for (const [key, o] of Object.entries(defs)) {
    const v = raw[key];
    switch (o.type) {
      case 'bool':
        out[key] = typeof v === 'boolean' ? v : (o.default ?? false);
        break;
      case 'int':
        out[key] = v === undefined || v === null || v === '' ? (o.default ?? o.min ?? 0) : Number(v);
        break;
      case 'multiselect':
        out[key] = Array.isArray(v) ? v.map(String) : o.default;
        break;
      case 'select':
        out[key] = v === undefined || v === null ? (o.default ?? (typeof o.choices[0] === 'string' ? o.choices[0] : o.choices[0]!.value)) : String(v);
        break;
      case 'password':
        out[key] = v === undefined || v === null ? '' : String(v);
        break;
      default:
        out[key] = v === undefined || v === null ? (o.default ?? '') : String(v);
    }
  }
  return out;
}

/**
 * Konfiguration der Fahrzeugmodule (aktiv, Treiber, Treiber-Einstellungen). Gespeichert in der Tabelle
 * settings unter `device:<id>`; ohne Eintrag gelten die Vorgaben aus config/elvis.json.
 */
export class DeviceConfigStore {
  constructor(
    private readonly db: Db | null,
    private readonly defaults: ElvisConfig['devices'],
  ) {}

  get(id: DeviceId): { config: DeviceModuleConfig; source: 'settings' | 'config' } {
    const row = this.db?.prepare('SELECT value FROM settings WHERE key = ?').get(`device:${id}`) as { value: string } | undefined;
    const stored = row ? (JSON.parse(row.value) as Partial<DeviceModuleConfig>) : null;
    const fallback = this.defaults[id] ?? { enabled: true, driver: '', options: {} };
    const raw = stored ?? fallback;
    const drivers = DEVICE_DEFINITIONS[id].drivers as Record<string, { options: Record<string, AddonOption> }>;
    // Vorgabe: Simulation, bei Modulen ohne Simulator der erste Treiber
    const driver = raw.driver && drivers[raw.driver] ? raw.driver : drivers.sim ? 'sim' : Object.keys(drivers)[0]!;
    return {
      config: { enabled: raw.enabled ?? true, driver, options: normalizeOptions(drivers[driver]!.options, (raw.options ?? {}) as Record<string, unknown>) },
      source: stored ? 'settings' : 'config',
    };
  }

  /** Prüft gegen das Formular des Treibers und speichert; liefert die bereinigte Konfiguration. */
  set(id: DeviceId, input: DeviceModuleConfig, actor: string): DeviceModuleConfig {
    if (!this.db) throw new HttpError(500, 'Keine Datenbank für die Modulkonfiguration');
    const drivers = DEVICE_DEFINITIONS[id].drivers as Record<string, { options: Record<string, AddonOption> }>;
    const def = drivers[input.driver];
    if (!def) throw new HttpError(400, `Unbekannter Treiber „${input.driver}“`);
    // Leere Passwortfelder bedeuten „unverändert“ (Passwörter werden nie an die Oberfläche ausgeliefert)
    const current = this.get(id).config;
    const options = { ...input.options };
    for (const [k, o] of Object.entries(def.options)) {
      if (o.type === 'password' && !options[k] && current.driver === input.driver && current.options[k]) options[k] = current.options[k]!;
    }
    const normalized = normalizeOptions(def.options, options);
    // Deaktivieren geht immer, auch wenn die Einstellungen (noch) unvollständig sind
    const parsed = input.enabled ? optionsSchema(def.options).safeParse(normalized) : ({ success: true, data: normalized } as const);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const config: DeviceModuleConfig = { enabled: input.enabled, driver: input.driver, options: parsed.data };
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(`device:${id}`, JSON.stringify(config), new Date().toISOString(), actor);
    return config;
  }
}
