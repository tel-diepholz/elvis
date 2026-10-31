import type { z } from 'zod';
import {
  COLORABLE_KINDS,
  MAP_OBJECT_LABELS,
  TRACK_LOST_MS,
  TRAIL_MAX_POINTS,
  UNIT_STATUS,
  isTracked,
  formatStrength,
  isOnScene,
  sumStrength,
  unitDescendants,
  type DeployNode,
  type ForceUnit,
  type Incident,
  type IncidentPatch,
  type JournalEntry,
  type MapObject,
  type MapObjectPatch,
  type MapHistoryState,
  type MapObjectData,
  type IncidentOverpassQuery,
  type OverpassQuery,
  type TrackedData,
  type NewIncident,
  type NewJournalEntry,
  type Topic,
  type RadioIdentity,
  type Unit,
  type UnitStatus,
  type deployUnitSchema,
  type newUnitSchema,
  type unitPatchSchema,
} from '@elvis/shared';
import { isMapIcon } from '@elvis/shared/mapIcons';
import { isDv102Sign } from '@elvis/shared/dv102';
import type { Store } from '../db/store.js';
import { checkOverpassIcon } from './overpass.js';
import type { ForceService } from './forces.js';
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
  procurementMode: 'Beschaffung',
  procurementStaff: 'Stab für Anforderungen',
};

/**
 * Einsatzführung. All incident-scoped data (Tagebuch, Kräfte, Dokumente) is only writable while
 * the incident is open; closed incidents remain readable as an archive. Dokumente: services/documents.ts.
 */
export class IncidentService {
  private readonly removedListeners: ((o: MapObject) => void)[] = [];

  constructor(
    private readonly store: Store,
    private readonly notify: (topics: Topic[]) => void,
    /** Läuft beim Eröffnen innerhalb der Transaktion (z. B. Ordnerstruktur der Dokumente anlegen) */
    private readonly onStart: (incident: Incident) => void,
    private readonly forces: ForceService,
  ) {}

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
      this.onStart(created);
      return created;
    });
    this.notify(['incident', 'journal', 'cameraPresets', 'documents', 'tasks']);
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
      const active = this.store.units(id).filter((u) => u.status !== 'entlassen').length;
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

  /** Lage der Karte zu einem Zeitpunkt (Zeitstrahl); vor Einsatzbeginn gibt es keine */
  mapHistory(id: number, at: string): MapHistoryState {
    const incident = this.get(id);
    if (at < incident.startedAt) throw new HttpError(400, 'Der Zeitpunkt liegt vor Einsatzbeginn');
    return this.store.mapHistory(id, at);
  }

  addMapObject(id: number, input: Pick<MapObject, 'kind' | 'name' | 'lat' | 'lon' | 'data'> & { color?: string | null }, operator: string): MapObject {
    this.requireOpen(id);
    const icon = input.kind === 'point' ? (input.data as MapObjectData['point']).icon : null;
    if (icon && !isMapIcon(icon)) throw new HttpError(400, `Symbol „${icon}“ gibt es nicht`);
    const signData = input.kind === 'sign' ? (input.data as MapObjectData['sign']) : null;
    if (signData?.sign !== undefined && !isDv102Sign(signData.sign)) throw new HttpError(400, 'Dieses Zeichen gibt es nicht');
    const created = this.store.transaction(() => {
      const o = this.store.addMapObject(id, input, operator);
      this.system(id, `Kartenobjekt hinzugefügt: ${MAP_OBJECT_LABELS[o.kind]} „${o.name}“`, operator);
      return o;
    });
    this.notify(['mapObjects', 'journal']);
    return created;
  }

  /** Name, Sichtbarkeit, Beschriftung, Lage und Einstellungen; Änderungen an Einstellungen landen nicht im Tagebuch */
  patchMapObject(objectId: number, patch: MapObjectPatch, operator: string): MapObject {
    const before = this.store.mapObject(objectId);
    if (!before) throw new HttpError(404, `Kartenobjekt ${objectId} nicht gefunden`);
    this.requireOpen(before.incidentId);
    if (patch.data && before.kind !== 'gauss' && before.kind !== 'sector' && before.kind !== 'overlay') throw new HttpError(400, 'Dieses Objekt hat keine Einstellungen');
    if (patch.data && (before.kind === 'overlay') !== 'opacity' in patch.data) throw new HttpError(400, before.kind === 'overlay' ? 'Bei einem Overlay lässt sich nur die Deckkraft ändern' : 'Eine Deckkraft haben nur Overlays');
    if (patch.color && !COLORABLE_KINDS.includes(before.kind)) throw new HttpError(400, 'Die Farben einer Gauß-Fahne stehen für die Konzentrationsstufen');
    if (patch.icon !== undefined && before.kind !== 'point') throw new HttpError(400, 'Ein Symbol haben nur Punkte');
    if (patch.icon && !isMapIcon(patch.icon)) throw new HttpError(400, `Symbol „${patch.icon}“ gibt es nicht`);
    if (patch.outline && before.kind !== 'area') throw new HttpError(400, 'Einen Umriss haben nur Flächen');
    if (patch.path && before.kind !== 'line') throw new HttpError(400, 'Einen Verlauf haben nur Linien');
    if ((patch.sign !== undefined || patch.tactical) && before.kind !== 'sign') throw new HttpError(400, 'Ein Lagezeichen haben nur Zeichen');
    if (patch.sign !== undefined && patch.tactical) throw new HttpError(400, 'Entweder fertiges Zeichen oder Zeichen aus dem Generator');
    if (patch.sign !== undefined && !isDv102Sign(patch.sign)) throw new HttpError(400, 'Dieses Zeichen gibt es nicht');
    if (patch.detail !== undefined && before.kind !== 'point' && before.kind !== 'sign' && before.kind !== 'area' && before.kind !== 'line') throw new HttpError(400, 'Dieses Objekt hat keine Beschreibung');
    if ((patch.lat !== undefined || patch.lon !== undefined) && isTracked(before.kind)) throw new HttpError(400, 'Die Position kommt live vom Empfang und lässt sich nicht verschieben');
    if ((patch.lat !== undefined || patch.lon !== undefined) && before.kind === 'overlay') throw new HttpError(400, 'Die Lage eines Overlays legen die Passpunkte fest');
    const next = {
      ...before,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.visible !== undefined && { visible: patch.visible }),
      ...(patch.label !== undefined && { label: patch.label }),
      ...(patch.color !== undefined && { color: patch.color }),
      ...(patch.lat !== undefined && { lat: patch.lat }),
      ...(patch.lon !== undefined && { lon: patch.lon }),
      ...(patch.data && { data: { ...before.data, ...patch.data } }),
      ...(patch.icon !== undefined && { data: { ...before.data, icon: patch.icon } }),
    } as MapObject;
    if (patch.outline || patch.path || patch.detail !== undefined)
      next.data = {
        ...next.data,
        ...(patch.outline && { outline: patch.outline }),
        ...(patch.path && { path: patch.path }),
        ...(patch.detail !== undefined && { detail: patch.detail }),
      } as MapObject['data'];
    // Zeichen: fertiges Zeichen und Person schließen einander aus
    if (patch.sign || patch.tactical) next.data = { detail: (next.data as MapObjectData['sign']).detail, ...(patch.sign ? { sign: patch.sign } : { tactical: patch.tactical }) } as MapObject['data'];
    const reshaped = !!(patch.outline || patch.path);
    const saved = this.store.transaction(() => {
      const o = this.store.saveMapObject(next);
      if (before.name !== o.name) this.system(o.incidentId, `Kartenobjekt umbenannt: „${before.name}“ → „${o.name}“`, operator);
      if (reshaped) this.system(o.incidentId, `Kartenobjekt geändert: Form von ${MAP_OBJECT_LABELS[o.kind]} „${o.name}“`, operator);
      else if (before.lat !== o.lat || before.lon !== o.lon) this.system(o.incidentId, `Kartenobjekt verschoben: ${MAP_OBJECT_LABELS[o.kind]} „${o.name}“`, operator);
      return o;
    });
    this.notify(reshaped || before.name !== saved.name || before.lat !== saved.lat || before.lon !== saved.lon ? ['mapObjects', 'journal'] : ['mapObjects']);
    return saved;
  }

  /**
   * Live-Stand eines verfolgten Flugzeugs bzw. Schiffs übernehmen (ohne Tagebucheintrag je Position). fix = null
   * heißt: diesmal nichts empfangen. Ins Tagebuch kommen nur der Signalverlust und die Wiederkehr.
   */
  trackMapObject(objectId: number, fix: { lat: number; lon: number; at: string; altFt: number | null; onGround: boolean; speedKt: number | null; track: number | null } | null): MapObject | null {
    const before = this.store.mapObject(objectId);
    if (!before || !isTracked(before.kind) || this.store.incident(before.incidentId)?.closedAt) return null;
    const data = before.data as TrackedData;
    const label = `${MAP_OBJECT_LABELS[before.kind]} „${before.name}“`;
    let next: TrackedData;
    let journal: string | null = null;
    if (fix) {
      if (data.last && data.last.at >= fix.at) return null;
      const prev = data.trail.at(-1);
      const moved = !prev || prev[0] !== fix.lat || prev[1] !== fix.lon;
      next = {
        ...data,
        trail: moved ? [...data.trail, [fix.lat, fix.lon] as [number, number]].slice(-TRAIL_MAX_POINTS) : data.trail,
        last: { at: fix.at, altFt: fix.altFt, onGround: fix.onGround, speedKt: fix.speedKt, track: fix.track },
        lostSince: null,
      };
      if (data.lostSince) journal = `${label}: Signal wieder da`;
    } else {
      const since = data.last?.at ?? before.createdAt;
      if (data.lostSince || Date.now() - Date.parse(since) < TRACK_LOST_MS) return null;
      next = { ...data, lostSince: since };
      journal = `${label}: kein Signal mehr`;
    }
    const saved = this.store.transaction(() => {
      const o = this.store.saveMapObject({ ...before, ...(fix && { lat: fix.lat, lon: fix.lon }), data: next } as MapObject);
      if (journal) this.system(o.incidentId, journal, 'Empfang');
      return o;
    });
    this.notify(journal ? ['mapObjects', 'journal'] : ['mapObjects']);
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
    for (const fn of this.removedListeners) fn(o);
  }

  /** Aufräumen nach dem Entfernen eines Kartenobjekts (z. B. Kacheln eines Overlays) */
  onMapObjectRemoved(fn: (o: MapObject) => void): void {
    this.removedListeners.push(fn);
  }

  // --- Overpass-Abfragen der Karte ---

  overpassQueries(id: number): IncidentOverpassQuery[] {
    this.get(id);
    return this.store.overpassQueries(id);
  }

  addOverpassQuery(id: number, query: OverpassQuery, operator: string): IncidentOverpassQuery {
    this.requireOpen(id);
    checkOverpassIcon(query);
    const created = this.store.transaction(() => {
      const q = this.store.addOverpassQuery(id, query, operator);
      this.system(id, `Overpass-Abfrage gespeichert: „${q.name}“`, operator);
      return q;
    });
    this.notify(['overpassQueries', 'journal']);
    return created;
  }

  saveOverpassQuery(queryId: number, query: OverpassQuery): IncidentOverpassQuery {
    const before = this.store.overpassQuery(queryId);
    if (!before) throw new HttpError(404, `Overpass-Abfrage ${queryId} nicht gefunden`);
    this.requireOpen(before.incidentId);
    checkOverpassIcon(query);
    const saved = this.store.saveOverpassQuery(queryId, query);
    this.notify(['overpassQueries']);
    return saved;
  }

  removeOverpassQuery(queryId: number): void {
    const q = this.store.overpassQuery(queryId);
    if (!q) throw new HttpError(404, `Overpass-Abfrage ${queryId} nicht gefunden`);
    this.requireOpen(q.incidentId);
    this.store.removeOverpassQuery(queryId);
    this.notify(['overpassQueries']);
  }

  // --- Kräfte ---

  units(id: number): Unit[] {
    this.get(id);
    return this.store.units(id);
  }

  radioIds(id: number): RadioIdentity[] {
    this.get(id);
    return this.store.radioIds(id);
  }

  /** Übergeordnete Einheit prüfen: im selben Einsatz, nicht entlassen, nicht die Einheit selbst oder eine ihrer Untereinheiten */
  private parentFor(incidentId: number, parentId: number | null, selfId?: number): Unit | null {
    if (parentId === null) return null;
    const parent = this.store.unit(parentId);
    if (!parent || parent.incidentId !== incidentId) throw new HttpError(400, 'Übergeordnete Einheit nicht gefunden');
    if (parent.status === 'entlassen') throw new HttpError(409, `${parent.name} ist bereits entlassen`);
    if (selfId !== undefined && (parentId === selfId || unitDescendants(this.store.units(incidentId), selfId).some((u) => u.id === parentId))) {
      throw new HttpError(400, 'Eine Einheit kann nicht sich selbst oder einer ihrer Untereinheiten unterstellt werden');
    }
    return parent;
  }

  private create(incidentId: number, u: Omit<Unit, 'id' | 'incidentId' | 'createdAt' | 'updatedAt' | 'arrivedAt' | 'releasedAt' | 'lat' | 'lon' | 'positionSource' | 'positionAt' | 'positionAccuracyM' | 'mapVisible'>): Unit {
    const ts = new Date().toISOString();
    return this.store.addUnit({
      ...u,
      incidentId,
      lat: null,
      lon: null,
      positionSource: null,
      positionAt: null,
      positionAccuracyM: null,
      mapVisible: true,
      arrivedAt: isOnScene(u.status) ? ts : null,
      releasedAt: u.status === 'entlassen' ? ts : null,
    });
  }

  private arrivalText(u: Unit, extra: string[], parent: Unit | null): string {
    const parts = [u.organization, ...extra].filter(Boolean);
    return (
      `Einheit hinzugefügt: ${u.name}${parts.length ? ` (${parts.join(', ')})` : ''}, Status ${UNIT_STATUS[u.status]}` +
      `${parent ? `, unterstellt: ${parent.name}${u.role ? ` als ${u.role}` : ''}` : ''}${u.section ? ` → ${u.section}` : ''}`
    );
  }

  /** Im Einsatz neu erfasste Einheit (ohne Systemeinheit) */
  addUnit(id: number, input: z.output<typeof newUnitSchema>, operator: string): Unit {
    this.requireOpen(id);
    const unit = this.store.transaction(() => {
      const parent = this.parentFor(id, input.parentId);
      const u = this.create(id, { ...input, role: parent ? input.role : '', sourceId: null });
      this.system(id, this.arrivalText(u, [`Stärke ${formatStrength(u.strength)}`], parent), operator);
      return u;
    });
    this.notify(['units', 'journal']);
    return unit;
  }

  /** Systemeinheit als Kopie übernehmen – nur die ausgewählten Untereinheiten */
  deploy(id: number, input: z.output<typeof deployUnitSchema>, operator: string): Unit {
    this.requireOpen(id);
    const catalog = new Map(this.forces.list().map((f) => [f.id, f]));
    const active = new Map(this.store.units(id).filter((u) => u.status !== 'entlassen' && u.sourceId !== null).map((u) => [u.sourceId!, u]));
    const seen = new Set<number>();
    const check = (node: DeployNode, parent: ForceUnit | null) => {
      const f = catalog.get(node.forceUnitId);
      if (!f) throw new HttpError(400, `Systemeinheit ${node.forceUnitId} nicht gefunden`);
      if (parent && !parent.members.some((m) => m.unitId === f.id)) throw new HttpError(400, `${f.name} gehört nicht zu ${parent.name}`);
      if (seen.has(f.id)) throw new HttpError(400, `${f.name} ist mehrfach ausgewählt`);
      if (active.has(f.id)) throw new HttpError(409, `${f.name} ist bereits im Einsatz`);
      seen.add(f.id);
      node.children.forEach((c) => check(c, f));
    };
    check(input.tree, null);

    const root = this.store.transaction(() => {
      const parent = this.parentFor(id, input.parentId);
      const created: Unit[] = [];
      const make = (node: DeployNode, parentId: number | null, role: string): Unit => {
        const f = catalog.get(node.forceUnitId)!;
        const u = this.create(id, { ...f, parentId, role, sourceId: f.id, section: input.section, status: input.status });
        created.push(u);
        for (const c of node.children) make(c, u.id, f.members.find((m) => m.unitId === c.forceUnitId)!.role);
        return u;
      };
      const r = make(input.tree, parent?.id ?? null, parent ? input.role : '');
      const subs = created.slice(1).map((u) => u.name);
      this.system(id, this.arrivalText(r, [`Stärke ${formatStrength(sumStrength(created))}`, subs.length ? `mit ${subs.join(', ')}` : ''], parent), operator);
      return r;
    });
    this.notify(['units', 'journal']);
    return root;
  }

  /** Systemeintrag im Tagebuch (z. B. Online-Formular bereitgestellt) */
  incidentEvent(incidentId: number, text: string, operator: string): void {
    this.system(incidentId, text, operator);
    this.notify(['journal']);
  }

  /** Tagebucheintrag zu einer Einheit (z. B. App gekoppelt) */
  unitEvent(unitId: number, text: string, operator: string): void {
    const unit = this.store.unit(unitId);
    if (!unit) throw new HttpError(404, `Einheit ${unitId} nicht gefunden`);
    this.system(unit.incidentId, `${unit.name}: ${text}`, operator);
    this.notify(['journal']);
  }

  /**
   * Position aus der App übernehmen. Ins Tagebuch kommt nur der Wechsel auf App-Ortung, nicht jede
   * Meldung. Ältere Meldungen als die gespeicherte Position werden verworfen.
   */
  setUnitPositionFromApp(unitId: number, pos: { lat: number; lon: number; accuracyM: number | null; ts: string }): Unit | null {
    const before = this.store.unit(unitId);
    if (!before || before.status === 'entlassen' || this.store.incident(before.incidentId)?.closedAt) return null;
    if (before.positionSource === 'app' && before.positionAt && before.positionAt >= pos.ts) return null;
    const first = before.positionSource !== 'app';
    const saved = this.store.transaction(() => {
      const u = this.store.saveUnit({ ...before, lat: pos.lat, lon: pos.lon, positionSource: 'app', positionAt: pos.ts, positionAccuracyM: pos.accuracyM });
      if (first) this.system(u.incidentId, `${u.name}: Position per App${before.lat === null ? '' : ' (statt von Hand)'}`, 'App');
      return u;
    });
    this.notify(first ? ['units', 'journal'] : ['units']);
    return saved;
  }

  patchUnit(unitId: number, patch: z.output<typeof unitPatchSchema>, operator: string): Unit {
    const before = this.store.unit(unitId);
    if (!before) throw new HttpError(404, `Einheit ${unitId} nicht gefunden`);
    this.requireOpen(before.incidentId);
    const ts = new Date().toISOString();
    const status = patch.status ?? before.status;
    const stamp = (u: Unit, s: UnitStatus): Unit => ({
      ...u,
      status: s,
      arrivedAt: u.arrivedAt ?? (isOnScene(s) ? ts : null),
      releasedAt: s === 'entlassen' ? (u.releasedAt ?? ts) : null,
    });
    const next: Unit = stamp(
      {
        ...before,
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.callsign !== undefined && { callsign: patch.callsign }),
        ...(patch.organization !== undefined && { organization: patch.organization }),
        ...(patch.notes !== undefined && { notes: patch.notes }),
        ...(patch.email !== undefined && { email: patch.email }),
        ...(patch.sign !== undefined && { sign: patch.sign }),
        ...(patch.strength !== undefined && { strength: patch.strength }),
        ...(patch.section !== undefined && { section: patch.section }),
        ...(patch.parentId !== undefined && { parentId: patch.parentId }),
        ...(patch.role !== undefined && { role: patch.role }),
        ...(patch.lat !== undefined && {
          lat: patch.lat,
          lon: patch.lon ?? null,
          positionSource: patch.lat === null ? null : ('manual' as const),
          positionAt: patch.lat === null ? null : ts,
          positionAccuracyM: null,
        }),
        ...(patch.mapVisible !== undefined && { mapVisible: patch.mapVisible }),
      },
      status,
    );
    const parent = next.parentId !== before.parentId ? this.parentFor(before.incidentId, next.parentId, before.id) : null;
    if (next.parentId === null) next.role = '';

    // Status und Abschnitt gelten für die Untereinheiten mit; schon entlassene bleiben es (außer die Einheit kehrt zurück)
    const subs = unitDescendants(this.store.units(before.incidentId), before.id);
    const statusChanged = next.status !== before.status;
    const sectionChanged = next.section !== before.section;
    const followers =
      patch.cascade && (statusChanged || sectionChanged) ? subs.filter((d) => d.status !== 'entlassen' || before.status === 'entlassen') : [];

    const changes: string[] = [];
    if (next.name !== before.name) changes.push(`umbenannt in ${next.name}`);
    if (statusChanged) changes.push(`Status ${UNIT_STATUS[next.status]}${followers.length && statusChanged ? ` (mit ${followers.length} Untereinheit${followers.length === 1 ? '' : 'en'})` : ''}`);
    if (sectionChanged) changes.push(next.section ? `Abschnitt → ${next.section}` : 'aus Abschnitt gelöst');
    if (formatStrength(next.strength) !== formatStrength(before.strength)) changes.push(`Stärke ${formatStrength(next.strength)}`);
    if (next.email !== before.email) changes.push(next.email ? `E-Mail ${next.email}` : 'E-Mail-Adresse entfernt');
    if (next.parentId !== before.parentId) changes.push(parent ? `unterstellt: ${parent.name}${next.role ? ` als ${next.role}` : ''}` : 'als eigenständige Einheit geführt');
    else if (next.role !== before.role && next.parentId !== null) changes.push(next.role ? `Rolle ${next.role}` : 'ohne Rolle');
    if (next.lat !== before.lat || next.lon !== before.lon) changes.push(next.lat === null ? 'von der Karte entfernt' : before.lat === null ? 'auf der Karte gesetzt' : 'auf der Karte verschoben');

    const saved = this.store.transaction(() => {
      const u = this.store.saveUnit(next);
      for (const d of followers) {
        this.store.saveUnit(stamp({ ...d, ...(sectionChanged && { section: next.section }) }, statusChanged ? next.status : d.status));
      }
      if (changes.length > 0) this.system(u.incidentId, `${u.name}: ${changes.join(', ')}`, operator);
      return u;
    });
    this.notify(changes.length > 0 ? ['units', 'journal'] : ['units']);
    return saved;
  }
}
