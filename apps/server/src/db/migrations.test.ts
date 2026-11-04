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

/** Schadenkonten zurückdrehen (die beiden letzten Migrationen) */
const UNDO_DAMAGE = 'DROP INDEX units_account; ALTER TABLE units DROP COLUMN account_id; DROP TABLE damage_counts; DROP TABLE damage_entries; DROP TABLE damage_accounts';
const UNDO_TELEPHONY = 'DROP TABLE user_dashboards; DROP TABLE phone_key_overrides; DROP TABLE phones; DROP TABLE chat_reachability; DROP TABLE chat_messages; DROP TABLE chat_files; DROP TABLE calls; ALTER TABLE force_units DROP COLUMN mobile; ALTER TABLE units DROP COLUMN mobile';
const UNDO_CONTACTS = 'DROP TABLE contact_category_members; DROP TABLE contacts; DROP TABLE contact_categories; ALTER TABLE personnel DROP COLUMN email';
/** v37 zurückdrehen: Anforderungen samt Verweisen */
const UNDO_MAIL = 'DROP TABLE mail_attachments; DROP TABLE mail_messages; DROP TABLE mail_keys';
const UNDO_REQUESTS = `
  DROP TABLE requests; DROP INDEX journal_request;
  ALTER TABLE tasks DROP COLUMN request_id; ALTER TABLE messages DROP COLUMN request_id; ALTER TABLE journal DROP COLUMN request_id;
  ALTER TABLE incidents DROP COLUMN procurement_mode; ALTER TABLE incidents DROP COLUMN procurement_staff;
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
      legacy.exec(UNDO_DAMAGE);
      legacy.exec(UNDO_TELEPHONY); // v45, v47
      legacy.exec('ALTER TABLE force_units DROP COLUMN email; ALTER TABLE messages DROP COLUMN sender_force_id; ALTER TABLE messages DROP COLUMN recipient_force_id'); // v41
      legacy.exec('ALTER TABLE units DROP COLUMN email'); // v40
      legacy.exec('DROP TABLE radio_ids; DROP TABLE user_last_roles'); // v44
      legacy.exec(UNDO_CONTACTS); // v39
      legacy.exec(UNDO_MAIL); // v38
      legacy.exec(UNDO_REQUESTS); // v37
      legacy.exec('DROP TABLE map_history; DROP TABLE incident_overpass_queries; DROP TABLE message_copies; DROP TABLE messages'); // v33–v36, Verlauf
      legacy.exec('DROP TABLE session_roles'); // v32
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
      legacy.exec('DROP TABLE personnel; DROP TABLE personnel_sheets; DROP TABLE personnel_forms'); // v31
      legacy.exec('DROP TABLE app_links'); // v30
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
      legacy.exec(UNDO_DAMAGE);
      legacy.exec(UNDO_TELEPHONY);
      legacy.exec('DROP TABLE radio_ids; DROP TABLE user_last_roles');
      legacy.exec(UNDO_CONTACTS);
      legacy.exec(UNDO_MAIL);
      legacy.exec(UNDO_REQUESTS);
      legacy.exec('DROP TABLE map_history; DROP TABLE incident_overpass_queries; DROP TABLE message_copies; DROP TABLE messages; ALTER TABLE map_objects DROP COLUMN label');
      legacy.exec(BEFORE_FORCES);
      legacy.exec('DROP TABLE monitoring_targets; DROP TABLE guest_print_jobs; DROP TABLE workstations; DROP TABLE bluetooth_devices; DROP TABLE display_images; DROP TABLE personnel; DROP TABLE personnel_sheets; DROP TABLE personnel_forms; DROP TABLE app_links; DROP TABLE session_roles; ALTER TABLE cameras DROP COLUMN bells');
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

  it('übernimmt SMS in die gemeinsamen Nachrichten', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-mig-'));
    try {
      openDb(dir).close();
      const legacy = new Database(join(dir, 'elvis.sqlite'));
      legacy.exec(UNDO_DAMAGE);
      legacy.exec('ALTER TABLE cameras DROP COLUMN bells; DROP TABLE user_dashboards; DROP TABLE phone_key_overrides; DROP TABLE phones; DROP TABLE chat_reachability; DROP TABLE chat_messages; DROP TABLE chat_files');
      legacy.exec(`CREATE TABLE sms_messages (id INTEGER PRIMARY KEY, folder TEXT NOT NULL, port INTEGER, number TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, seen INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL, created_by TEXT NOT NULL)`);
      legacy.exec(`INSERT INTO sms_messages VALUES (7, 'inbox', 1, '+491711234567', 'Hallo', 'received', NULL, 0, 't1', 'Gateway'),
        (9, 'sent', 2, '+491609999999', 'Rückruf', 'failed', 'Netz', 1, 't2', 'Max Müller')`);
      // Stand vor der SMS-Migration (danach: Signal-Kennungen neu prüfen)
      legacy.pragma(`user_version = ${SCHEMA_VERSION - 8}`);
      legacy.close();

      const db = openDb(dir);
      expect(db.prepare('SELECT id, channel, folder, peer, number, text, port, status, error, seen, date, created_by FROM chat_messages ORDER BY id').all()).toEqual([
        { id: 7, channel: 'sms', folder: 'inbox', peer: '+491711234567', number: '+491711234567', text: 'Hallo', port: 1, status: 'received', error: null, seen: 0, date: 't1', created_by: 'Gateway' },
        { id: 9, channel: 'sms', folder: 'sent', peer: '+491609999999', number: '+491609999999', text: 'Rückruf', port: 2, status: 'failed', error: 'Netz', seen: 1, date: 't2', created_by: 'Max Müller' },
      ]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sms_messages'").get()).toBeUndefined();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gibt alte Signal-Prüfungen (Kennung = Rufnummer) zur sofortigen Neuprüfung frei', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-mig-'));
    try {
      openDb(dir).close();
      const legacy = new Database(join(dir, 'elvis.sqlite'));
      legacy.exec(UNDO_DAMAGE);
      legacy.exec('ALTER TABLE cameras DROP COLUMN bells; DROP TABLE user_dashboards; DROP TABLE phone_key_overrides; DROP TABLE phones');
      legacy.exec(`INSERT INTO chat_reachability VALUES ('signal', '+491711234567', 1, '+491711234567', '2099-01-01'),
        ('signal', '+491609999999', 1, 'uuid-x', '2099-01-01'), ('threema', '+491711234567', 1, 'ABCD1234', '2099-01-01')`);
      legacy.pragma(`user_version = ${SCHEMA_VERSION - 7}`);
      legacy.close();

      const db = openDb(dir);
      expect(db.prepare('SELECT channel, number, checked_at FROM chat_reachability ORDER BY channel, number').all()).toEqual([
        { channel: 'signal', number: '+491609999999', checked_at: '2099-01-01' },
        { channel: 'signal', number: '+491711234567', checked_at: '1970-01-01T00:00:00.000Z' },
        { channel: 'threema', number: '+491711234567', checked_at: '2099-01-01' },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('macht aus Freitext-Abschnitten Schadenkonten', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elvis-mig-'));
    try {
      openDb(dir).close();
      const legacy = new Database(join(dir, 'elvis.sqlite'));
      legacy.exec(UNDO_DAMAGE);
      legacy.exec("INSERT INTO incidents (id, title, started_at, closed_at) VALUES (1, 'Brand', 't0', 't9'), (2, 'Sturm', 't10', NULL)");
      const unit = legacy.prepare(
        "INSERT INTO units (incident_id, name, sign, section, status, created_at, updated_at) VALUES (?, ?, '{}', ?, 'einsatz', ?, ?)",
      );
      for (const [inc, name, section, at] of [
        [1, 'HLF', 'EA Nord', 't1'],
        [1, 'TLF', '', 't2'],
        [2, 'ELW', ' EA Süd ', 't11'],
        [2, 'RW', 'EA Ost', 't12'],
        [2, 'DLK', 'EA Süd', 't13'],
      ] as const) unit.run(inc, name, section, at, at);
      legacy.pragma(`user_version = ${SCHEMA_VERSION - 3}`);
      legacy.close();

      const db = openDb(dir);
      expect(db.prepare('SELECT incident_id, number, name, created_by FROM damage_accounts ORDER BY id').all()).toEqual([
        { incident_id: 1, number: 1, name: 'EA Nord', created_by: 'System' },
        { incident_id: 2, number: 1, name: 'EA Süd', created_by: 'System' },
        { incident_id: 2, number: 2, name: 'EA Ost', created_by: 'System' },
      ]);
      expect(
        db.prepare('SELECT u.name, a.name AS account FROM units u LEFT JOIN damage_accounts a ON a.id = u.account_id ORDER BY u.id').all(),
      ).toEqual([
        { name: 'HLF', account: 'EA Nord' },
        { name: 'TLF', account: null },
        { name: 'ELW', account: 'EA Süd' },
        { name: 'RW', account: 'EA Ost' },
        { name: 'DLK', account: 'EA Süd' },
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
