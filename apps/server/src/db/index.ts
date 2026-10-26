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
  // Kameras (Einstellungen) und im Einsatz gespeicherte Kamerapositionen
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
  // Kartenobjekte je Einsatz (übernommene Suchtreffer, Ausbreitungen); data = JSON je Art
  `
  CREATE TABLE map_objects (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX map_objects_incident ON map_objects(incident_id);
  `,
  // Eigene Farbe je Kartenobjekt (NULL = Vorgabe der Objektart)
  `ALTER TABLE map_objects ADD COLUMN color TEXT;`,
  // Eigenes Fahrzeug auf der Karte des Einsatzes ein-/ausblenden (Objektliste)
  `ALTER TABLE incidents ADD COLUMN vehicle_visible INTEGER NOT NULL DEFAULT 1;`,
  // Szenen schützen (nur Admins): geschützte lassen sich weder überschreiben noch löschen
  `ALTER TABLE display_scenes ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;`,
  // OpenWrt-Accesspoints für Betriebs-WLAN und Gastnetz (Einstellungen)
  `
  CREATE TABLE wifi_aps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    protocol TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    verify_tls INTEGER NOT NULL,
    ops_network TEXT NOT NULL,
    guest_network TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    sort INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // Am WLAN angemeldete Geräte, alle 10 s von den APs abgefragt (nur der aktuelle Stand, kein Verlauf)
  `
  CREATE TABLE wifi_clients (
    ap_id TEXT NOT NULL REFERENCES wifi_aps(id) ON DELETE CASCADE,
    mac TEXT NOT NULL,
    network TEXT NOT NULL,
    ssid TEXT NOT NULL,
    band TEXT,
    name TEXT,
    ip TEXT,
    signal_dbm INTEGER,
    rx_rate_kbps INTEGER,
    tx_rate_kbps INTEGER,
    connected_sec INTEGER,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (ap_id, mac, network)
  );
  `,
  // Dokumente: virtuelle Ordner je Einsatz, Vorlagenbaum, Bearbeitung über WOPI (Collabora)
  `
  CREATE TABLE document_folders (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    parent_id INTEGER REFERENCES document_folders(id),
    name TEXT NOT NULL,
    system INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX document_folders_name ON document_folders(incident_id, COALESCE(parent_id, 0), name COLLATE NOCASE);

  ALTER TABLE documents ADD COLUMN folder_id INTEGER REFERENCES document_folders(id);
  ALTER TABLE documents ADD COLUMN template_id INTEGER;
  ALTER TABLE documents ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE documents ADD COLUMN created_by_user INTEGER;
  ALTER TABLE documents ADD COLUMN updated_at TEXT;
  ALTER TABLE documents ADD COLUMN updated_by TEXT;
  ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  UPDATE documents SET updated_at = uploaded_at, updated_by = uploaded_by;

  CREATE TABLE template_folders (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES template_folders(id),
    name TEXT NOT NULL
  );
  CREATE UNIQUE INDEX template_folders_name ON template_folders(COALESCE(parent_id, 0), name COLLATE NOCASE);

  CREATE TABLE templates (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER REFERENCES template_folders(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    storage_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    target_path TEXT NOT NULL DEFAULT '',
    filename_pattern TEXT NOT NULL DEFAULT '',
    fill_content INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE wopi_tokens (
    token_hash TEXT PRIMARY KEY,
    file_ref TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    can_write INTEGER NOT NULL,
    -- Adresse von ELVIS im Browser: Ziel für postMessage aus dem Editor
    origin TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // Laufender Einsatz bekommt die Standard-Ordnerstruktur (neue Einsätze erhalten sie beim Eröffnen)
  (db) => {
    const active = db.prepare('SELECT id FROM incidents WHERE closed_at IS NULL').get() as { id: number } | undefined;
    if (!active) return;
    const insert = db.prepare("INSERT INTO document_folders (incident_id, name, system, created_by, created_at) VALUES (?, ?, 1, 'System', ?)");
    for (const name of ['Lagemeldungen', 'Befehle', 'Protokolle', 'Pläne', 'Fotos', 'Sonstiges']) insert.run(active.id, name, new Date().toISOString());
  },
  // Rollen (Admins pflegen sie, Sitzungen übernehmen sie) und Aufgaben je Einsatz samt Vorlagen
  `
  CREATE TABLE roles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX roles_name ON roles(name COLLATE NOCASE);

  ALTER TABLE sessions ADD COLUMN role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;
  -- 0 direkt nach der Anmeldung: die Oberfläche fragt nach der Rolle
  ALTER TABLE sessions ADD COLUMN role_chosen INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    summary TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    document_template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    -- beide NULL = alle Benutzer
    assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assignee_role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    -- NULL = einmalig
    interval_minutes INTEGER,
    due_at TEXT,
    snoozed_until TEXT,
    done_at TEXT,
    done_by TEXT,
    last_done_at TEXT,
    last_done_by TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_incident ON tasks(incident_id);

  CREATE TABLE task_templates (
    id INTEGER PRIMARY KEY,
    summary TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    document_template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    interval_minutes INTEGER,
    -- Minuten nach Einsatzbeginn; NULL = ohne Termin (nur einmalige)
    offset_minutes INTEGER,
    sort INTEGER NOT NULL
  );
  `,
  // Druckserver: Aufträge an die Drucker der Addons (CUPS), auch von anonymen Arbeitsplätzen
  `
  CREATE TABLE print_jobs (
    ref TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    printer TEXT NOT NULL,
    printer_name TEXT NOT NULL,
    ipp_job_id INTEGER,
    filename TEXT NOT NULL,
    copies INTEGER NOT NULL,
    options TEXT NOT NULL,
    state TEXT NOT NULL,
    state_message TEXT NOT NULL DEFAULT '',
    submitted_by TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    archived_path TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX print_jobs_created ON print_jobs(created_at);
  `,
  // Scan-Eingang: per „Scan an E-Mail“ empfangene PDFs
  `
  CREATE TABLE scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sender TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    source_ip TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL,
    incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    archived_path TEXT,
    assigned_by TEXT,
    assigned_at TEXT,
    message TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX scans_received ON scans(received_at);
  `,
  // Kräfteverwaltung: Systemeinheiten (Fahrzeug, Zug, Verband) mit Untereinheiten; Kräfte im Einsatz als Baum
  // mit eigenem Status statt FMS, taktischem Zeichen und Kartenposition
  `
  CREATE TABLE force_units (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    callsign TEXT NOT NULL DEFAULT '',
    organization TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    sign TEXT NOT NULL,
    leaders INTEGER NOT NULL DEFAULT 0,
    sub_leaders INTEGER NOT NULL DEFAULT 0,
    crew INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE force_unit_members (
    parent_id INTEGER NOT NULL REFERENCES force_units(id) ON DELETE CASCADE,
    child_id INTEGER NOT NULL REFERENCES force_units(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL,
    PRIMARY KEY (parent_id, child_id)
  );
  CREATE INDEX force_unit_members_child ON force_unit_members(child_id);

  CREATE TABLE units_new (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    parent_id INTEGER REFERENCES units_new(id),
    role TEXT NOT NULL DEFAULT '',
    source_id INTEGER REFERENCES force_units(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    callsign TEXT NOT NULL DEFAULT '',
    organization TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    sign TEXT NOT NULL,
    leaders INTEGER NOT NULL DEFAULT 0,
    sub_leaders INTEGER NOT NULL DEFAULT 0,
    crew INTEGER NOT NULL DEFAULT 0,
    section TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    lat REAL,
    lon REAL,
    map_visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    arrived_at TEXT,
    released_at TEXT,
    updated_at TEXT NOT NULL
  );
  -- Bisherige Einheiten: Funkrufname wird Name, Fahrzeugtyp Text im Zeichen, FMS entfällt
  INSERT INTO units_new (id, incident_id, name, organization, notes, sign, leaders, sub_leaders, crew, section, status,
                         created_at, arrived_at, released_at, updated_at)
    SELECT id, incident_id, callsign, organization, notes, json_object('text', substr(unit_type, 1, 12)), leaders, sub_leaders, crew,
           section, CASE WHEN released_at IS NULL THEN 'eingetroffen' ELSE 'entlassen' END, arrived_at, arrived_at, released_at, updated_at
    FROM units;
  DROP TABLE units;
  ALTER TABLE units_new RENAME TO units;
  CREATE INDEX units_incident ON units(incident_id);
  `,
  // Monitoring: Abfrageziele (SNMP, Node Exporter); Schwellen und eigene Prüfungen als JSON
  `
  CREATE TABLE monitoring_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    snmp_version TEXT NOT NULL DEFAULT '2c',
    community TEXT NOT NULL DEFAULT '',
    always_on INTEGER NOT NULL DEFAULT 1,
    limits TEXT NOT NULL,
    checks TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // Gastdrucker: Aufträge aus dem Gastnetz, die auf Freigabe warten (PDF im Datenverzeichnis)
  `
  CREATE TABLE guest_print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    copies INTEGER NOT NULL DEFAULT 1,
    submitted_by TEXT NOT NULL,
    source_ip TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE INDEX guest_print_jobs_received ON guest_print_jobs(received_at);
  `,
  // Arbeitsplätze: per PXE installierte Notebooks mit Gerätetoken (nur der Hash)
  `
  CREATE TABLE workstations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    mac TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    enrolled_at TEXT NOT NULL,
    last_seen_at TEXT,
    last_user TEXT,
    version TEXT NOT NULL DEFAULT ''
  );
  `,
  // Updates der Arbeitsplätze: letzter Auftrag mit Stand und Protokoll (JSON)
  `ALTER TABLE workstations ADD COLUMN update_json TEXT;`,
  // Bluetooth-Geräte (z. B. Victron-Batterien), deren Werbepakete das Modul „Bluetooth“ mitliest
  `
  CREATE TABLE bluetooth_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    address TEXT NOT NULL,
    key TEXT NOT NULL DEFAULT '',
    warn_below_v REAL,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // Farbschema je Bildschirm (Kachel „Szenenwahl“)
  (db) => {
    const columns = db.prepare('PRAGMA table_info(displays)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'theme')) db.exec("ALTER TABLE displays ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'");
  },
  // Bilder für die Kachel „Bild“ (Datei unter display-images/<id>)
  `
  CREATE TABLE display_images (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );
  `,
  // App-Anbindung: Herkunft der Einheitenposition und gekoppelte Apps (über das Cloud-Relay)
  `
  ALTER TABLE units ADD COLUMN position_source TEXT;
  ALTER TABLE units ADD COLUMN position_at TEXT;
  ALTER TABLE units ADD COLUMN position_accuracy_m REAL;
  UPDATE units SET position_source = 'manual', position_at = updated_at WHERE lat IS NOT NULL;
  CREATE TABLE app_links (
    id INTEGER PRIMARY KEY,
    unit_id INTEGER NOT NULL REFERENCES units(id),
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    device_id TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    paired_by TEXT NOT NULL,
    ended_at TEXT,
    relay_pending INTEGER NOT NULL DEFAULT 0,
    last_position_at TEXT,
    accuracy_m REAL,
    battery REAL
  );
  CREATE INDEX app_links_active ON app_links (device_id) WHERE ended_at IS NULL;
  `,
  // Personal der Einheiten; Personalbögen aus dem Online-Formular (über das Relay) im Eingang
  `
  CREATE TABLE personnel_forms (
    id TEXT PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    url TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    closed_at TEXT,
    relay_pending INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE personnel_sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id TEXT,
    incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
    unit_label TEXT NOT NULL,
    persons TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    read_at TEXT,
    unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    assigned_at TEXT,
    assigned_by TEXT
  );
  CREATE INDEX personnel_sheets_received ON personnel_sheets(received_at);
  CREATE TABLE personnel (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    sheet_id INTEGER REFERENCES personnel_sheets(id) ON DELETE SET NULL,
    last_name TEXT NOT NULL,
    first_name TEXT NOT NULL,
    birth_date TEXT NOT NULL DEFAULT '',
    grade TEXT NOT NULL,
    function TEXT NOT NULL DEFAULT '',
    qualifications TEXT NOT NULL DEFAULT '[]',
    organization TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    employer TEXT NOT NULL DEFAULT '',
    emergency_contact TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX personnel_unit ON personnel(unit_id);
  `,
  // Mehrere Rollen je Sitzung (sessions.role_id bleibt ungenutzt stehen – Spalten mit Fremdschlüssel lassen sich nicht entfernen)
  `
  CREATE TABLE session_roles (
    token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (token_hash, role_id)
  );
  INSERT INTO session_roles (token_hash, role_id) SELECT token_hash, role_id FROM sessions WHERE role_id IS NOT NULL;
  `,
  // Meldungen zwischen Stab und Fernmeldern; *_text hält den Anzeigenamen fest, auch wenn Rolle oder Kraft wegfällt
  `
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
    body TEXT NOT NULL,
    sender_role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    sender_unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    sender_text TEXT NOT NULL,
    recipient_role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    recipient_unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    -- NULL = Eingang wartet auf Verteilung
    recipient_text TEXT,
    claimed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    claimed_by TEXT,
    claimed_at TEXT,
    remind_at TEXT,
    reply TEXT,
    replied_at TEXT,
    replied_by TEXT,
    done_at TEXT,
    done_by TEXT,
    ack_at TEXT,
    ack_by TEXT,
    reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX messages_incident ON messages(incident_id);
  `,
  // Kopien von Meldungen an Rollen (z. B. S2 bekommt alle Eingangsmeldungen)
  `
  CREATE TABLE message_copies (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    role_name TEXT NOT NULL,
    ack_at TEXT,
    ack_by TEXT,
    PRIMARY KEY (message_id, role_id)
  );
  `,
  // Verschieben („in 5 min erinnern“) bleibt an der Meldung vermerkt
  `
  ALTER TABLE messages ADD COLUMN snooze_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN snoozed_at TEXT;
  ALTER TABLE messages ADD COLUMN snoozed_by TEXT;
  ALTER TABLE messages ADD COLUMN snooze_minutes INTEGER;
  `,
  // Im Einsatz gespeicherte Overpass-Abfragen der Karte (query = OverpassQuery als JSON)
  `
  CREATE TABLE incident_overpass_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX incident_overpass_queries_incident ON incident_overpass_queries(incident_id);
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
