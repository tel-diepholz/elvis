import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Db = Database.Database;

type Migration = string | ((db: Db) => void);

/** Ordered migrations; index + 1 is stored in PRAGMA user_version. Never edit an applied one. */
const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE incidents (
    id INTEGER PRIMARY KEY,
    keyword TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    leader TEXT NOT NULL DEFAULT '',
    lat REAL,
    lon REAL,
    started_at TEXT NOT NULL,
    closed_at TEXT
  );
  -- At most one open incident at a time.
  CREATE UNIQUE INDEX incidents_one_active ON incidents((1)) WHERE closed_at IS NULL;

  CREATE TABLE journal (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    timestamp TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT '',
    recipient TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL,
    important INTEGER NOT NULL DEFAULT 0,
    corrects_id INTEGER REFERENCES journal(id)
  );
  CREATE INDEX journal_incident ON journal(incident_id, timestamp);
  CREATE TRIGGER journal_immutable_update BEFORE UPDATE ON journal
    BEGIN SELECT RAISE(ABORT, 'Einsatztagebuch ist unveränderlich'); END;
  CREATE TRIGGER journal_immutable_delete BEFORE DELETE ON journal
    BEGIN SELECT RAISE(ABORT, 'Einsatztagebuch ist unveränderlich'); END;

  CREATE TABLE units (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    callsign TEXT NOT NULL,
    unit_type TEXT NOT NULL DEFAULT '',
    organization TEXT NOT NULL DEFAULT '',
    leaders INTEGER NOT NULL DEFAULT 0,
    sub_leaders INTEGER NOT NULL DEFAULT 0,
    crew INTEGER NOT NULL DEFAULT 0,
    section TEXT NOT NULL DEFAULT '',
    fms_status INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    arrived_at TEXT NOT NULL,
    released_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX units_incident ON units(incident_id);

  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    filename TEXT NOT NULL,
    storage_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
  );
  CREATE INDEX documents_incident ON documents(incident_id);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    operator TEXT NOT NULL,
    target TEXT NOT NULL,
    action TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '',
    success INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT ''
  );
  `,
  `
  CREATE TABLE docker_hosts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL,
    port INTEGER NOT NULL,
    cert_mode TEXT NOT NULL DEFAULT 'elvis',
    cert_expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );

  CREATE TABLE addons (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    host_id INTEGER NOT NULL REFERENCES docker_hosts(id),
    version TEXT NOT NULL,
    -- Manifest der installierten Version: Neukonfiguration und Abgleich hängen nicht vom aktuellen Repo-Stand ab.
    manifest TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    error TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE UNIQUE INDEX users_name ON users(lower(first_name), lower(last_name));

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  `,
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  `,
  // v2 wurde nachträglich um addons.manifest erweitert; Datenbanken, die v2 vorher angewendet hatten,
  // fehlt die Spalte. Dort gab es keine Addon-Zeilen (jede Installation scheiterte beim Speichern).
  (db) => {
    const columns = db.prepare('PRAGMA table_info(addons)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'manifest')) db.exec("ALTER TABLE addons ADD COLUMN manifest TEXT NOT NULL DEFAULT '{}'");
  },
  `
  CREATE TABLE addon_job_runs (
    id INTEGER PRIMARY KEY,
    addon_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    exit_code INTEGER,
    triggered_by TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX addon_job_runs_job ON addon_job_runs(addon_id, job_id, started_at);
  `,
  // Ergebnis je Schritt, damit nach einem Fehler sichtbar bleibt, wo der Lauf abgebrochen ist
  `ALTER TABLE addon_job_runs ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';`,
  // Kameras (Systemeinstellungen) und im Einsatz gespeicherte Kamerapositionen
  `
  CREATE TABLE cameras (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    host TEXT NOT NULL,
    protocol TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    verify_tls INTEGER NOT NULL,
    resolution TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    sort INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE camera_presets (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    camera_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE INDEX camera_presets_incident ON camera_presets(incident_id, camera_id);
  `,
  // Gekoppelte Bildschirme (Kiosk-Browser/App) mit ihrem Kachel-Layout
  `
  CREATE TABLE displays (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    layout TEXT NOT NULL,
    screen TEXT,
    user_agent TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL,
    paired_at TEXT NOT NULL,
    last_seen_at TEXT
  );
  `,
  // Szenen je Bildschirm (gespeicherte Anordnungen)
  `
  CREATE TABLE display_scenes (
    id INTEGER PRIMARY KEY,
    display_id TEXT NOT NULL REFERENCES displays(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    layout TEXT NOT NULL,
    sort INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE INDEX display_scenes_display ON display_scenes(display_id, sort);
  `,
];

/** Aktuelle Schemaversion (Anzahl der Migrationen). */
export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(dataDir: string | ':memory:'): Db {
  let db: Db;
  if (dataDir === ':memory:') {
    db = new Database(':memory:');
  } else {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, 'elvis.sqlite'));
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      const m = MIGRATIONS[v]!;
      if (typeof m === 'string') db.exec(m);
      else m(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
