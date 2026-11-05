import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_UNIT_SIGN,
  RECORD_KINDS,
  RECORD_SCHEMAS,
  tacticalSignSchema,
  type CloudSyncStatus,
  type RecordDataMap,
  type RecordKind,
  type SyncPull,
  type SyncRecord,
  type Topic,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import type { CloudService } from './cloud.js';

/**
 * Stammdaten aus der Cloud (Kräfte, Einsatzstichworte, Rollen, Benutzer, Aufgabenvorlagen, Objektbibliothek).
 *
 * - **Nur abholen:** Solange die Installation verknüpft ist, holt ELVIS jede Minute die Änderungen ab dem Cursor und
 *   übernimmt sie in die lokalen Tabellen (Herkunft = Knoten). Diese Datensätze zeigt ELVIS mit „Quelle: Cloud“; sie
 *   sind hier nur lesbar, gepflegt werden sie im Portal.
 * - **Lokale Datensätze bleiben lokal:** Sie gehen nie in die Cloud und werden nicht mit Cloud-Datensätzen
 *   zusammengeführt (gleichnamige stehen nebeneinander; Rollen und Benutzer haben eindeutige Namen – dort bleibt der
 *   lokale und der aus der Cloud steht als Hinweis da).
 * - **Getrennt:** Die Cloud-Datensätze bleiben als lokale (änderbare) stehen.
 *
 * Laufende Lagen bleiben unberührt: Sie arbeiten mit Kopien (units, tasks).
 */

const STATE_KEY = 'cloud:sync';
const INTERVAL_MS = 60_000;
const MAX_NOTICES = 20;

interface SyncState {
  cursor: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  notices: CloudSyncStatus['notices'];
}

const EMPTY: SyncState = { cursor: 0, lastRunAt: null, lastSuccessAt: null, lastError: null, notices: [] };

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
/** Reihenfolge beim Übernehmen: Verweise zuerst */
const ORDER: RecordKind[] = ['role', 'keyword', 'user', 'force', 'taskTemplate', 'objectType', 'object', 'objectFile'];
const TOPICS: Topic[] = ['forces', 'roles', 'users', 'taskTemplates', 'settings', 'tasks', 'library', 'cloud'];

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
    cloud.onLink(() => void this.run().catch(() => undefined));
  }

  // --- Zustand ---

  private state(): SyncState {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
    return r ? { ...EMPTY, ...(JSON.parse(r.value) as Partial<SyncState>) } : EMPTY;
  }

  private save(patch: Partial<SyncState>): SyncState {
    const s = this.state();
    const next: SyncState = { cursor: s.cursor, lastRunAt: s.lastRunAt, lastSuccessAt: s.lastSuccessAt, lastError: s.lastError, notices: s.notices, ...patch };
    this.db
      .prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(STATE_KEY, JSON.stringify(next), new Date().toISOString());
    return next;
  }

  status(): CloudSyncStatus {
    const s = this.state();
    const counts = Object.fromEntries(
      RECORD_KINDS.map((k) => {
        const rows = this.db.prepare(`SELECT origin_node FROM ${TABLE[k]}${live(k)}`).all() as { origin_node: string | null }[];
        return [k, { cloud: rows.filter((r) => r.origin_node).length, local: rows.filter((r) => !r.origin_node).length }];
      }),
    ) as CloudSyncStatus['counts'];
    return { active: this.cloud.linked(), running: this.running !== null, lastRunAt: s.lastRunAt, lastSuccessAt: s.lastSuccessAt, lastError: s.lastError, counts, notices: s.notices };
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

  /** Alles neu abholen (Cursor auf 0), z. B. nachdem ein gleichnamiger lokaler Datensatz entfernt wurde */
  async resync(operator: string): Promise<CloudSyncStatus> {
    this.save({ cursor: 0, notices: [] });
    this.store.addAudit({ operator, target: 'cloud', action: 'resync', params: '', success: true, message: 'Stammdaten aus der Cloud neu abgeholt' });
    this.opts.notify(['audit', 'cloud']);
    await this.run();
    return this.status();
  }

  /** Getrennt: Cloud-Datensätze bleiben als lokale stehen */
  private detach(): void {
    this.db.transaction(() => {
      // Herkunft (osm:…) ist unter lokalen Objekten eindeutig: gibt es sie lokal oder bei einem früheren Cloud-Objekt schon,
      // verliert das bisherige Cloud-Objekt sie
      this.db
        .prepare(
          `UPDATE library_objects SET source = NULL WHERE origin_node IS NOT NULL AND source IS NOT NULL AND (
             source IN (SELECT source FROM library_objects WHERE origin_node IS NULL AND source IS NOT NULL AND deleted_at IS NULL)
             OR EXISTS (SELECT 1 FROM library_objects o WHERE o.source = library_objects.source AND o.origin_node IS NOT NULL AND o.deleted_at IS NULL AND o.id < library_objects.id))`,
        )
        .run();
      for (const t of Object.values(TABLE)) this.db.prepare(`UPDATE ${t} SET origin_node = NULL, origin_name = NULL WHERE origin_node IS NOT NULL`).run();
      this.db.prepare('DELETE FROM cloud_sync').run();
    })();
    this.save({ ...EMPTY });
    this.opts.notify(TOPICS);
  }

  /** Hinweis für die Oberfläche und das Bedienprotokoll (gleiche nur einmal je Stunde) */
  private notice(kind: RecordKind, name: string, reason: string): void {
    const s = this.state();
    if (s.notices.some((c) => c.kind === kind && c.name === name && c.reason === reason && Date.now() - new Date(c.at).getTime() < 3600_000)) return;
    this.save({ notices: [{ at: new Date().toISOString(), kind, name, reason }, ...s.notices].slice(0, MAX_NOTICES) });
    this.store.addAudit({ operator: 'Cloud', target: 'cloud', action: 'notice', params: kind, success: false, message: `${name}: ${reason}` });
  }

  /** Ein Durchlauf (nur verknüpft). Gleichzeitige Aufrufe teilen sich den laufenden. */
  run(): Promise<void> {
    if (!this.cloud.linked()) return Promise.resolve();
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
        if (res.items.length) {
          this.db.transaction(() => this.applyAll(res.items))();
          changed = true;
        }
        this.save({ cursor: res.next });
        if (!res.more) break;
      }
      for (const path of this.unlinkLater.splice(0)) await unlink(path).catch(() => {});
      if (await this.fetchFiles()) changed = true;
      this.save({ lastRunAt: at, lastSuccessAt: at, lastError: null });
      if (changed) this.opts.notify(TOPICS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.save({ lastRunAt: at, lastError: msg });
      this.opts.log?.warn({ err: msg }, 'Stammdaten aus der Cloud nicht abgeholt');
      this.opts.notify(['cloud']);
    }
  }

  // --- Übernehmen ---

  /** Lokale ID eines Cloud-Datensatzes (lokale Datensätze haben keine Herkunft und werden nie getroffen) */
  private idOf(kind: RecordKind, uid: string): number | null {
    const row = this.db.prepare(`SELECT id FROM ${TABLE[kind]} WHERE uid = ? AND origin_node IS NOT NULL${LIBRARY.includes(kind) ? ' AND deleted_at IS NULL' : ''}`).get(uid) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  private applyAll(items: SyncRecord[]): void {
    const sorted = [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.seq - b.seq);
    for (const item of sorted) {
      try {
        this.apply(item);
      } catch (e) {
        const d = (item.data ?? {}) as Record<string, unknown>;
        const name = d.firstName ? `${String(d.firstName)} ${String(d.lastName ?? '')}`.trim() : String(d.name ?? d.summary ?? item.uid);
        this.notice(item.kind, name, `Nicht übernommen: ${e instanceof Error ? e.message : String(e)}`);
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
      .run(item.uid, item.kind, item.rev, item.nodeId, JSON.stringify(item.data), unresolved ? 1 : 0);
  }

  /** Bleibt lokal: Herkunft weg, damit er hier wieder änderbar ist */
  private keepLocal(kind: RecordKind, id: number, uid: string): void {
    this.db.prepare(`UPDATE ${TABLE[kind]} SET origin_node = NULL, origin_name = NULL WHERE id = ?`).run(id);
    this.db.prepare('DELETE FROM cloud_sync WHERE uid = ?').run(uid);
  }

  private apply(item: SyncRecord): void {
    const kind = item.kind;
    const table = TABLE[kind];
    const known = this.db.prepare('SELECT rev FROM cloud_sync WHERE uid = ?').get(item.uid) as { rev: number } | undefined;
    if (known && known.rev >= item.rev) return;
    let id = this.idOf(kind, item.uid);

    if (item.deleted || !item.data) {
      this.db.prepare('DELETE FROM cloud_sync WHERE uid = ?').run(item.uid);
      if (id === null) return;
      if (kind === 'user' && this.isLastAdmin(id)) {
        this.keepLocal(kind, id, item.uid);
        return this.notice(kind, this.label(kind, id), 'In der Cloud gelöscht – bleibt als letzter Admin mit PIN lokal');
      }
      if (kind === 'objectType' && this.db.prepare('SELECT 1 FROM library_objects WHERE type_id = ? AND deleted_at IS NULL').get(id)) {
        this.keepLocal(kind, id, item.uid);
        return this.notice(kind, this.label(kind, id), 'In der Cloud gelöscht – Typ hat hier noch Objekte und bleibt lokal');
      }
      if (kind === 'object' || kind === 'objectFile') {
        const files = this.db.prepare(`SELECT storage_name FROM library_files WHERE ${kind === 'object' ? 'object_id' : 'id'} = ?`).all(id) as { storage_name: string }[];
        for (const f of files) this.unlinkLater.push(join(this.opts.libraryDir, f.storage_name));
      }
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      return;
    }

    const data = canon(kind, item.data);
    // Vordefinierte Objekttypen haben überall dieselbe uid: der lokale wird zum Cloud-Typ (einmalig, nicht doppelt)
    if (id === null && kind === 'objectType') id = (this.db.prepare('SELECT id FROM object_types WHERE uid = ? AND builtin IS NOT NULL').get(item.uid) as { id: number } | undefined)?.id ?? null;
    // Lokaler Datensatz mit derselben uid (früher hochgeladen und danach getrennt): bleibt lokal, der aus der Cloud kommt dazu
    if (id === null) this.db.prepare(`UPDATE ${table} SET uid = ? WHERE uid = ? AND origin_node IS NULL`).run(randomUUID(), item.uid);
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
        if (this.db.prepare('SELECT 1 FROM roles WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(d.name, id)) throw new Error(`Rolle „${d.name}“ gibt es hier schon (lokal umbenennen oder löschen, dann neu abholen)`);
        return run('INSERT INTO roles (name, description, sort) VALUES (?, ?, ?)', 'UPDATE roles SET name = ?, description = ?, sort = ? WHERE id = ?', [d.name, d.description, d.sort]);
      }
      case 'user': {
        const d = data as RecordDataMap['user'];
        if (this.db.prepare('SELECT 1 FROM users WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?) AND id IS NOT ?').get(d.firstName, d.lastName, id))
          throw new Error(`Benutzer ${d.firstName} ${d.lastName} gibt es hier schon (lokal löschen, dann neu abholen)`);
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
          // Herkunft gleich mit: lokal ist source eindeutig (Index), Cloud-Objekte dürfen dieselbe haben
          'INSERT INTO library_objects (uid, origin_node, origin_name, type_id, name, lat, lon, address, notes, props, source, geometry, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          'UPDATE library_objects SET type_id = ?, name = ?, lat = ?, lon = ?, address = ?, notes = ?, props = ?, source = ?, geometry = ?, updated_at = ?, updated_by = ? WHERE id = ?',
          id === null ? [item.uid, item.nodeId, item.nodeName, ...params] : params,
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
    const r = this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return String(id);
    if (kind === 'user') return `${String(r.first_name)} ${String(r.last_name)}`;
    return String(r.name ?? r.summary ?? r.filename ?? id);
  }

  /** Inhalte von Dateien aus der Cloud holen, die hier noch fehlen (Prüfsumme muss stimmen) */
  private async fetchFiles(): Promise<boolean> {
    const rows = this.db
      .prepare('SELECT id, uid, storage_name, sha256, filename FROM library_files WHERE origin_node IS NOT NULL AND deleted_at IS NULL')
      .all() as { id: number; uid: string; storage_name: string; sha256: string; filename: string }[];
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
        this.notice('objectFile', r.filename, `Datei nicht geladen: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return got;
  }
}
