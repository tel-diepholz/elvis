import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  BUILTIN_TYPES,
  LIBRARY_MAP_MAX_OBJECTS,
  LIBRARY_MAX_OBJECTS,
  OSM_WATER_QL,
  cleanProps,
  objectTypeInputSchema,
  overpassQuerySchema,
  sanitizeName,
  waterPropsFromOsm,
  type BuiltinObjectType,
  type LibraryFile,
  type LibraryGeometry,
  type LibraryObject,
  type LibraryObjectDetail,
  type LibraryObjectInput,
  type ObjectField,
  type ObjectType,
  type ObjectTypeInput,
  type OverpassBounds,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { writeStream } from './files.js';
import { assertEditable, cloudOrigin } from './cloudOrigin.js';
import type { OverpassService } from './overpass.js';

type Row = Record<string, unknown>;

const toType = (r: Row): ObjectType => ({
  id: r.id as number,
  uid: r.uid as string,
  builtin: (r.builtin as BuiltinObjectType | null) ?? null,
  name: r.name as string,
  icon: r.icon as string,
  color: r.color as string,
  fields: JSON.parse(r.fields as string) as ObjectField[],
  visibility: ((r.visibility as string | undefined) ?? 'both') as ObjectType['visibility'],
  sort: r.sort as number,
  rev: r.rev as number,
  updatedAt: r.updated_at as string,
  count: (r.count as number | undefined) ?? 0,
  cloud: cloudOrigin(r),
});

const toObject = (r: Row): LibraryObject => ({
  id: r.id as number,
  uid: r.uid as string,
  typeId: r.type_id as number,
  name: r.name as string,
  lat: r.lat as number,
  lon: r.lon as number,
  address: r.address as string,
  notes: r.notes as string,
  props: JSON.parse(r.props as string) as LibraryObject['props'],
  source: (r.source as string | null) ?? null,
  geometry: r.geometry ? (JSON.parse(r.geometry as string) as LibraryGeometry) : null,
  rev: r.rev as number,
  updatedAt: r.updated_at as string,
  updatedBy: r.updated_by as string,
  fileCount: (r.file_count as number | undefined) ?? 0,
  cloud: cloudOrigin(r),
});

const toFile = (r: Row): LibraryFile => ({
  id: r.id as number,
  uid: r.uid as string,
  objectId: r.object_id as number,
  filename: r.filename as string,
  mimeType: r.mime_type as string,
  sizeBytes: r.size_bytes as number,
  uploadedAt: r.uploaded_at as string,
  uploadedBy: r.uploaded_by as string,
});

const OBJECT_COLUMNS = `o.*, (SELECT COUNT(*) FROM library_files f WHERE f.object_id = o.id AND f.deleted_at IS NULL) AS file_count`;

async function sha256Of(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface ObjectQuery {
  bbox?: { s: number; w: number; n: number; e: number };
  typeIds?: number[];
  q?: string;
}

export interface OsmImportResult {
  added: number;
  skipped: number;
  truncated: boolean;
  sourceName: string;
}

/**
 * Objektbibliothek: Typen, Objekte und angehängte Dateien, unabhängig von einer Lage. Pflegen dürfen alle
 * Angemeldeten, Typen nur Admins (über /api/system/). Gelöschte Datensätze bleiben als Tombstone (deleted_at) stehen,
 * damit der spätere Abgleich mit der Cloud Löschungen weitergeben kann; ihre Dateien werden sofort entfernt.
 */
export class LibraryService {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    private readonly store: Store,
    dataDir: string,
    private readonly deps: { notify: (topics: Topic[]) => void; overpass?: OverpassService },
  ) {
    this.dir = join(dataDir, 'library');
    if (dataDir !== ':memory:') mkdirSync(this.dir, { recursive: true });
  }

  private audit(operator: string, action: string, message: string): void {
    this.store.addAudit({ operator, target: 'objektbibliothek', action, params: '', success: true, message });
    this.deps.notify(['library', 'audit']);
  }

  // --- Typen ---

  types(): ObjectType[] {
    return (
      this.db
        .prepare(
          `SELECT t.*, (SELECT COUNT(*) FROM library_objects o WHERE o.type_id = t.id AND o.deleted_at IS NULL) AS count
           FROM object_types t WHERE t.deleted_at IS NULL ORDER BY t.sort, t.name COLLATE NOCASE`,
        )
        .all() as Row[]
    ).map(toType);
  }

  type(id: number): ObjectType {
    const r = this.db
      .prepare(`SELECT t.*, (SELECT COUNT(*) FROM library_objects o WHERE o.type_id = t.id AND o.deleted_at IS NULL) AS count FROM object_types t WHERE t.id = ? AND t.deleted_at IS NULL`)
      .get(id) as Row | undefined;
    if (!r) throw new HttpError(404, `Objekttyp ${id} nicht gefunden`);
    return toType(r);
  }

  private checkName(name: string, exceptId?: number): void {
    const r = this.db.prepare('SELECT id FROM object_types WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id IS NOT ?').get(name, exceptId ?? null);
    if (r) throw new HttpError(409, `Objekttyp „${name}“ gibt es schon`);
  }

  createType(input: ObjectTypeInput, operator: string): ObjectType {
    const t = objectTypeInputSchema.parse(input);
    this.checkName(t.name);
    const sort = (this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM object_types').get() as { n: number }).n;
    const id = Number(
      this.db
        .prepare('INSERT INTO object_types (uid, name, icon, color, fields, visibility, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), t.name, t.icon, t.color, JSON.stringify(t.fields), t.visibility, sort, new Date().toISOString()).lastInsertRowid,
    );
    this.audit(operator, 'create', `Objekttyp ${t.name}`);
    return this.type(id);
  }

  /** Vordefinierte Typen behalten ihre Felder (Schlüssel und Art), weitere lassen sich ergänzen */
  updateType(id: number, input: ObjectTypeInput, operator: string): ObjectType {
    const old = this.type(id);
    assertEditable(this.originOf('object_types', id), 'Diesen Typ');
    const t = objectTypeInputSchema.parse(input);
    this.checkName(t.name, id);
    if (old.builtin) {
      for (const f of objectTypeInputSchema.parse(BUILTIN_TYPES[old.builtin]).fields) {
        const now = t.fields.find((x) => x.key === f.key);
        if (!now) throw new HttpError(400, `Feld „${f.label}“ gehört zum vordefinierten Typ und bleibt erhalten`);
        if (now.type !== f.type) throw new HttpError(400, `Art des Feldes „${f.label}“ lässt sich beim vordefinierten Typ nicht ändern`);
      }
    }
    this.db
      .prepare('UPDATE object_types SET name = ?, icon = ?, color = ?, fields = ?, visibility = ?, rev = rev + 1, updated_at = ? WHERE id = ?')
      .run(t.name, t.icon, t.color, JSON.stringify(t.fields), t.visibility, new Date().toISOString(), id);
    this.audit(operator, 'update', `Objekttyp ${t.name}`);
    return this.type(id);
  }

  /** Nur eigene Typen ohne Objekte */
  removeType(id: number, operator: string): void {
    const t = this.type(id);
    assertEditable(this.originOf('object_types', id), 'Diesen Typ');
    if (t.builtin) throw new HttpError(409, 'Vordefinierte Typen lassen sich nicht löschen');
    if (t.count) throw new HttpError(409, `Objekttyp „${t.name}“ hat noch ${t.count} Objekte`);
    this.db.prepare('UPDATE object_types SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), id);
    this.audit(operator, 'delete', `Objekttyp ${t.name}`);
  }

  reorderTypes(ids: number[], operator: string): ObjectType[] {
    const now = new Date().toISOString();
    const set = this.db.prepare('UPDATE object_types SET sort = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
    this.db.transaction(() => ids.forEach((id, i) => set.run(i, now, id)))();
    this.audit(operator, 'reorder', 'Reihenfolge der Objekttypen');
    return this.types();
  }

  // --- Objekte ---

  objects(query: ObjectQuery = {}): LibraryObject[] {
    const where = ['o.deleted_at IS NULL'];
    const params: unknown[] = [];
    const box = query.bbox;
    if (box) {
      where.push('o.lat BETWEEN ? AND ? AND o.lon BETWEEN ? AND ?');
      params.push(box.s, box.n, box.w, box.e);
    }
    if (query.typeIds) {
      if (!query.typeIds.length) return [];
      where.push(`o.type_id IN (${query.typeIds.map(() => '?').join(',')})`);
      params.push(...query.typeIds);
    }
    if (query.q?.trim()) {
      const like = `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(`(o.name LIKE ? ESCAPE '\\' OR o.address LIKE ? ESCAPE '\\' OR o.notes LIKE ? ESCAPE '\\' OR o.props LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like);
    }
    if (box) {
      // Kartenausschnitt: die zur Mitte nächsten (Länge mit cos der Breite gewichtet), damit bei vielen Objekten die Mitte voll ist
      const lat = (box.s + box.n) / 2;
      const lon = (box.w + box.e) / 2;
      const k = Math.cos((lat * Math.PI) / 180);
      const order = '(o.lat - ?) * (o.lat - ?) + (o.lon - ?) * (o.lon - ?) * ?';
      return (
        this.db
          .prepare(`SELECT ${OBJECT_COLUMNS} FROM library_objects o WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${LIBRARY_MAP_MAX_OBJECTS}`)
          .all(...params, lat, lat, lon, lon, k * k) as Row[]
      ).map(toObject);
    }
    return (
      this.db.prepare(`SELECT ${OBJECT_COLUMNS} FROM library_objects o WHERE ${where.join(' AND ')} ORDER BY o.name COLLATE NOCASE LIMIT ${LIBRARY_MAX_OBJECTS}`).all(...params) as Row[]
    ).map(toObject);
  }

  object(id: number): LibraryObjectDetail {
    const r = this.db.prepare(`SELECT ${OBJECT_COLUMNS} FROM library_objects o WHERE o.id = ? AND o.deleted_at IS NULL`).get(id) as Row | undefined;
    if (!r) throw new HttpError(404, `Objekt ${id} nicht gefunden`);
    const files = (this.db.prepare('SELECT * FROM library_files WHERE object_id = ? AND deleted_at IS NULL ORDER BY filename COLLATE NOCASE').all(id) as Row[]).map(toFile);
    return { ...toObject(r), files };
  }

  private props(typeId: number, props: Record<string, unknown>) {
    const type = this.type(typeId);
    const { props: clean, errors } = cleanProps(type.fields, props);
    if (errors.length) throw new HttpError(400, errors.join('; '));
    return { type, props: clean };
  }

  createObject(input: LibraryObjectInput & { source?: string | null; geometry?: LibraryGeometry | null }, operator: string): LibraryObjectDetail {
    const { type, props } = this.props(input.typeId, input.props ?? {});
    const id = this.insertObject({ ...input, props }, operator);
    this.audit(operator, 'create', `${type.name} ${input.name}`);
    return this.object(id);
  }

  private insertObject(o: LibraryObjectInput & { source?: string | null; geometry?: LibraryGeometry | null }, operator: string): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO library_objects (uid, type_id, name, lat, lon, address, notes, props, source, geometry, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          o.typeId,
          o.name,
          o.lat,
          o.lon,
          o.address ?? '',
          o.notes ?? '',
          JSON.stringify(o.props ?? {}),
          o.source ?? null,
          o.geometry ? JSON.stringify(o.geometry) : null,
          new Date().toISOString(),
          operator,
        ).lastInsertRowid,
    );
  }

  private originOf(table: string, id: number): { origin_node?: unknown; origin_name?: unknown } {
    return (this.db.prepare(`SELECT origin_node, origin_name FROM ${table} WHERE id = ?`).get(id) as { origin_node?: unknown; origin_name?: unknown } | undefined) ?? {};
  }

  updateObject(id: number, input: LibraryObjectInput, operator: string): LibraryObjectDetail {
    this.object(id);
    assertEditable(this.originOf('library_objects', id), 'Dieses Objekt');
    const { type, props } = this.props(input.typeId, input.props ?? {});
    this.db
      .prepare(
        `UPDATE library_objects SET type_id = ?, name = ?, lat = ?, lon = ?, address = ?, notes = ?, props = ?, rev = rev + 1, updated_at = ?, updated_by = ?
         WHERE id = ?`,
      )
      .run(input.typeId, input.name, input.lat, input.lon, input.address ?? '', input.notes ?? '', JSON.stringify(props), new Date().toISOString(), operator, id);
    this.audit(operator, 'update', `${type.name} ${input.name}`);
    return this.object(id);
  }

  async removeObject(id: number, operator: string): Promise<void> {
    const o = this.object(id);
    assertEditable(this.originOf('library_objects', id), 'Dieses Objekt');
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('UPDATE library_files SET deleted_at = ?, rev = rev + 1 WHERE object_id = ? AND deleted_at IS NULL').run(now, id);
      this.db.prepare('UPDATE library_objects SET deleted_at = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(now, now, operator, id);
    })();
    for (const f of o.files) await this.unlinkFile(f.id);
    this.audit(operator, 'delete', `Objekt ${o.name}`);
  }

  // --- Dateien ---

  async uploadFile(objectId: number, file: { filename: string; mimeType: string; stream: Readable }, operator: string, maxBytes: number): Promise<LibraryFile> {
    const o = this.object(objectId);
    assertEditable(this.originOf('library_objects', objectId), 'Dieses Objekt');
    const storageName = randomUUID();
    const path = join(this.dir, storageName);
    const size = await writeStream(path, file.stream, maxBytes);
    try {
      const sha = await sha256Of(path);
      let name = sanitizeName(file.filename) || 'Datei';
      const taken = (n: string) => !!this.db.prepare('SELECT 1 FROM library_files WHERE object_id = ? AND filename = ? COLLATE NOCASE AND deleted_at IS NULL').get(objectId, n);
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      for (let n = 2; taken(name); n++) name = `${stem} (${n})${ext}`;
      const id = Number(
        this.db
          .prepare(
            'INSERT INTO library_files (uid, object_id, filename, mime_type, size_bytes, storage_name, sha256, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(randomUUID(), objectId, name, file.mimeType || 'application/octet-stream', size, storageName, sha, new Date().toISOString(), operator).lastInsertRowid,
      );
      this.audit(operator, 'upload', `Datei ${name} an ${o.name}`);
      return toFile(this.db.prepare('SELECT * FROM library_files WHERE id = ?').get(id) as Row);
    } catch (err) {
      await unlink(path).catch(() => {});
      throw err;
    }
  }

  file(id: number): LibraryFile & { path: string } {
    const r = this.db.prepare('SELECT * FROM library_files WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, `Datei ${id} nicht gefunden`);
    return { ...toFile(r), path: join(this.dir, r.storage_name as string) };
  }

  private async unlinkFile(id: number): Promise<void> {
    const r = this.db.prepare('SELECT storage_name FROM library_files WHERE id = ?').get(id) as { storage_name: string } | undefined;
    if (r) await unlink(join(this.dir, r.storage_name)).catch(() => {});
  }

  async removeFile(id: number, operator: string): Promise<void> {
    const f = this.file(id);
    assertEditable(this.originOf('library_objects', f.objectId), 'Dieses Objekt');
    this.db.prepare('UPDATE library_files SET deleted_at = ?, rev = rev + 1 WHERE id = ?').run(new Date().toISOString(), id);
    await this.unlinkFile(id);
    this.audit(operator, 'delete', `Datei ${f.filename}`);
  }

  // --- Import aus OpenStreetMap ---

  /** Wasserentnahmestellen im Ausschnitt aus OSM übernehmen; schon übernommene (gleiche OSM-ID) bleiben unverändert */
  async importOsmWater(bounds: OverpassBounds, operator: string): Promise<OsmImportResult> {
    if (!this.deps.overpass) throw new HttpError(503, 'Overpass ist nicht verfügbar');
    const water = this.db.prepare("SELECT id FROM object_types WHERE builtin = 'water'").get() as { id: number } | undefined;
    if (!water) throw new HttpError(500, 'Typ Wasserentnahmestelle fehlt');
    const query = overpassQuerySchema.parse({ name: 'Wasserentnahmestellen', mode: 'ql', ql: OSM_WATER_QL });
    const result = await this.deps.overpass.run(query, bounds);
    const type = this.type(water.id);
    const exists = this.db.prepare('SELECT 1 FROM library_objects WHERE source = ? AND deleted_at IS NULL');
    let added = 0;
    let skipped = 0;
    this.db.transaction(() => {
      for (const f of result.features) {
        const source = `osm:${f.id}`;
        if (exists.get(source)) {
          skipped++;
          continue;
        }
        const { name, props } = waterPropsFromOsm(f.tags);
        const g = f.geometry;
        const geometry = g.type === 'Point' ? null : (g as LibraryGeometry);
        const address = [[f.tags['addr:street'], f.tags['addr:housenumber']].filter(Boolean).join(' '), [f.tags['addr:postcode'], f.tags['addr:city']].filter(Boolean).join(' ')]
          .filter(Boolean)
          .join(', ');
        this.insertObject({ typeId: type.id, name, lat: f.lat, lon: f.lon, address, notes: '', props: cleanProps(type.fields, props).props, source, geometry }, operator);
        added++;
      }
    })();
    if (added) this.audit(operator, 'import', `${added} Wasserentnahmestellen aus OpenStreetMap (${result.sourceName})`);
    return { added, skipped, truncated: result.truncated, sourceName: result.sourceName };
  }
}
