import type { Db } from '../../db/index.js';
import type { DriverVault } from './bus.js';

/** Ablage der Treiber in der Tabelle settings (Schlüssel driver:<name>) */
export function dbVault(db: Db): DriverVault {
  return {
    get: (key) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(`driver:${key}`) as { value: string } | undefined)?.value ?? null,
    set: (key, value) => {
      if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(`driver:${key}`);
      else
        db.prepare(
          "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'Treiber') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        ).run(`driver:${key}`, value, new Date().toISOString());
    },
  };
}
