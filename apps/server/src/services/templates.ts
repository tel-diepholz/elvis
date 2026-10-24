import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { DocumentTemplate, TemplateFolder, TemplateFolderInput, TemplateMeta, TemplateTree, Topic } from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { writeStream } from './files.js';

type Row = Record<string, unknown>;

const toFolder = (r: Row): TemplateFolder => ({ id: r.id as number, parentId: (r.parent_id as number | null) ?? null, name: r.name as string });

const toTemplate = (r: Row): DocumentTemplate & { storageName: string } => ({
  id: r.id as number,
  folderId: (r.folder_id as number | null) ?? null,
  name: r.name as string,
  description: r.description as string,
  filename: r.filename as string,
  storageName: r.storage_name as string,
  mimeType: r.mime_type as string,
  sizeBytes: r.size_bytes as number,
  targetPath: r.target_path as string,
  filenamePattern: r.filename_pattern as string,
  fillContent: r.fill_content === 1,
  updatedAt: r.updated_at as string,
  updatedBy: r.updated_by as string,
});

const strip = ({ storageName: _, ...t }: DocumentTemplate & { storageName: string }): DocumentTemplate => t;

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';

/** Dokumentvorlagen in einem Ordnerbaum. Pflege nur durch Admins, lesen dürfen alle Angemeldeten. */
export class TemplateService {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly notify: (topics: Topic[]) => void,
  ) {
    this.dir = join(dataDir, 'templates');
    if (dataDir !== ':memory:') mkdirSync(this.dir, { recursive: true });
  }

  tree(): TemplateTree {
    return {
      folders: (this.db.prepare('SELECT * FROM template_folders ORDER BY name COLLATE NOCASE').all() as Row[]).map(toFolder),
      templates: (this.db.prepare('SELECT * FROM templates ORDER BY name COLLATE NOCASE').all() as Row[]).map(toTemplate).map(strip),
    };
  }

  get(id: number): DocumentTemplate & { storageName: string; path: string } {
    const r = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, `Vorlage ${id} nicht gefunden`);
    const t = toTemplate(r);
    return { ...t, path: join(this.dir, t.storageName) };
  }

  private folder(id: number): TemplateFolder {
    const r = this.db.prepare('SELECT * FROM template_folders WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, `Vorlagenordner ${id} nicht gefunden`);
    return toFolder(r);
  }

  private checkParent(parentId: number | null, selfId?: number): void {
    // Ordner nicht in sich selbst oder einen eigenen Unterordner verschieben
    for (let id = parentId; id !== null; id = this.folder(id).parentId) {
      if (id === selfId) throw new HttpError(400, 'Ein Ordner kann nicht in sich selbst liegen');
    }
  }

  createFolder(input: TemplateFolderInput): TemplateFolder {
    this.checkParent(input.parentId);
    try {
      const info = this.db.prepare('INSERT INTO template_folders (parent_id, name) VALUES (?, ?)').run(input.parentId, input.name);
      this.notify(['templates']);
      return this.folder(Number(info.lastInsertRowid));
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `Ordner „${input.name}“ gibt es hier schon`);
      throw e;
    }
  }

  updateFolder(id: number, input: TemplateFolderInput): TemplateFolder {
    this.folder(id);
    this.checkParent(input.parentId, id);
    try {
      this.db.prepare('UPDATE template_folders SET parent_id = ?, name = ? WHERE id = ?').run(input.parentId, input.name, id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `Ordner „${input.name}“ gibt es hier schon`);
      throw e;
    }
    this.notify(['templates']);
    return this.folder(id);
  }

  removeFolder(id: number): void {
    this.folder(id);
    const used =
      this.db.prepare('SELECT 1 FROM template_folders WHERE parent_id = ?').get(id) || this.db.prepare('SELECT 1 FROM templates WHERE folder_id = ?').get(id);
    if (used) throw new HttpError(409, 'Ordner ist nicht leer');
    this.db.prepare('DELETE FROM template_folders WHERE id = ?').run(id);
    this.notify(['templates']);
  }

  /** Neue Vorlage hochladen */
  async create(meta: TemplateMeta, file: { filename: string; mimeType: string; stream: Readable }, actor: string, maxBytes: number): Promise<DocumentTemplate> {
    if (meta.folderId !== null) this.folder(meta.folderId);
    const storageName = randomUUID();
    const size = await writeStream(join(this.dir, storageName), file.stream, maxBytes);
    const info = this.db
      .prepare(
        `INSERT INTO templates (folder_id, name, description, filename, storage_name, mime_type, size_bytes, target_path, filename_pattern, fill_content, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(meta.folderId, meta.name, meta.description, file.filename, storageName, file.mimeType, size, meta.targetPath, meta.filenamePattern, meta.fillContent ? 1 : 0, new Date().toISOString(), actor);
    this.notify(['templates']);
    return strip(this.get(Number(info.lastInsertRowid)));
  }

  update(id: number, meta: TemplateMeta, actor: string): DocumentTemplate {
    this.get(id);
    if (meta.folderId !== null) this.folder(meta.folderId);
    this.db
      .prepare('UPDATE templates SET folder_id = ?, name = ?, description = ?, target_path = ?, filename_pattern = ?, fill_content = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(meta.folderId, meta.name, meta.description, meta.targetPath, meta.filenamePattern, meta.fillContent ? 1 : 0, new Date().toISOString(), actor, id);
    this.notify(['templates']);
    return strip(this.get(id));
  }

  /** Datei der Vorlage ersetzen (neu hochladen) */
  async replaceFile(id: number, file: { filename: string; mimeType: string; stream: Readable }, actor: string, maxBytes: number): Promise<DocumentTemplate> {
    const t = this.get(id);
    const size = await writeStream(t.path, file.stream, maxBytes);
    this.db
      .prepare('UPDATE templates SET filename = ?, mime_type = ?, size_bytes = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(file.filename, file.mimeType, size, new Date().toISOString(), actor, id);
    this.notify(['templates']);
    return strip(this.get(id));
  }

  /** Gespeichert aus dem Office-Server */
  saved(id: number, size: number, actor: string): void {
    this.db.prepare('UPDATE templates SET size_bytes = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(size, new Date().toISOString(), actor, id);
    this.notify(['templates']);
  }

  async remove(id: number): Promise<void> {
    const t = this.get(id);
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
    await unlink(t.path).catch(() => {});
    this.notify(['templates']);
  }
}
