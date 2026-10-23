import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  COLORABLE_KINDS,
  FMS_STATUS,
  MAP_OBJECT_LABELS,
  formatStrength,
  type Incident,
  type IncidentDocument,
  type IncidentPatch,
  type JournalEntry,
  type MapObject,
  type MapObjectPatch,
  type NewIncident,
  type NewJournalEntry,
  type NewUnit,
  type Topic,
  type Unit,
  type UnitPatch,
} from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';

/** Felder fürs Einsatztagebuch; null = Darstellungsfrage, kein Tagebuchereignis */
const INCIDENT_FIELD_LABELS: Record<keyof IncidentPatch, string | null> = {
  keyword: 'Stichwort',
  title: 'Bezeichnung',
  location: 'Einsatzort',
  leader: 'Einsatzleiter',
  lat: 'Position',
  lon: 'Position',
  vehicleVisible: null,
};

const fms = (s: number | null) => (s === null ? '–' : `${s} (${FMS_STATUS[s]?.label ?? '?'})`);

/**
 * Einsatzführung. All incident-scoped data (Tagebuch, Kräfte, Dokumente) is only writable while
 * the incident is open; closed incidents remain readable as an archive.
 */
export class IncidentService {
  private readonly docsDir: string;

  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly notify: (topics: Topic[]) => void,
  ) {
    this.docsDir = join(dataDir, 'documents');
    if (dataDir !== ':memory:') mkdirSync(this.docsDir, { recursive: true });
  }

  active(): Incident | null {
    return this.store.activeIncident();
  }

  list(): Incident[] {
    return this.store.incidents();
  }

  get(id: number): Incident {
    const incident = this.store.incident(id);
    if (!incident) throw new HttpError(404, `Einsatz ${id} nicht gefunden`);
    return incident;
  }

  private requireOpen(id: number): Incident {
    const incident = this.get(id);
    if (incident.closedAt) throw new HttpError(409, 'Einsatz ist abgeschlossen und kann nicht mehr geändert werden');
    return incident;
  }

  private system(incidentId: number, text: string, author: string): void {
    this.store.addJournal(incidentId, { category: 'system', text }, author);
  }

  start(input: NewIncident, operator: string): Incident {
    if (this.store.activeIncident()) throw new HttpError(409, 'Es ist bereits ein Einsatz aufgelegt');
    const incident = this.store.transaction(() => {
      const created = this.store.createIncident(input);
      const desc = [created.keyword, created.title].filter(Boolean).join(' – ');
      this.system(created.id, `Einsatz eröffnet: ${desc}${created.location ? `, ${created.location}` : ''}`, operator);
      return created;
    });
    this.notify(['incident', 'journal', 'cameraPresets']);
    return incident;
  }

  update(id: number, patch: IncidentPatch, operator: string): Incident {
    const before = this.requireOpen(id);
    const after = this.store.transaction(() => {
      const updated = this.store.updateIncident(id, patch);
      const changed = new Set(
        (Object.keys(patch) as (keyof IncidentPatch)[])
          .filter((k) => before[k] !== updated[k] && INCIDENT_FIELD_LABELS[k])
          .map((k) => INCIDENT_FIELD_LABELS[k]!),
      );
      if (changed.size > 0) this.system(id, `Einsatzdaten geändert: ${[...changed].join(', ')}`, operator);
      return updated;
    });
    this.notify(Object.keys(patch).every((k) => k === 'vehicleVisible') ? ['incident'] : ['incident', 'journal']);
    return after;
  }

  close(id: number, operator: string): Incident {
    this.requireOpen(id);
    const closed = this.store.transaction(() => {
      const active = this.store.units(id).filter((u) => !u.releasedAt).length;
      this.system(id, `Einsatz beendet${active ? ` (${active} Einheit(en) nicht formell entlassen)` : ''}`, operator);
      return this.store.closeIncident(id);
    });
    this.notify(['incident', 'journal', 'cameraPresets']);
    return closed;
  }

  // --- Einsatztagebuch ---

  journal(id: number): JournalEntry[] {
    this.get(id);
    return this.store.journal(id);
  }

  addJournal(id: number, entry: NewJournalEntry, operator: string): JournalEntry {
    this.requireOpen(id);
    if (entry.category === 'system') throw new HttpError(400, 'Systemeinträge werden automatisch erzeugt');
    if (entry.correctsId != null) {
      const original = this.store.journalEntry(entry.correctsId);
      if (!original || original.incidentId !== id) throw new HttpError(400, 'Zu korrigierender Eintrag nicht gefunden');
    }
    const created = this.store.addJournal(id, entry, operator);
    this.notify(['journal']);
    return created;
  }

  // --- Kartenobjekte ---

  mapObjects(id: number): MapObject[] {
    this.get(id);
    return this.store.mapObjects(id);
  }

  addMapObject(id: number, input: Pick<MapObject, 'kind' | 'name' | 'lat' | 'lon' | 'data'>, operator: string): MapObject {
    this.requireOpen(id);
    const created = this.store.transaction(() => {
      const o = this.store.addMapObject(id, input, operator);
      this.system(id, `Kartenobjekt hinzugefügt: ${MAP_OBJECT_LABELS[o.kind]} „${o.name}“`, operator);
      return o;
    });
    this.notify(['mapObjects', 'journal']);
    return created;
  }

  /** Name, Sichtbarkeit, Lage und Einstellungen; Änderungen an Einstellungen landen nicht im Tagebuch */
  patchMapObject(objectId: number, patch: MapObjectPatch, operator: string): MapObject {
    const before = this.store.mapObject(objectId);
    if (!before) throw new HttpError(404, `Kartenobjekt ${objectId} nicht gefunden`);
    this.requireOpen(before.incidentId);
    if (patch.data && before.kind !== 'gauss' && before.kind !== 'sector') throw new HttpError(400, 'Dieses Objekt hat keine Einstellungen');
    if (patch.color && !COLORABLE_KINDS.includes(before.kind)) throw new HttpError(400, 'Die Farben einer Gauß-Fahne stehen für die Konzentrationsstufen');
    const next = {
      ...before,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.visible !== undefined && { visible: patch.visible }),
      ...(patch.color !== undefined && { color: patch.color }),
      ...(patch.lat !== undefined && { lat: patch.lat }),
      ...(patch.lon !== undefined && { lon: patch.lon }),
      ...(patch.data && { data: { ...before.data, ...patch.data } }),
    } as MapObject;
    const saved = this.store.transaction(() => {
      const o = this.store.saveMapObject(next);
      if (before.name !== o.name) this.system(o.incidentId, `Kartenobjekt umbenannt: „${before.name}“ → „${o.name}“`, operator);
      if (before.lat !== o.lat || before.lon !== o.lon) this.system(o.incidentId, `Kartenobjekt verschoben: ${MAP_OBJECT_LABELS[o.kind]} „${o.name}“`, operator);
      return o;
    });
    this.notify(before.name !== saved.name || before.lat !== saved.lat || before.lon !== saved.lon ? ['mapObjects', 'journal'] : ['mapObjects']);
    return saved;
  }

  removeMapObject(objectId: number, operator: string): void {
    const o = this.store.mapObject(objectId);
    if (!o) throw new HttpError(404, `Kartenobjekt ${objectId} nicht gefunden`);
    this.requireOpen(o.incidentId);
    this.store.transaction(() => {
      this.store.removeMapObject(objectId);
      this.system(o.incidentId, `Kartenobjekt entfernt: ${MAP_OBJECT_LABELS[o.kind]} „${o.name}“`, operator);
    });
    this.notify(['mapObjects', 'journal']);
  }

  // --- Kräfte ---

  units(id: number): Unit[] {
    this.get(id);
    return this.store.units(id);
  }

  addUnit(id: number, input: NewUnit, operator: string): Unit {
    this.requireOpen(id);
    const unit = this.store.transaction(() => {
      const u = this.store.addUnit(id, input);
      const parts = [u.unitType, u.organization, `Stärke ${formatStrength(u.strength)}`].filter(Boolean);
      this.system(id, `Einheit eingetroffen: ${u.callsign} (${parts.join(', ')})${u.section ? ` → ${u.section}` : ''}`, operator);
      return u;
    });
    this.notify(['units', 'journal']);
    return unit;
  }

  patchUnit(unitId: number, patch: UnitPatch, operator: string): Unit {
    const before = this.store.unit(unitId);
    if (!before) throw new HttpError(404, `Einheit ${unitId} nicht gefunden`);
    this.requireOpen(before.incidentId);
    if (before.releasedAt && patch.released !== false) throw new HttpError(409, `${before.callsign} ist bereits entlassen`);

    const next: Unit = {
      ...before,
      ...(patch.callsign !== undefined && { callsign: patch.callsign }),
      ...(patch.unitType !== undefined && { unitType: patch.unitType }),
      ...(patch.organization !== undefined && { organization: patch.organization }),
      ...(patch.strength !== undefined && { strength: patch.strength }),
      ...(patch.section !== undefined && { section: patch.section }),
      ...(patch.fmsStatus !== undefined && { fmsStatus: patch.fmsStatus }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
      releasedAt: patch.released === true ? new Date().toISOString() : patch.released === false ? null : before.releasedAt,
    };

    const changes: string[] = [];
    if (next.fmsStatus !== before.fmsStatus) changes.push(`Status ${fms(next.fmsStatus)}`);
    if (next.section !== before.section) changes.push(next.section ? `Abschnitt → ${next.section}` : 'aus Abschnitt gelöst');
    if (formatStrength(next.strength) !== formatStrength(before.strength)) changes.push(`Stärke ${formatStrength(next.strength)}`);
    if (next.releasedAt && !before.releasedAt) changes.push('aus dem Einsatz entlassen');
    if (!next.releasedAt && before.releasedAt) changes.push('wieder im Einsatz');

    const saved = this.store.transaction(() => {
      const u = this.store.saveUnit(next);
      if (changes.length > 0) this.system(u.incidentId, `${u.callsign}: ${changes.join(', ')}`, operator);
      return u;
    });
    this.notify(changes.length > 0 ? ['units', 'journal'] : ['units']);
    return saved;
  }

  // --- Dokumente ---

  documents(id: number): IncidentDocument[] {
    this.get(id);
    return this.store.documents(id);
  }

  document(docId: number): IncidentDocument & { path: string } {
    const doc = this.store.document(docId);
    if (!doc) throw new HttpError(404, `Dokument ${docId} nicht gefunden`);
    const { storageName, ...rest } = doc;
    return { ...rest, path: join(this.docsDir, storageName) };
  }

  async addDocument(
    id: number,
    file: { filename: string; mimeType: string; stream: Readable; description: string },
    operator: string,
    maxBytes: number,
  ): Promise<IncidentDocument> {
    this.requireOpen(id);
    const storageName = randomUUID();
    const path = join(this.docsDir, storageName);
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) cb(new HttpError(413, `Datei größer als ${Math.round(maxBytes / 1024 / 1024)} MB`));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(file.stream, counter, createWriteStream(path));
    } catch (err) {
      await unlink(path).catch(() => {});
      throw err;
    }

    const doc = this.store.transaction(() => {
      const d = this.store.addDocument({
        incidentId: id,
        filename: file.filename,
        storageName,
        mimeType: file.mimeType,
        sizeBytes: size,
        description: file.description,
        uploadedBy: operator,
      });
      this.system(id, `Dokument hinzugefügt: ${d.filename}`, operator);
      return d;
    });
    this.notify(['documents', 'journal']);
    return doc;
  }

  async removeDocument(docId: number, operator: string): Promise<void> {
    const doc = this.document(docId);
    this.requireOpen(doc.incidentId);
    this.store.transaction(() => {
      this.store.removeDocument(docId);
      this.system(doc.incidentId, `Dokument entfernt: ${doc.filename}`, operator);
    });
    await unlink(doc.path).catch(() => {});
    this.notify(['documents', 'journal']);
  }
}
