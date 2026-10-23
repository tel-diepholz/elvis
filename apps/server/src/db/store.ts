import type {
  AuditEntry,
  Incident,
  IncidentDocument,
  IncidentPatch,
  JournalCategory,
  JournalEntry,
  NewIncident,
  NewJournalEntry,
  NewUnit,
  Unit,
} from '@elvis/shared';
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
  callsign: r.callsign as string,
  unitType: r.unit_type as string,
  organization: r.organization as string,
  strength: { leaders: r.leaders as number, subLeaders: r.sub_leaders as number, crew: r.crew as number },
  section: r.section as string,
  fmsStatus: (r.fms_status as number | null) ?? null,
  notes: r.notes as string,
  arrivedAt: r.arrived_at as string,
  releasedAt: (r.released_at as string | null) ?? null,
  updatedAt: r.updated_at as string,
});

const toDocument = (r: Row): IncidentDocument & { storageName: string } => ({
  id: r.id as number,
  incidentId: r.incident_id as number,
  filename: r.filename as string,
  storageName: r.storage_name as string,
  mimeType: r.mime_type as string,
  sizeBytes: r.size_bytes as number,
  description: r.description as string,
  uploadedBy: r.uploaded_by as string,
  uploadedAt: r.uploaded_at as string,
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

/** Thin persistence layer; business rules live in the services. */
export class Store {
  constructor(readonly db: Db) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
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
    return this.incident(Number(info.lastInsertRowid))!;
  }

  updateIncident(id: number, patch: IncidentPatch): Incident {
    const current = this.incident(id)!;
    const next = { ...current, ...patch };
    this.db
      .prepare('UPDATE incidents SET keyword=@keyword, title=@title, location=@location, leader=@leader, lat=@lat, lon=@lon WHERE id=@id')
      .run({ id, keyword: next.keyword, title: next.title, location: next.location, leader: next.leader, lat: next.lat ?? null, lon: next.lon ?? null });
    return this.incident(id)!;
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
    return (this.db.prepare('SELECT * FROM units WHERE incident_id = ? ORDER BY arrived_at ASC').all(incidentId) as Row[]).map(toUnit);
  }

  unit(id: number): Unit | null {
    const r = this.db.prepare('SELECT * FROM units WHERE id = ?').get(id) as Row | undefined;
    return r ? toUnit(r) : null;
  }

  addUnit(incidentId: number, u: NewUnit): Unit {
    const ts = now();
    const s = u.strength ?? { leaders: 0, subLeaders: 0, crew: 0 };
    const info = this.db
      .prepare(
        `INSERT INTO units (incident_id, callsign, unit_type, organization, leaders, sub_leaders, crew, section, fms_status, notes, arrived_at, updated_at)
         VALUES (@incidentId, @callsign, @unitType, @organization, @leaders, @subLeaders, @crew, @section, @fmsStatus, @notes, @ts, @ts)`,
      )
      .run({
        incidentId,
        callsign: u.callsign,
        unitType: u.unitType ?? '',
        organization: u.organization ?? '',
        leaders: s.leaders,
        subLeaders: s.subLeaders,
        crew: s.crew,
        section: u.section ?? '',
        fmsStatus: u.fmsStatus ?? null,
        notes: u.notes ?? '',
        ts,
      });
    return this.unit(Number(info.lastInsertRowid))!;
  }

  saveUnit(u: Unit): Unit {
    this.db
      .prepare(
        `UPDATE units SET callsign=@callsign, unit_type=@unitType, organization=@organization, leaders=@leaders,
         sub_leaders=@subLeaders, crew=@crew, section=@section, fms_status=@fmsStatus, notes=@notes,
         released_at=@releasedAt, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({
        id: u.id,
        callsign: u.callsign,
        unitType: u.unitType,
        organization: u.organization,
        leaders: u.strength.leaders,
        subLeaders: u.strength.subLeaders,
        crew: u.strength.crew,
        section: u.section,
        fmsStatus: u.fmsStatus,
        notes: u.notes,
        releasedAt: u.releasedAt,
        updatedAt: now(),
      });
    return this.unit(u.id)!;
  }

  // --- Dokumente ---

  documents(incidentId: number): IncidentDocument[] {
    return (
      this.db.prepare('SELECT * FROM documents WHERE incident_id = ? ORDER BY uploaded_at DESC').all(incidentId) as Row[]
    ).map((r) => {
      const { storageName: _, ...doc } = toDocument(r);
      return doc;
    });
  }

  document(id: number): (IncidentDocument & { storageName: string }) | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Row | undefined;
    return r ? toDocument(r) : null;
  }

  addDocument(d: Omit<IncidentDocument, 'id' | 'uploadedAt'> & { storageName: string }): IncidentDocument {
    const info = this.db
      .prepare(
        `INSERT INTO documents (incident_id, filename, storage_name, mime_type, size_bytes, description, uploaded_by, uploaded_at)
         VALUES (@incidentId, @filename, @storageName, @mimeType, @sizeBytes, @description, @uploadedBy, @uploadedAt)`,
      )
      .run({ ...d, uploadedAt: now() });
    const { storageName: _, ...doc } = this.document(Number(info.lastInsertRowid))!;
    return doc;
  }

  removeDocument(id: number): void {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
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
