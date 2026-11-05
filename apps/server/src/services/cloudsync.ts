import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_UNIT_SIGN,
  RECORD_KINDS,
  RECORD_SCHEMAS,
  SYNC_MAX_CHANGES,
  tacticalSignSchema,
  type CloudOrigin,
  type CloudSyncStatus,
  type RecordDataMap,
  type RecordKind,
  type SyncChange,
  type SyncPull,
  type SyncRecord,
  type SyncResult,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import type { CloudService } from './cloud.js';

/**
 * Stammdaten-Abgleich mit der Cloud (Kräfte, Einsatzstichworte, Rollen, Benutzer, Aufgabenvorlagen).
 *
 * - **Abholen:** Änderungen ab dem Cursor; ELVIS übernimmt sie in die lokalen Tabellen (Herkunft = Knoten). Datensätze
 *   anderer Knoten sind hier nur lesbar.
 * - **Senden:** eigene Datensätze (nur lokal oder vom eigenen Knoten) vergleicht ELVIS mit dem zuletzt abgeglichenen
 *   Stand in `cloud_sync`; Neues, Geändertes und Gelöschtes geht an die Cloud. Bei einem Konflikt gewinnt die Cloud,
 *   die verworfene Änderung steht im Bedienprotokoll.
 * - **Erster Abgleich:** Lokale Datensätze ohne uid, die einem Cloud-Datensatz entsprechen (Funkrufname bzw. Name), werden
 *   übernommen statt doppelt angelegt.
 *
 * Laufende Lagen bleiben unberührt: Sie arbeiten mit Kopien (units, tasks).
 */

const STATE_KEY = 'cloud:sync';
const INTERVAL_MS = 60_000;
const MAX_CONFLICTS = 20;

interface SyncState {
  enabled: boolean;
  cursor: number;
  nodeId: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  conflicts: CloudSyncStatus['conflicts'];
}

const EMPTY: SyncState = { enabled: false, cursor: 0, nodeId: null, lastRunAt: null, lastSuccessAt: null, lastError: null, conflicts: [] };

const TABLE: Record<RecordKind, string> = {
  force: 'force_units',
  keyword: 'incident_keywords',
  role: 'roles',
  user: 'users',
  taskTemplate: 'task_templates',
  objectType: 'object_types',
  object: 'library_objects',
  objectFile: 'library_files',
};
/** Objektbibliothek: gelöschte bleiben lokal als Tombstone (deleted_at) stehen */
const LIBRARY: RecordKind[] = ['objectType', 'object', 'objectFile'];
const live = (kind: RecordKind) => (LIBRARY.includes(kind) ? ' WHERE deleted_at IS NULL' : '');
/** Reihenfolge beim Übernehmen und Senden: Verweise zuerst */
const ORDER: RecordKind[] = ['role', 'keyword', 'user', 'force', 'taskTemplate', 'objectType', 'object', 'objectFile'];
const TOPICS: Topic[] = ['forces', 'roles', 'users', 'taskTemplates', 'settings', 'tasks', 'library', 'cloud'];

type Row = Record<string, unknown> & { id: number; uid: string | null; origin_node: string | null; origin_name: string | null };

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** Stabile Darstellung (sortierte Schlüssel) für den Vergleich */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const canon = <K extends RecordKind>(kind: K, data: unknown): RecordDataMap[K] => RECORD_SCHEMAS[kind].parse(data) as RecordDataMap[K];

export class CloudSyncService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** Dateien gelöschter Objekte, nach dem Übernehmen entfernen */
  private unlinkLater: string[] = [];

  constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly cloud: CloudService,
    private readonly opts: { notify: (t: Topic[]) => void; log?: { warn: (o: unknown, msg: string) => void }; intervalMs?: number; libraryDir: string },
  ) {
    cloud.onUnlink(() => this.detach());
  }

  // --- Zustand ---

  private state(): SyncState {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
    return r ? { ...EMPTY, ...(JSON.parse(r.value) as Partial<SyncState>) } : EMPTY;
  }

  private save(patch: Partial<SyncState>): SyncState {
    const next = { ...this.state(), ...patch };
    this.db
      .prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(STATE_KEY, JSON.stringify(next), new Date().toISOString());
    return next;
  }

  /** Eigener Knoten (aus dem letzten Abruf) */
  ownNode(): string | null {
    return this.state().nodeId;
  }

  /** Herkunft eines Datensatzes für die Oberfläche; null = nur lokal */
  origin(row: { origin_node: string | null; origin_name: string | null }): CloudOrigin | null {
    if (!row.origin_node) return null;
    return { node: row.origin_node, name: row.origin_name ?? '', editable: row.origin_node === this.state().nodeId };
  }

  /** Darf lokal geändert werden? (Datensätze anderer Knoten nur in der Cloud) */
  editable(kind: RecordKind, id: number): { ok: true } | { ok: false; owner: string } {
    const r = this.db.prepare(`SELECT origin_node, origin_name FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { origin_node: string | null; origin_name: string | null } | undefined;
    if (!r?.origin_node || r.origin_node === this.state().nodeId) return { ok: true };
    return { ok: false, owner: r.origin_name ?? r.origin_node };
  }

  status(): CloudSyncStatus {
    const s = this.state();
    const own = s.nodeId;
    const counts = Object.fromEntries(
      RECORD_KINDS.map((k) => {
        const rows = this.db.prepare(`SELECT origin_node FROM ${TABLE[k]}${live(k)}`).all() as { origin_node: string | null }[];
        return [k, { foreign: rows.filter((r) => r.origin_node && r.origin_node !== own).length, own: rows.filter((r) => r.origin_node && r.origin_node === own).length, local: rows.filter((r) => !r.origin_node).length }];
      }),
    ) as CloudSyncStatus['counts'];
    return { enabled: s.enabled, running: this.running !== null, lastRunAt: s.lastRunAt, lastSuccessAt: s.lastSuccessAt, lastError: s.lastError, counts, conflicts: s.conflicts };
  }

  // --- Steuerung ---

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run().catch(() => undefined), this.opts.intervalMs ?? INTERVAL_MS);
    this.timer.unref?.();
    void this.run().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async enable(operator: string): Promise<CloudSyncStatus> {
    if (!this.cloud.linked()) throw Object.assign(new Error('Nicht mit der Cloud verknüpft'), { statusCode: 409 });
    this.save({ enabled: true, cursor: 0 });
    this.audit(operator, 'enable', 'Stammdaten-Abgleich gestartet');
    await this.run();
    return this.status();
  }

  async disable(operator: string): Promise<CloudSyncStatus> {
    this.save({ enabled: false });
    this.audit(operator, 'disable', 'Stammdaten-Abgleich beendet');
    return this.status();
  }

  /** Alles neu abholen (Cursor auf 0) */
  async resync(operator: string): Promise<CloudSyncStatus> {
    this.save({ cursor: 0 });
    this.audit(operator, 'resync', 'Stammdaten neu abgeholt');
    await this.run();
    return this.status();
  }

  /** Getrennt: Cloud-Datensätze bleiben als lokale stehen, der Abgleich endet */
  private detach(): void {
    this.db.transaction(() => {
      for (const t of Object.values(TABLE)) this.db.prepare(`UPDATE ${t} SET origin_node = NULL, origin_name = NULL`).run();
      this.db.prepare('DELETE FROM cloud_sync').run();
    })();
    this.save({ ...EMPTY });
    this.opts.notify(TOPICS);
  }

  private audit(operator: string, action: string, message: string, success = true): void {
    this.store.addAudit({ operator, target: 'cloud', action, params: '', success, message });
    this.opts.notify(['audit', 'cloud']);
  }

  private conflict(kind: RecordKind, name: string, reason: string): void {
    const s = this.state();
    if (s.conflicts.some((c) => c.kind === kind && c.name === name && c.reason === reason && Date.now() - new Date(c.at).getTime() < 3600_000)) return;
    this.save({ conflicts: [{ at: new Date().toISOString(), kind, name, reason }, ...s.conflicts].slice(0, MAX_CONFLICTS) });
    this.store.addAudit({ operator: 'Cloud', target: 'cloud', action: 'conflict', params: kind, success: false, message: `${name}: ${reason}` });
  }

  /** Ein Durchlauf: abholen, dann senden. Gleichzeitige Aufrufe teilen sich den laufenden. */
  run(): Promise<void> {
    const s = this.state();
    if (!s.enabled || !this.cloud.linked()) return Promise.resolve();
    this.running ??= this.cycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle(): Promise<void> {
    const at = new Date().toISOString();
    try {
      let changed = false;
      for (let page = 0; page < 50; page++) {
        const res = await this.cloud.signed<SyncPull>('GET', `/v1/elws/me/cloud/sync?after=${this.state().cursor}`);
        this.save({ nodeId: res.nodeId });
        if (res.items.length) {
          this.db.transaction(() => this.applyAll(res.items))();
          changed = true;
        }
        this.save({ cursor: res.next });
        if (!res.more) break;
      }
      for (const path of this.unlinkLater.splice(0)) await unlink(path).catch(() => {});
      if (await this.fetchFiles()) changed = true;
      if (await this.push()) changed = true;
      this.save({ lastRunAt: at, lastSuccessAt: at, lastError: null });
      if (changed) this.opts.notify(TOPICS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.save({ lastRunAt: at, lastError: msg });
      this.opts.log?.warn({ err: msg }, 'Stammdaten-Abgleich fehlgeschlagen');
      this.opts.notify(['cloud']);
    }
  }

  // --- Lokale Datensätze ---

  private rows(kind: RecordKind): Row[] {
    return this.db.prepare(`SELECT * FROM ${TABLE[kind]}${live(kind)}`).all() as Row[];
  }

  private uidOf(kind: RecordKind, id: number): string | null {
    return (this.db.prepare(`SELECT uid FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { uid: string | null } | undefined)?.uid ?? null;
  }

  private idOf(kind: RecordKind, uid: string): number | null {
    return (this.db.prepare(`SELECT id FROM ${TABLE[kind]} WHERE uid = ?${LIBRARY.includes(kind) ? ' AND deleted_at IS NULL' : ''}`).get(uid) as { id: number } | undefined)?.id ?? null;
  }

  /** Lokaler Datensatz in der Form der Cloud */
  private serialize(kind: RecordKind, r: Row): unknown {
    switch (kind) {
      case 'force': {
        const sign = JSON.parse(r.sign as string) as unknown;
        const members = (this.db.prepare('SELECT m.role, f.uid FROM force_unit_members m JOIN force_units f ON f.id = m.child_id WHERE m.parent_id = ? ORDER BY m.sort').all(r.id) as { role: string; uid: string | null }[])
          .filter((m) => m.uid)
          .map((m) => ({ uid: m.uid!, role: m.role }));
        return {
          name: r.name,
          callsign: r.callsign,
          organization: r.organization,
          notes: r.notes,
          email: r.email,
          mobile: r.mobile,
          sign: stable(sign) === stable(DEFAULT_UNIT_SIGN) ? null : sign,
          strength: { leaders: r.leaders, subLeaders: r.sub_leaders, crew: r.crew },
          members,
        };
      }
      case 'keyword':
        return { name: r.name, sort: r.sort };
      case 'role':
        return { name: r.name, description: r.description, sort: r.sort };
      case 'user':
        return { firstName: r.first_name, lastName: r.last_name, isAdmin: r.is_admin === 1 };
      case 'taskTemplate': {
        const tpl = r.document_template_id ? (this.db.prepare('SELECT name FROM templates WHERE id = ?').get(r.document_template_id) as { name: string } | undefined) : undefined;
        return {
          summary: r.summary,
          description: r.description,
          roleUid: r.role_id ? this.uidOf('role', r.role_id as number) : null,
          documentTemplateName: tpl?.name ?? null,
          intervalMinutes: r.interval_minutes,
          offsetMinutes: r.offset_minutes,
          sort: r.sort,
        };
      }
      case 'objectType':
        return { name: r.name, icon: r.icon, color: r.color, fields: JSON.parse(r.fields as string), builtin: r.builtin ?? null, visibility: r.visibility ?? 'both', sort: r.sort };
      case 'object':
        return {
          typeUid: this.uidOf('objectType', r.type_id as number),
          name: r.name,
          lat: r.lat,
          lon: r.lon,
          address: r.address,
          notes: r.notes,
          props: JSON.parse(r.props as string),
          source: r.source ?? null,
          geometry: r.geometry ? JSON.parse(r.geometry as string) : null,
        };
      case 'objectFile':
        return { objectUid: this.uidOf('object', r.object_id as number), filename: r.filename, mimeType: r.mime_type, sizeBytes: r.size_bytes, sha256: r.sha256 };
    }
  }

  /** Erkennungsmerkmal für den ersten Abgleich (gleiche Einheit, gleiche Rolle …) */
  private naturalKey(kind: RecordKind, d: Record<string, unknown>): string {
    switch (kind) {
      case 'force':
        return d.callsign ? `c:${lower(d.callsign)}` : `n:${lower(d.name)}|${lower(d.organization)}`;
      case 'user':
        return `${lower(d.firstName ?? d.first_name)}|${lower(d.lastName ?? d.last_name)}`;
      case 'taskTemplate':
        return lower(d.summary);
      case 'objectType':
        return d.builtin ? `b:${String(d.builtin)}` : lower(d.name);
      case 'object':
        return d.source ? `s:${String(d.source)}` : `${String(d.typeUid)}|${lower(d.name)}|${Number(d.lat).toFixed(5)}|${Number(d.lon).toFixed(5)}`;
      case 'objectFile':
        return `${String(d.objectUid)}|${lower(d.filename)}|${String(d.sha256)}`;
      default:
        return lower(d.name);
    }
  }

  // --- Übernehmen ---

  private applyAll(items: SyncRecord[]): void {
    const sorted = [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.seq - b.seq);
    for (const item of sorted) {
      try {
        this.apply(item);
      } catch (e) {
        this.conflict(item.kind, item.data ? String((item.data as Record<string, unknown>).name ?? (item.data as Record<string, unknown>).summary ?? item.uid) : item.uid, `Nicht übernommen: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Verweise, die beim ersten Mal fehlten (Untereinheit, Rolle kam später)
    for (const s of this.db.prepare('SELECT uid, kind, data FROM cloud_sync WHERE unresolved = 1').all() as { uid: string; kind: RecordKind; data: string }[]) {
      const id = this.idOf(s.kind, s.uid);
      if (id !== null) this.db.prepare('UPDATE cloud_sync SET unresolved = ? WHERE uid = ?').run(this.resolve(s.kind, id, JSON.parse(s.data)) ? 0 : 1, s.uid);
    }
  }

  private snapshot(item: SyncRecord, unresolved: boolean): void {
    this.db
      .prepare('INSERT INTO cloud_sync (uid, kind, rev, node_id, data, unresolved) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET rev = excluded.rev, node_id = excluded.node_id, data = excluded.data, unresolved = excluded.unresolved')
      .run(item.uid, item.kind, item.rev, item.nodeId, stable(item.data), unresolved ? 1 : 0);
  }

  private apply(item: SyncRecord): void {
    const kind = item.kind;
    const table = TABLE[kind];
    // Schon bekannt (z. B. die eigene, gerade gesendete Änderung): lokale Änderungen seitdem nicht überschreiben
    const known = this.db.prepare('SELECT rev, data FROM cloud_sync WHERE uid = ?').get(item.uid) as { rev: number; data: string } | undefined;
    if (known && known.rev >= item.rev) return;
    let id = this.idOf(kind, item.uid);
    // Eigene, noch nicht gesendete Änderung wird überschrieben: im Protokoll festhalten
    if (id !== null && known && !item.deleted) {
      const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row;
      let local: string | null = null;
      try {
        local = stable(canon(kind, this.serialize(kind, row)));
      } catch {
        /* lokal ungültig */
      }
      if (local !== null && local !== known.data && local !== stable(item.data)) this.conflict(kind, this.label(kind, id), 'Gleichzeitig in der Cloud geändert – Stand der Cloud übernommen');
    }

    if (item.deleted || !item.data) {
      this.db.prepare('DELETE FROM cloud_sync WHERE uid = ?').run(item.uid);
      if (id === null) return;
      if (kind === 'user' && this.isLastAdmin(id)) return this.conflict(kind, this.label(kind, id), 'Letzter Admin mit PIN bleibt lokal');
      if (kind === 'object' || kind === 'objectFile') {
        const files = this.db.prepare(`SELECT storage_name FROM library_files WHERE ${kind === 'object' ? 'object_id' : 'id'} = ?`).all(id) as { storage_name: string }[];
        for (const f of files) this.unlinkLater.push(join(this.opts.libraryDir, f.storage_name));
      }
      if (kind === 'objectType' && this.db.prepare('SELECT 1 FROM library_objects WHERE type_id = ? AND deleted_at IS NULL').get(id)) {
        return this.conflict(kind, this.label(kind, id), 'Typ hat hier noch Objekte – bleibt lokal');
      }
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      return;
    }

    const data = canon(kind, item.data);
    if (id === null) {
      // Erster Abgleich: passenden lokalen Datensatz ohne uid übernehmen
      const key = this.naturalKey(kind, data as Record<string, unknown>);
      // Kandidaten: nur lokal und noch nie abgeglichen (die Objektbibliothek vergibt uids schon beim Anlegen)
      const synced = this.db.prepare('SELECT 1 FROM cloud_sync WHERE uid = ?');
      const match = this.rows(kind).find((r) => !r.origin_node && (!r.uid || !synced.get(r.uid)) && this.naturalKey(kind, this.serialize(kind, r) as Record<string, unknown>) === key);
      if (match) {
        this.db.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`).run(item.uid, match.id);
        id = match.id;
      }
    }
    id = this.write(kind, id, data, item);
    this.db.prepare(`UPDATE ${table} SET uid = ?, origin_node = ?, origin_name = ? WHERE id = ?`).run(item.uid, item.nodeId, item.nodeName, id);
    this.snapshot(item, !this.resolve(kind, id, data));
  }

  /** Felder schreiben (ohne Verweise auf andere Datensätze); liefert die lokale ID */
  private write(kind: RecordKind, id: number | null, data: RecordDataMap[RecordKind], item: SyncRecord): number {
    const now = new Date().toISOString();
    const run = (insert: string, update: string, params: unknown[]) =>
      id === null ? Number(this.db.prepare(insert).run(...params).lastInsertRowid) : (this.db.prepare(update).run(...params, id), id);
    switch (kind) {
      case 'force': {
        const d = data as RecordDataMap['force'];
        const local = id !== null ? (this.db.prepare('SELECT email, mobile FROM force_units WHERE id = ?').get(id) as { email: string; mobile: string }) : null;
        const sign = d.sign ? tacticalSignSchema.safeParse(d.sign) : null;
        // Gemerkte Adresse/Rufnummer (aus eingegangenen Nachrichten) bleibt, solange die Cloud keine kennt
        const params = [d.name, d.callsign, d.organization, d.notes, d.email || local?.email || '', d.mobile || local?.mobile || '', JSON.stringify(sign?.success ? sign.data : DEFAULT_UNIT_SIGN), d.strength.leaders, d.strength.subLeaders, d.strength.crew];
        return run(
          'INSERT INTO force_units (name, callsign, organization, notes, email, mobile, sign, leaders, sub_leaders, crew, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          'UPDATE force_units SET name = ?, callsign = ?, organization = ?, notes = ?, email = ?, mobile = ?, sign = ?, leaders = ?, sub_leaders = ?, crew = ?, updated_at = ? WHERE id = ?',
          id === null ? [...params, now, now] : [...params, now],
        );
      }
      case 'keyword': {
        const d = data as RecordDataMap['keyword'];
        return run('INSERT INTO incident_keywords (name, sort) VALUES (?, ?)', 'UPDATE incident_keywords SET name = ?, sort = ? WHERE id = ?', [d.name, d.sort]);
      }
      case 'role': {
        const d = data as RecordDataMap['role'];
        const clash = this.db.prepare('SELECT id, uid FROM roles WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(d.name, id) as { id: number; uid: string | null } | undefined;
        if (clash) throw new Error(`Rolle „${d.name}“ gibt es schon`);
        return run('INSERT INTO roles (name, description, sort) VALUES (?, ?, ?)', 'UPDATE roles SET name = ?, description = ?, sort = ? WHERE id = ?', [d.name, d.description, d.sort]);
      }
      case 'user': {
        const d = data as RecordDataMap['user'];
        const clash = this.db.prepare('SELECT id FROM users WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?) AND id IS NOT ?').get(d.firstName, d.lastName, id);
        if (clash) throw new Error(`Benutzer ${d.firstName} ${d.lastName} gibt es schon`);
        // Der letzte Admin mit PIN bleibt Admin (sonst sperrt die Cloud die Installation aus)
        const isAdmin = d.isAdmin || (id !== null && this.isLastAdmin(id));
        if (id === null)
          return Number(this.db.prepare("INSERT INTO users (first_name, last_name, pin_hash, is_admin, created_at, created_by) VALUES (?, ?, '', ?, ?, ?)").run(d.firstName, d.lastName, isAdmin ? 1 : 0, now, `Cloud (${item.nodeName})`).lastInsertRowid);
        this.db.prepare('UPDATE users SET first_name = ?, last_name = ?, is_admin = ? WHERE id = ?').run(d.firstName, d.lastName, isAdmin ? 1 : 0, id);
        return id;
      }
      case 'taskTemplate': {
        const d = data as RecordDataMap['taskTemplate'];
        const tpl = d.documentTemplateName ? (this.db.prepare('SELECT id FROM templates WHERE name = ? COLLATE NOCASE').get(d.documentTemplateName) as { id: number } | undefined) : undefined;
        return run(
          'INSERT INTO task_templates (summary, description, document_template_id, interval_minutes, offset_minutes, sort) VALUES (?, ?, ?, ?, ?, ?)',
          'UPDATE task_templates SET summary = ?, description = ?, document_template_id = ?, interval_minutes = ?, offset_minutes = ?, sort = ? WHERE id = ?',
          [d.summary, d.description, tpl?.id ?? null, d.intervalMinutes, d.intervalMinutes !== null ? (d.offsetMinutes ?? d.intervalMinutes) : d.offsetMinutes, d.sort],
        );
      }
      case 'objectType': {
        const d = data as RecordDataMap['objectType'];
        const params = [d.name, d.icon, d.color, JSON.stringify(d.fields), d.visibility, d.sort, now];
        if (id === null) {
          if (d.builtin && this.db.prepare('SELECT 1 FROM object_types WHERE builtin = ?').get(d.builtin)) throw new Error(`Vordefinierter Typ ${d.builtin} gibt es schon`);
          return Number(
            this.db
              .prepare('INSERT INTO object_types (uid, builtin, name, icon, color, fields, visibility, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(item.uid, d.builtin, ...params).lastInsertRowid,
          );
        }
        this.db.prepare('UPDATE object_types SET name = ?, icon = ?, color = ?, fields = ?, visibility = ?, sort = ?, updated_at = ?, deleted_at = NULL WHERE id = ?').run(...params, id);
        return id;
      }
      case 'object': {
        const d = data as RecordDataMap['object'];
        const typeId = this.idOf('objectType', d.typeUid);
        if (typeId === null) throw new Error('Objekttyp fehlt');
        const params = [typeId, d.name, d.lat, d.lon, d.address, d.notes, JSON.stringify(d.props), d.source, d.geometry ? JSON.stringify(d.geometry) : null, now, `Cloud (${item.updatedBy})`];
        return run(
          'INSERT INTO library_objects (uid, type_id, name, lat, lon, address, notes, props, source, geometry, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          'UPDATE library_objects SET type_id = ?, name = ?, lat = ?, lon = ?, address = ?, notes = ?, props = ?, source = ?, geometry = ?, updated_at = ?, updated_by = ? WHERE id = ?',
          id === null ? [item.uid, ...params] : params,
        );
      }
      case 'objectFile': {
        const d = data as RecordDataMap['objectFile'];
        const objectId = this.idOf('object', d.objectUid);
        if (objectId === null) throw new Error('Objekt fehlt');
        if (id !== null) return id; // Dateien sind unveränderlich
        // Inhalt holt der Durchlauf danach (fetchFiles)
        return Number(
          this.db
            .prepare('INSERT INTO library_files (uid, object_id, filename, mime_type, size_bytes, storage_name, sha256, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(item.uid, objectId, d.filename, d.mimeType, d.sizeBytes, randomUUID(), d.sha256, now, `Cloud (${item.updatedBy})`).lastInsertRowid,
        );
      }
    }
  }

  /** Verweise setzen (Untereinheiten, Rolle); false = etwas fehlt noch */
  private resolve(kind: RecordKind, id: number, data: unknown): boolean {
    if (kind === 'force') {
      const d = canon('force', data);
      this.db.prepare('DELETE FROM force_unit_members WHERE parent_id = ?').run(id);
      const add = this.db.prepare('INSERT OR IGNORE INTO force_unit_members (parent_id, child_id, role, sort) VALUES (?, ?, ?, ?)');
      let complete = true;
      d.members.forEach((m, i) => {
        const child = this.idOf('force', m.uid);
        if (child === null || child === id) complete = false;
        else add.run(id, child, m.role, i);
      });
      return complete;
    }
    if (kind === 'taskTemplate') {
      const d = canon('taskTemplate', data);
      const role = d.roleUid ? this.idOf('role', d.roleUid) : null;
      this.db.prepare('UPDATE task_templates SET role_id = ? WHERE id = ?').run(role, id);
      return !d.roleUid || role !== null;
    }
    return true;
  }

  private isLastAdmin(id: number): boolean {
    const admins = this.db.prepare("SELECT id FROM users WHERE is_admin = 1 AND pin_hash != ''").all() as { id: number }[];
    return admins.length === 1 && admins[0]!.id === id;
  }

  private label(kind: RecordKind, id: number): string {
    const r = this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as Row | undefined;
    if (!r) return String(id);
    const d = this.serialize(kind, r) as Record<string, unknown>;
    return kind === 'user' ? `${d.firstName as string} ${d.lastName as string}` : String(d.name ?? d.summary ?? id);
  }

  /** Inhalte von Dateien aus der Cloud holen, die hier noch fehlen (Prüfsumme muss stimmen) */
  private async fetchFiles(): Promise<boolean> {
    const own = this.state().nodeId;
    const rows = this.db
      .prepare('SELECT id, uid, storage_name, sha256, filename FROM library_files WHERE origin_node IS NOT NULL AND origin_node IS NOT ? AND deleted_at IS NULL')
      .all(own) as { id: number; uid: string; storage_name: string; sha256: string; filename: string }[];
    let got = false;
    for (const r of rows) {
      const path = join(this.opts.libraryDir, r.storage_name);
      if (existsSync(path)) continue;
      try {
        const bytes = await this.cloud.signedRaw('GET', `/v1/elws/me/cloud/files/${r.uid}`);
        if (createHash('sha256').update(bytes).digest('hex') !== r.sha256) throw new Error('Prüfsumme stimmt nicht');
        await writeFile(path, bytes);
        got = true;
      } catch (e) {
        this.conflict('objectFile', r.filename, `Datei nicht geladen: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return got;
  }

  // --- Senden ---

  private async push(): Promise<boolean> {
    const own = this.state().nodeId;
    if (!own) return false;
    const changes: SyncChange[] = [];
    const names = new Map<string, string>();
    this.db.transaction(() => {
      for (const kind of ORDER) {
        const table = TABLE[kind];
        // Vordefinierte Objekttypen gehören der Wurzel (Betreiber), nie einer Installation
        const local = this.rows(kind).filter((r) => (!r.origin_node || r.origin_node === own) && !(kind === 'objectType' && r.builtin));
        for (const r of local) {
          if (!r.uid) {
            const uid = randomUUID();
            this.db.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`).run(uid, r.id);
            r.uid = uid;
          }
        }
        for (const r of local) {
          let data: unknown;
          try {
            data = canon(kind, this.serialize(kind, r));
          } catch {
            continue; // lokal ungültig (z. B. zu lang für die Cloud) – bleibt lokal
          }
          const snap = this.db.prepare('SELECT rev, data FROM cloud_sync WHERE uid = ?').get(r.uid) as { rev: number; data: string } | undefined;
          if (snap && snap.data === stable(data)) continue;
          changes.push({ uid: r.uid!, kind, baseRev: snap?.rev ?? 0, data });
          names.set(r.uid!, this.label(kind, r.id));
        }
        // Lokal gelöscht: eigene Datensätze, die es nicht mehr gibt
        const gone = this.db
          .prepare(`SELECT s.uid, s.rev, s.data FROM cloud_sync s LEFT JOIN ${table} t ON t.uid = s.uid${LIBRARY.includes(kind) ? ' AND t.deleted_at IS NULL' : ''} WHERE s.kind = ? AND s.node_id = ? AND t.id IS NULL`)
          .all(kind, own) as { uid: string; rev: number; data: string }[];
        for (const g of gone) {
          changes.push({ uid: g.uid, kind, baseRev: g.rev, deleted: true });
          const d = JSON.parse(g.data) as Record<string, unknown>;
          names.set(g.uid, String(d.name ?? d.summary ?? `${String(d.firstName ?? '')} ${String(d.lastName ?? '')}`.trim()));
        }
      }
    })();
    if (!changes.length) return false;

    // Neue Dateien: erst den Inhalt hochladen, dann den Datensatz senden
    for (const c of changes.filter((x) => x.kind === 'objectFile' && x.baseRev === 0 && !x.deleted)) {
      const row = this.db.prepare('SELECT storage_name FROM library_files WHERE uid = ?').get(c.uid) as { storage_name: string } | undefined;
      if (!row) continue;
      try {
        await this.cloud.signedRaw('PUT', `/v1/elws/me/cloud/files/${c.uid}`, await readFile(join(this.opts.libraryDir, row.storage_name)));
      } catch (e) {
        // 409: schon hochgeladen (z. B. ein früherer Durchlauf brach danach ab)
        if (!(e instanceof Error && /schon/.test(e.message))) throw e;
      }
    }

    for (let i = 0; i < changes.length; i += SYNC_MAX_CHANGES) {
      const batch = changes.slice(i, i + SYNC_MAX_CHANGES);
      const { results } = await this.cloud.signed<{ results: SyncResult[] }>('POST', '/v1/elws/me/cloud/sync', { changes: batch });
      this.db.transaction(() => {
        for (const res of results) {
          const change = batch.find((c) => c.uid === res.uid)!;
          if (res.status === 'ok') {
            if (res.record.deleted) this.db.prepare('DELETE FROM cloud_sync WHERE uid = ?').run(res.uid);
            else {
              this.snapshot(res.record, false);
              this.db.prepare(`UPDATE ${TABLE[change.kind]} SET origin_node = ?, origin_name = ? WHERE uid = ?`).run(res.record.nodeId, res.record.nodeName, res.uid);
            }
          } else if (res.status === 'conflict') {
            // Cloud gewinnt
            this.conflict(change.kind, names.get(res.uid) ?? res.uid, `${res.reason} – Stand der Cloud übernommen`);
            if (res.record) this.applyAll([res.record]);
            else if (change.baseRev > 0) this.db.prepare('DELETE FROM cloud_sync WHERE uid = ?').run(res.uid);
          } else {
            this.conflict(change.kind, names.get(res.uid) ?? res.uid, `Von der Cloud abgelehnt: ${res.reason}`);
          }
        }
      })();
    }
    return true;
  }
}

