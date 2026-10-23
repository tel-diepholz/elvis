import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openDb } from './index.js';

describe('Migrationen', () => {
  it('ergänzt addons.manifest bei Datenbanken mit der frühen Fassung von v2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-mig-'));
    try {
      // Stand einer Entwicklungsdatenbank: alle Migrationen bis v4, aber addons ohne manifest
      openDb(dir).close();
      const legacy = new Database(join(dir, 'elvis.sqlite'));
      legacy.exec('ALTER TABLE addons DROP COLUMN manifest');
      legacy.exec('DROP TABLE addon_job_runs'); // entstand erst mit v6
      legacy.exec('DROP TABLE camera_presets; DROP TABLE cameras; DROP TABLE display_scenes; DROP TABLE displays; DROP TABLE map_objects'); // v8–v12
      legacy.exec('ALTER TABLE incidents DROP COLUMN vehicle_visible'); // v13
      legacy.exec('DROP TABLE wifi_clients; DROP TABLE wifi_aps'); // v15–v16
      legacy.pragma('user_version = 4');
      legacy.close();

      const db = openDb(dir);
      const columns = (db.prepare('PRAGMA table_info(addons)').all() as { name: string }[]).map((c) => c.name);
      expect(columns).toContain('manifest');
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lässt frische Datenbanken unverändert durchlaufen', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });
});
