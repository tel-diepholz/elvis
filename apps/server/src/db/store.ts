import type {
  AuditEntry,
  DocumentFolder,
  Incident,
  IncidentDocument,
  IncidentPatch,
  JournalCategory,
  JournalEntry,
  MapHistoryState,
  MapObject,
  IncidentOverpassQuery,
  OverpassQuery,
  NewIncident,
  NewJournalEntry,
  Unit,
  UnitStatus,
} from '@elvis/shared';
import { MAP_LABELS, tacticalSignSchema } from '@elvis/shared';
import type { Db } from './index.js';

type Row = Record<string, unknown>;

const toIncident = (r: Row): Incident => ({
  id: r.id as number,
  keyword: r.keyword as string,
  title: r.title as string,
  location: r.location as string,
  leader: r.leader as string,
  lat: (r.lat as number | null) ?? null,
  lon: (r.lon as number | null) ?? null,
  vehicleVisible: r.vehicle_visible !== 0,
  startedAt: r.started_at as string,
  closedAt: (r.closed_at as string | null) ?? null,
});

const toJournal = (r: Row): JournalEntry => ({
  id: r.id as number,
  incidentId: r.incident_id as number,
  timestamp: r.timestamp as string,
  recordedAt: r.recorded_at as string,
  category: r.category as JournalCategory,
  text: r.text as string,
  sender: r.sender as string,
  recipient: r.recipient as string,
  author: r.author as string,
  important: r.important === 1,
  correctsId: (r.corrects_id as number | null) ?? null,
});

const toUnit = (r: Row): Unit => ({
  id: r.id as number,
  incidentId: r.incident_id as number,
  parentId: (r.parent_id as number | null) ?? null,
  role: r.role as string,
  sourceId: (r.source_id as number | null) ?? null,
  name: r.name as string,
  callsign: r.callsign as string,
  organization: r.organization as string,
  notes: r.notes as string,
  sign: tacticalSignSchema.parse(JSON.parse(r.sign as string)),
  strength: { leaders: r.leaders as number, subLeaders: r.sub_leaders as number, crew: r.crew as number },
  section: r.section as string,
  status: r.status as UnitStatus,
  lat: (r.lat as number | null) ?? null,
  lon: (r.lon as number | null) ?? null,
  positionSource: (r.position_source as Unit['positionSource']) ?? null,
  positionAt: (r.position_at as string | null) ?? null,
  positionAccuracyM: (r.position_accuracy_m as number | null) ?? null,
  mapVisible: r.map_visible !== 0,
  createdAt: r.created_at as string,
  arrivedAt: (r.arrived_at as string | null) ?? null,
  releasedAt: (r.released_at as string | null) ?? null,
  updatedAt: r.updated_at as string,
});

const unitParams = (u: Omit<Unit, 'id' | 'incidentId' | 'createdAt' | 'updatedAt'>) => ({
  parentId: u.parentId,
  role: u.role,
  sourceId: u.sourceId,
  name: u.name,
  callsign: u.callsign,
  organization: u.organization,
  notes: u.notes,
  sign: JSON.stringify(u.sign),
  leaders: u.strength.leaders,
  subLeaders: u.strength.subLeaders,
  crew: u.strength.crew,
  section: u.section,
  status: u.status,
  lat: u.lat,
  lon: u.lon,
  positionSource: u.positionSource,
  positionAt: u.positionAt,
  positionAccuracyM: u.positionAccuracyM,
  mapVisible: u.mapVisible ? 1 : 0,
  arrivedAt: u.arrivedAt,
  releasedAt: u.releasedAt,
});

const toMapObject = (r: Row): MapObject =>
  ({
    id: r.id as number,
    incidentId: r.incident_id as number,
    kind: r.kind,
    name: r.name as string,
    lat: r.lat as number,
    lon: r.lon as number,
    visible: r.visible === 1,
    label: MAP_LABELS[r.label as number] ?? 'off',
    color: (r.color as string | null) ?? null,
    data: JSON.parse(r.data as string),
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
  }) as MapObject;

const toOverpassQuery = (r: Row): IncidentOverpassQuery => ({
  ...(JSON.parse(r.query as string) as OverpassQuery),
  name: r.name as string,
  id: r.id as number,
  incidentId: r.incident_id as number,
  createdAt: r.created_at as string,
  createdBy: r.created_by as string,
});

const toDocument = (r: Row): IncidentDocument & { storageName: string } => ({
  id: r.id as number,
  incidentId: r.incident_id as number,
  folderId: (r.folder_id as number | null) ?? null,
  filename: r.filename as string,
  storageName: r.storage_name as string,
  mimeType: r.mime_type as string,
  sizeBytes: r.size_bytes as number,
  description: r.description as string,
  uploadedBy: r.uploaded_by as string,
  uploadedAt: r.uploaded_at as string,
  templateId: (r.template_id as number | null) ?? null,
  draft: r.draft === 1,
  createdByUserId: (r.created_by_user as number | null) ?? null,
  updatedAt: (r.updated_at as string | null) ?? (r.uploaded_at as string),
  updatedBy: (r.updated_by as string | null) ?? (r.uploaded_by as string),
  version: r.version as number,
});

const toFolder = (r: Row): DocumentFolder => ({
  id: r.id as number,
  incidentId: r.incident_id as number,
  parentId: (r.parent_id as number | null) ?? null,
  name: r.name as string,
  system: r.system === 1,
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
});

const toAudit = (r: Row): AuditEntry => ({
  id: r.id as number,
  timestamp: r.timestamp as string,
  operator: r.operator as string,
  target: r.target as string,
  action: r.action as string,
  params: r.params as string,
  success: r.success === 1,
  message: r.message as string,
});

const now = () => new Date().toISOString();

type HistorySubject = 'object' | 'unit' | 'incident';
/** Felder einer Kraft, die die Karte zeigt – nur ihre Änderungen kommen in den Verlauf */
const unitMapState = (u: Unit) => ({
  name: u.name,
  sign: u.sign,
  parentId: u.parentId,
  status: u.status,
  lat: u.lat,
  lon: u.lon,
  mapVisible: u.mapVisible,
  positionSource: u.positionSource,
  positionAt: u.positionAt,
  positionAccuracyM: u.positionAccuracyM,
});
const incidentMapState = (i: Incident): MapHistoryState['incident'] => ({ lat: i.lat, lon: i.lon, vehicleVisible: i.vehicleVisible });
/** Verfolgte Ziele melden alle 10 s eine Position; in den Verlauf kommt höchstens alle 30 s ein Stand */
const TRACKED_HISTORY_MS = 30_000;

/** Thin persistence layer; business rules live in the services. */
export class Store {
  constructor(readonly db: Db) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- Verlauf der Lage (Zeitstrahl) ---

  private lastHistory(subject: HistorySubject, id: number): { at: string; state: string | null } | null {
    return (this.db.prepare('SELECT at, state FROM map_history WHERE subject = ? AND subject_id = ? ORDER BY id DESC LIMIT 1').get(subject, id) as { at: string; state: string | null } | undefined) ?? null;
  }

  /** Schnappschuss festhalten, wenn er sich vom letzten unterscheidet; state null = entfernt */
  private recordHistory(incidentId: number, subject: HistorySubject, id: number, state: unknown, minGapMs = 0): void {
    const json = state === null ? null : JSON.stringify(state);
    const last = this.lastHistory(subject, id);
    if (last && last.state === json) return;
    const at = now();
    if (last && minGapMs && Date.parse(at) - Date.parse(last.at) < minGapMs) return;
    this.db.prepare('INSERT INTO map_history (incident_id, at, subject, subject_id, state) VALUES (?, ?, ?, ?, ?)').run(incidentId, at, subject, id, json);
  }

  private recordObject(o: MapObject): void {
    // Verfolgte Ziele gedrosselt – außer Name, Sichtbarkeit, Beschriftung oder Farbe ändern sich
    const throttle = (o.kind === 'aircraft' || o.kind === 'ship') && this.sameLook(o) ? TRACKED_HISTORY_MS : 0;
    this.recordHistory(o.incidentId, 'object', o.id, o, throttle);
  }

  private sameLook(o: MapObject): boolean {
    const last = this.lastHistory('object', o.id);
    if (!last?.state) return false;
    const before = JSON.parse(last.state) as MapObject;
    return before.name === o.name && before.visible === o.visible && before.label === o.label && before.color === o.color;
  }

  /**
   * Lage zu einem Zeitpunkt: je Objekt, Kraft und Einsatzort der letzte Stand bis dahin. Was schon vor dem Verlauf
   * bestand (ältere Einsätze), erscheint ab seiner Anlage mit dem frühesten bekannten Stand.
   */
  mapHistory(incidentId: number, at: string): MapHistoryState {
    const rows = this.db
      .prepare(
        `SELECT h.subject, h.subject_id, h.state FROM map_history h
         JOIN (SELECT MAX(id) AS id FROM map_history WHERE incident_id = ? AND at <= ? GROUP BY subject, subject_id) m ON m.id = h.id`,
      )
      .all(incidentId, at) as { subject: HistorySubject; subject_id: number; state: string | null }[];
    const known = new Map(rows.map((r) => [`${r.subject}:${r.subject_id}`, r.state]));
    const earliest = (subject: HistorySubject, id: number) =>
      (this.db.prepare('SELECT state FROM map_history WHERE subject = ? AND subject_id = ? ORDER BY id LIMIT 1').get(subject, id) as { state: string | null } | undefined)?.state;
    const stateOf = <T>(subject: HistorySubject, id: number, createdAt: string, current: T): T | null => {
      const key = `${subject}:${id}`;
      if (known.has(key)) return known.get(key) ? (JSON.parse(known.get(key)!) as T) : null;
      if (createdAt > at) return null;
      const first = earliest(subject, id);
      return first ? (JSON.parse(first) as T) : current;
    };

    // Entfernte Objekte gibt es nur noch im Verlauf
    const objects = rows.filter((r) => r.subject === 'object' && r.state).map((r) => JSON.parse(r.state!) as MapObject);
    for (const o of this.mapObjects(incidentId)) {
      if (known.has(`object:${o.id}`)) continue;
      const s = stateOf('object', o.id, o.createdAt, o);
      if (s) objects.push(s);
    }
    objects.sort((a, b) => a.id - b.id);

    const units = this.units(incidentId).flatMap((u) => {
      const s = stateOf('unit', u.id, u.createdAt, unitMapState(u));
      return s ? [{ ...u, ...s }] : [];
    });
    const incident = this.incident(incidentId)!;
    return { at, incident: stateOf('incident', incidentId, '', incidentMapState(incident)) ?? incidentMapState(incident), objects, units };
  }

  // --- Einsätze ---

  activeIncident(): Incident | null {
    const r = this.db.prepare('SELECT * FROM incidents WHERE closed_at IS NULL').get() as Row | undefined;
    return r ? toIncident(r) : null;
  }

  incident(id: number): Incident | null {
    const r = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as Row | undefined;
    return r ? toIncident(r) : null;
  }

  incidents(): Incident[] {
    return (this.db.prepare('SELECT * FROM incidents ORDER BY started_at DESC').all() as Row[]).map(toIncident);
  }

  createIncident(input: NewIncident): Incident {
    const info = this.db
      .prepare(
        `INSERT INTO incidents (keyword, title, location, leader, lat, lon, started_at)
         VALUES (@keyword, @title, @location, @leader, @lat, @lon, @startedAt)`,
      )
      .run({
        keyword: input.keyword ?? '',
        title: input.title,
        location: input.location ?? '',
        leader: input.leader ?? '',
        lat: input.lat ?? null,
        lon: input.lon ?? null,
        startedAt: now(),
      });
    const created = this.incident(Number(info.lastInsertRowid))!;
    this.recordHistory(created.id, 'incident', created.id, incidentMapState(created));
    return created;
  }

  updateIncident(id: number, patch: IncidentPatch): Incident {
    const current = this.incident(id)!;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        'UPDATE incidents SET keyword=@keyword, title=@title, location=@location, leader=@leader, lat=@lat, lon=@lon, vehicle_visible=@vehicleVisible WHERE id=@id',
      )
      .run({
        id,
        keyword: next.keyword,
        title: next.title,
        location: next.location,
        leader: next.leader,
        lat: next.lat ?? null,
        lon: next.lon ?? null,
        vehicleVisible: next.vehicleVisible ? 1 : 0,
      });
    const updated = this.incident(id)!;
    this.recordHistory(id, 'incident', id, incidentMapState(updated));
    return updated;
  }

  closeIncident(id: number): Incident {
    this.db.prepare('UPDATE incidents SET closed_at = ? WHERE id = ?').run(now(), id);
    return this.incident(id)!;
  }

  // --- Einsatztagebuch ---

  journal(incidentId: number): JournalEntry[] {
    return (
      this.db.prepare('SELECT * FROM journal WHERE incident_id = ? ORDER BY timestamp ASC, id ASC').all(incidentId) as Row[]
    ).map(toJournal);
  }

  journalEntry(id: number): JournalEntry | null {
    const r = this.db.prepare('SELECT * FROM journal WHERE id = ?').get(id) as Row | undefined;
    return r ? toJournal(r) : null;
  }

  addJournal(incidentId: number, entry: NewJournalEntry, author: string): JournalEntry {
    const recordedAt = now();
    const info = this.db
      .prepare(
        `INSERT INTO journal (incident_id, timestamp, recorded_at, category, text, sender, recipient, author, important, corrects_id)
         VALUES (@incidentId, @timestamp, @recordedAt, @category, @text, @sender, @recipient, @author, @important, @correctsId)`,
      )
      .run({
        incidentId,
        timestamp: entry.timestamp ?? recordedAt,
        recordedAt,
        category: entry.category,
        text: entry.text,
        sender: entry.sender ?? '',
        recipient: entry.recipient ?? '',
        author,
        important: entry.important ? 1 : 0,
        correctsId: entry.correctsId ?? null,
      });
    return this.journalEntry(Number(info.lastInsertRowid))!;
  }

  // --- Kräfte ---

  units(incidentId: number): Unit[] {
    return (this.db.prepare('SELECT * FROM units WHERE incident_id = ? ORDER BY id').all(incidentId) as Row[]).map(toUnit);
  }

  unit(id: number): Unit | null {
    const r = this.db.prepare('SELECT * FROM units WHERE id = ?').get(id) as Row | undefined;
    return r ? toUnit(r) : null;
  }

  addUnit(u: Omit<Unit, 'id' | 'createdAt' | 'updatedAt'>): Unit {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO units (incident_id, parent_id, role, source_id, name, callsign, organization, notes, sign, leaders, sub_leaders, crew,
           section, status, lat, lon, position_source, position_at, position_accuracy_m, map_visible, created_at, arrived_at, released_at, updated_at)
         VALUES (@incidentId, @parentId, @role, @sourceId, @name, @callsign, @organization, @notes, @sign, @leaders, @subLeaders, @crew,
           @section, @status, @lat, @lon, @positionSource, @positionAt, @positionAccuracyM, @mapVisible, @ts, @arrivedAt, @releasedAt, @ts)`,
      )
      .run({ ...unitParams(u), incidentId: u.incidentId, ts });
    const created = this.unit(Number(info.lastInsertRowid))!;
    this.recordHistory(created.incidentId, 'unit', created.id, unitMapState(created));
    return created;
  }

  saveUnit(u: Unit): Unit {
    this.db
      .prepare(
        `UPDATE units SET parent_id=@parentId, role=@role, source_id=@sourceId, name=@name, callsign=@callsign, organization=@organization,
         notes=@notes, sign=@sign, leaders=@leaders, sub_leaders=@subLeaders, crew=@crew, section=@section, status=@status, lat=@lat,
         lon=@lon, position_source=@positionSource, position_at=@positionAt, position_accuracy_m=@positionAccuracyM, map_visible=@mapVisible, arrived_at=@arrivedAt, released_at=@releasedAt, updated_at=@ts WHERE id=@id`,
      )
      .run({ ...unitParams(u), id: u.id, ts: now() });
    const saved = this.unit(u.id)!;
    this.recordHistory(saved.incidentId, 'unit', saved.id, unitMapState(saved));
    return saved;
  }

  // --- Kartenobjekte ---

  mapObjects(incidentId: number): MapObject[] {
    return (this.db.prepare('SELECT * FROM map_objects WHERE incident_id = ? ORDER BY id').all(incidentId) as Row[]).map(toMapObject);
  }

  mapObject(id: number): MapObject | null {
    const r = this.db.prepare('SELECT * FROM map_objects WHERE id = ?').get(id) as Row | undefined;
    return r ? toMapObject(r) : null;
  }

  addMapObject(incidentId: number, o: Pick<MapObject, 'kind' | 'name' | 'lat' | 'lon' | 'data'> & { color?: string | null }, author: string): MapObject {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO map_objects (incident_id, kind, name, lat, lon, visible, color, data, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(incidentId, o.kind, o.name, o.lat, o.lon, o.color ?? null, JSON.stringify(o.data), ts, author, ts);
    const created = this.mapObject(Number(info.lastInsertRowid))!;
    this.recordObject(created);
    return created;
  }

  saveMapObject(o: MapObject): MapObject {
    this.db
      .prepare('UPDATE map_objects SET name = ?, lat = ?, lon = ?, visible = ?, label = ?, color = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(o.name, o.lat, o.lon, o.visible ? 1 : 0, MAP_LABELS.indexOf(o.label), o.color, JSON.stringify(o.data), now(), o.id);
    const saved = this.mapObject(o.id)!;
    this.recordObject(saved);
    return saved;
  }

  removeMapObject(id: number): void {
    const before = this.mapObject(id);
    this.db.prepare('DELETE FROM map_objects WHERE id = ?').run(id);
    if (before) this.recordHistory(before.incidentId, 'object', id, null);
  }

  // --- Overpass-Abfragen ---

  overpassQueries(incidentId: number): IncidentOverpassQuery[] {
    return (this.db.prepare('SELECT * FROM incident_overpass_queries WHERE incident_id = ? ORDER BY name COLLATE NOCASE, id').all(incidentId) as Row[]).map(toOverpassQuery);
  }

  overpassQuery(id: number): IncidentOverpassQuery | null {
    const r = this.db.prepare('SELECT * FROM incident_overpass_queries WHERE id = ?').get(id) as Row | undefined;
    return r ? toOverpassQuery(r) : null;
  }

  addOverpassQuery(incidentId: number, q: OverpassQuery, author: string): IncidentOverpassQuery {
    const ts = now();
    const info = this.db
      .prepare('INSERT INTO incident_overpass_queries (incident_id, name, query, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(incidentId, q.name, JSON.stringify(q), ts, author, ts);
    return this.overpassQuery(Number(info.lastInsertRowid))!;
  }

  saveOverpassQuery(id: number, q: OverpassQuery): IncidentOverpassQuery {
    this.db.prepare('UPDATE incident_overpass_queries SET name = ?, query = ?, updated_at = ? WHERE id = ?').run(q.name, JSON.stringify(q), now(), id);
    return this.overpassQuery(id)!;
  }

  removeOverpassQuery(id: number): void {
    this.db.prepare('DELETE FROM incident_overpass_queries WHERE id = ?').run(id);
  }

  // --- Dokumente ---

  /** Dokumente des Einsatzes; Entwürfe nur die des angegebenen Benutzers */
  documents(incidentId: number, viewerId: number | null = null): IncidentDocument[] {
    return (
      this.db
        .prepare('SELECT * FROM documents WHERE incident_id = ? AND (draft = 0 OR created_by_user = ?) ORDER BY filename COLLATE NOCASE')
        .all(incidentId, viewerId ?? -1) as Row[]
    ).map((r) => {
      const { storageName: _, ...doc } = toDocument(r);
      return doc;
    });
  }

  document(id: number): (IncidentDocument & { storageName: string }) | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Row | undefined;
    return r ? toDocument(r) : null;
  }

  /** Dokumente (ohne Entwürfe anderer) im Ordner – für die laufende Nummer */
  documentCount(incidentId: number, folderId: number | null): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE incident_id = ? AND folder_id IS ?').get(incidentId, folderId) as { n: number }
    ).n;
  }

  documentNameTaken(incidentId: number, folderId: number | null, filename: string, exceptId = 0): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM documents WHERE incident_id = ? AND folder_id IS ? AND filename = ? COLLATE NOCASE AND id != ?')
      .get(incidentId, folderId, filename, exceptId);
  }

  addDocument(
    d: Pick<IncidentDocument, 'incidentId' | 'folderId' | 'filename' | 'mimeType' | 'sizeBytes' | 'description' | 'uploadedBy'> &
      Partial<Pick<IncidentDocument, 'templateId' | 'draft' | 'createdByUserId'>> & { storageName: string },
  ): IncidentDocument {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO documents (incident_id, folder_id, filename, storage_name, mime_type, size_bytes, description, uploaded_by, uploaded_at,
                                template_id, draft, created_by_user, updated_at, updated_by)
         VALUES (@incidentId, @folderId, @filename, @storageName, @mimeType, @sizeBytes, @description, @uploadedBy, @ts,
                 @templateId, @draft, @createdByUserId, @ts, @uploadedBy)`,
      )
      .run({ templateId: null, createdByUserId: null, ...d, draft: d.draft ? 1 : 0, ts });
    const { storageName: _, ...doc } = this.document(Number(info.lastInsertRowid))!;
    return doc;
  }

  patchDocument(id: number, p: { folderId?: number | null; filename?: string; description?: string }): void {
    const doc = this.document(id)!;
    this.db
      .prepare('UPDATE documents SET folder_id = ?, filename = ?, description = ? WHERE id = ?')
      .run(p.folderId !== undefined ? p.folderId : doc.folderId, p.filename ?? doc.filename, p.description ?? doc.description, id);
  }

  /** Neuer Inhalt aus dem Office-Server; ein Entwurf wird damit zum regulären Dokument */
  savedDocument(id: number, sizeBytes: number, by: string): IncidentDocument {
    this.db.prepare('UPDATE documents SET size_bytes = ?, updated_at = ?, updated_by = ?, version = version + 1, draft = 0 WHERE id = ?').run(sizeBytes, now(), by, id);
    const { storageName: _, ...doc } = this.document(id)!;
    return doc;
  }

  /** Entwürfe, die vor `before` angelegt und nie gespeichert wurden */
  staleDrafts(before: string): (IncidentDocument & { storageName: string })[] {
    return (this.db.prepare('SELECT * FROM documents WHERE draft = 1 AND uploaded_at < ?').all(before) as Row[]).map(toDocument);
  }

  removeDocument(id: number): void {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }

  // --- Dokumentordner ---

  folders(incidentId: number): DocumentFolder[] {
    return (this.db.prepare('SELECT * FROM document_folders WHERE incident_id = ? ORDER BY name COLLATE NOCASE').all(incidentId) as Row[]).map(toFolder);
  }

  folder(id: number): DocumentFolder | null {
    const r = this.db.prepare('SELECT * FROM document_folders WHERE id = ?').get(id) as Row | undefined;
    return r ? toFolder(r) : null;
  }

  findFolder(incidentId: number, parentId: number | null, name: string): DocumentFolder | null {
    const r = this.db
      .prepare('SELECT * FROM document_folders WHERE incident_id = ? AND parent_id IS ? AND name = ? COLLATE NOCASE')
      .get(incidentId, parentId, name) as Row | undefined;
    return r ? toFolder(r) : null;
  }

  addFolder(f: Pick<DocumentFolder, 'incidentId' | 'parentId' | 'name' | 'system' | 'createdBy'>): DocumentFolder {
    const info = this.db
      .prepare('INSERT INTO document_folders (incident_id, parent_id, name, system, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.incidentId, f.parentId, f.name, f.system ? 1 : 0, f.createdBy, now());
    return this.folder(Number(info.lastInsertRowid))!;
  }

  folderEmpty(id: number): boolean {
    return (
      !this.db.prepare('SELECT 1 FROM documents WHERE folder_id = ?').get(id) && !this.db.prepare('SELECT 1 FROM document_folders WHERE parent_id = ?').get(id)
    );
  }

  removeFolder(id: number): void {
    this.db.prepare('DELETE FROM document_folders WHERE id = ?').run(id);
  }

  // --- Bedienprotokoll ---

  addAudit(e: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    this.db
      .prepare(
        'INSERT INTO audit (timestamp, operator, target, action, params, success, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(now(), e.operator, e.target, e.action, e.params, e.success ? 1 : 0, e.message);
  }

  audit(limit = 200): AuditEntry[] {
    return (this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toAudit);
  }
}
