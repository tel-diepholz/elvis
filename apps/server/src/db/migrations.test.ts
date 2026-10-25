import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openDb } from './index.js';

/** v22 zurückdrehen: Kräfte als flache Liste mit FMS-Status */
const BEFORE_FORCES = `
  DROP TABLE units; DROP TABLE force_unit_members; DROP TABLE force_units;
  CREATE TABLE units (
    id INTEGER PRIMARY KEY, incident_id INTEGER NOT NULL REFERENCES incidents(id), callsign TEXT NOT NULL,
    unit_type TEXT NOT NULL DEFAULT '', organization TEXT NOT NULL DEFAULT '', leaders INTEGER NOT NULL DEFAULT 0,
    sub_leaders INTEGER NOT NULL DEFAULT 0, crew INTEGER NOT NULL DEFAULT 0, section TEXT NOT NULL DEFAULT '',
    fms_status INTEGER, notes TEXT NOT NULL DEFAULT '', arrived_at TEXT NOT NULL, released_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE INDEX units_incident ON units(incident_id);
`;

describe('Migrationen', () => {
  it('ergänzt addons.manifest bei Datenbanken mit der frühen Fassung von v2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-mig-'));
    try {
      // Stand einer Entwicklungsdatenbank: alle Migrationen bis v4, aber addons ohne manifest
      openDb(dir).close();
      const legacy = new Database(join(dir, 'elvis.sqlite'));
      legacy.exec('ALTER TABLE addons DROP COLUMN manifest');
      // v19: Rollen und Aufgaben (Spalten mit Fremdschlüssel lassen sich nicht einzeln entfernen)
      legacy.exec('DROP TABLE tasks; DROP TABLE task_templates; DROP TABLE sessions; DROP TABLE roles');
      legacy.exec(
        "CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '')",
      );
      legacy.exec('DROP TABLE addon_job_runs'); // entstand erst mit v6
      legacy.exec('DROP TABLE camera_presets; DROP TABLE cameras; DROP TABLE display_scenes; DROP TABLE displays; DROP TABLE map_objects'); // v8–v12
      legacy.exec('ALTER TABLE incidents DROP COLUMN vehicle_visible'); // v13
      legacy.exec('DROP TABLE wifi_clients; DROP TABLE wifi_aps'); // v15–v16
      legacy.exec('DROP TABLE wopi_tokens; DROP TABLE templates; DROP TABLE template_folders'); // v17
      for (const c of ['folder_id', 'template_id', 'draft', 'created_by_user', 'updated_at', 'updated_by', 'version']) legacy.exec(`ALTER TABLE documents DROP COLUMN ${c}`);
      legacy.exec('DROP TABLE print_jobs'); // v20
      legacy.exec('DROP TABLE scans'); // v21
      legacy.exec(BEFORE_FORCES); // v22
      legacy.exec('DROP TABLE monitoring_targets'); // v23
      legacy.exec('DROP TABLE guest_print_jobs'); // v24
      legacy.exec('DROP TABLE workstations'); // v25
      legacy.exec('DROP TABLE bluetooth_devices'); // v27
      legacy.exec('DROP TABLE display_images'); // v29
      legacy.exec('DROP TABLE document_folders');
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

  it('überführt bisherige Kräfte in den Baum mit eigenem Status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-mig-'));
    try {
      openDb(dir).close();
      const legacy = new Database(join(dir, 'elvis.sqlite'));
      legacy.exec(BEFORE_FORCES);
      legacy.exec('DROP TABLE monitoring_targets; DROP TABLE guest_print_jobs; DROP TABLE workstations; DROP TABLE bluetooth_devices; DROP TABLE display_images');
      legacy.exec("INSERT INTO incidents (id, title, started_at) VALUES (1, 'Brand', 't0')");
      legacy.exec(`INSERT INTO units (incident_id, callsign, unit_type, crew, fms_status, arrived_at, released_at, updated_at) VALUES
        (1, 'Florian 1/44-1', 'HLF 20', 8, 4, 't1', NULL, 't1'), (1, 'Florian 1/19-1', 'LF 10 Sonderausführung', 5, 1, 't2', 't3', 't3')`);
      legacy.pragma('user_version = 21'); // vor v22
      legacy.close();

      const db = openDb(dir);
      const rows = db.prepare('SELECT name, sign, status, arrived_at, released_at, crew FROM units ORDER BY id').all();
      expect(rows).toEqual([
        { name: 'Florian 1/44-1', sign: '{"text":"HLF 20"}', status: 'eingetroffen', arrived_at: 't1', released_at: null, crew: 8 },
        { name: 'Florian 1/19-1', sign: '{"text":"LF 10 Sonder"}', status: 'entlassen', arrived_at: 't2', released_at: 't3', crew: 5 },
      ]);
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
