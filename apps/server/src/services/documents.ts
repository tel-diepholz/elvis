import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  BLANK_KINDS,
  DEFAULT_DOCUMENT_FOLDERS,
  documentPlaceholders,
  extensionOf,
  folderPath,
  folderSpecsSchema,
  renderPlaceholders,
  sanitizeName,
  type DocumentFolder,
  type DocumentListing,
  type DocumentPatch,
  type FolderSpec,
  type Incident,
  type IncidentDocument,
  type NewBlankDocument,
  type NewFolder,
  type Topic,
  type VehicleInfo,
} from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { blankDocument } from './blank.js';
import { writeStream } from './files.js';
import { fillDocument } from './office-fill.js';
import type { TemplateService } from './templates.js';

const FOLDERS_KEY = 'documents:folders';
/** Nie gespeicherte Entwürfe verfallen nach einem Tag */
const DRAFT_MAX_AGE_MS = 24 * 3600_000;

export interface Actor {
  id: number;
  name: string;
  isAdmin: boolean;
}

export type StoredDocument = IncidentDocument & { path: string };

/**
 * Dokumente eines Einsatzes in einer virtuellen Ordnerstruktur. Die Dateien liegen flach unter UUIDs; Ordner gibt es
 * nur in der Datenbank. Beim Eröffnen eines Einsatzes wird die Vorgabe aus den Einstellungen übernommen;
 * danach lassen sich Ordner ergänzen, aber nicht löschen (Admins: leere, selbst angelegte Ordner).
 */
export class DocumentService {
  readonly dir: string;

  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly deps: {
      templates: TemplateService;
      vehicle: () => VehicleInfo;
      notify: (topics: Topic[]) => void;
    },
  ) {
    this.dir = join(dataDir, 'documents');
    if (dataDir !== ':memory:') mkdirSync(this.dir, { recursive: true });
  }

  // --- Vorgabe der Ordnerstruktur ---

  folderSpec(): { folders: FolderSpec[]; updatedAt: string | null; updatedBy: string | null } {
    const r = this.store.db.prepare('SELECT * FROM settings WHERE key = ?').get(FOLDERS_KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
    const parsed = r ? folderSpecsSchema.safeParse(JSON.parse(r.value)) : null;
    return { folders: parsed?.success ? parsed.data : DEFAULT_DOCUMENT_FOLDERS, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
  }

  setFolderSpec(folders: FolderSpec[], actor: string): ReturnType<DocumentService['folderSpec']> {
    this.store.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(FOLDERS_KEY, JSON.stringify(folders), new Date().toISOString(), actor);
    return this.folderSpec();
  }

  /** Vorgabe in den Einsatz übernehmen (beim Eröffnen, innerhalb der Transaktion) */
  snapshotFolders(incidentId: number): void {
    const add = (specs: FolderSpec[], parentId: number | null) => {
      for (const s of specs) {
        const f = this.store.addFolder({ incidentId, parentId, name: s.name, system: true, createdBy: 'System' });
        add(s.children, f.id);
      }
    };
    add(this.folderSpec().folders, null);
  }

  // --- Ordner ---

  private incident(id: number): Incident {
    const incident = this.store.incident(id);
    if (!incident) throw new HttpError(404, `Einsatz ${id} nicht gefunden`);
    return incident;
  }

  private requireOpen(id: number): Incident {
    const incident = this.incident(id);
    if (incident.closedAt) throw new HttpError(409, 'Einsatz ist abgeschlossen und kann nicht mehr geändert werden');
    return incident;
  }

  private journal(incidentId: number, text: string, author: string): void {
    this.store.addJournal(incidentId, { category: 'system', text }, author);
  }

  private checkFolder(incidentId: number, folderId: number | null): DocumentFolder | null {
    if (folderId === null) return null;
    const f = this.store.folder(folderId);
    if (!f || f.incidentId !== incidentId) throw new HttpError(400, 'Ordner gehört nicht zu diesem Einsatz');
    return f;
  }

  private pathOf(incidentId: number, folderId: number | null): string {
    return folderPath(this.store.folders(incidentId), folderId);
  }

  listing(incidentId: number, viewerId: number | null): DocumentListing {
    this.incident(incidentId);
    return { folders: this.store.folders(incidentId), documents: this.store.documents(incidentId, viewerId) };
  }

  createFolder(incidentId: number, input: NewFolder, operator: string): DocumentFolder {
    this.requireOpen(incidentId);
    this.checkFolder(incidentId, input.parentId);
    if (this.store.findFolder(incidentId, input.parentId, input.name)) throw new HttpError(409, `Ordner „${input.name}“ gibt es hier schon`);
    const folder = this.store.transaction(() => {
      const f = this.store.addFolder({ incidentId, parentId: input.parentId, name: input.name, system: false, createdBy: operator });
      this.journal(incidentId, `Dokumentordner angelegt: ${this.pathOf(incidentId, f.id)}`, operator);
      return f;
    });
    this.deps.notify(['documents', 'journal']);
    return folder;
  }

  /** Nur Admins, nur leere und nicht aus der Vorgabe stammende Ordner (z. B. Tippfehler) */
  removeFolder(folderId: number, actor: Actor): void {
    const f = this.store.folder(folderId);
    if (!f) throw new HttpError(404, `Ordner ${folderId} nicht gefunden`);
    if (!actor.isAdmin) throw new HttpError(403, 'Ordner können nur Admins entfernen');
    this.requireOpen(f.incidentId);
    if (f.system) throw new HttpError(409, 'Ordner aus der Vorgabe können nicht entfernt werden');
    if (!this.store.folderEmpty(folderId)) throw new HttpError(409, 'Ordner ist nicht leer');
    const path = this.pathOf(f.incidentId, f.id);
    this.store.transaction(() => {
      this.store.removeFolder(folderId);
      this.journal(f.incidentId, `Dokumentordner entfernt: ${path}`, actor.name);
    });
    this.deps.notify(['documents', 'journal']);
  }

  /** Ordnerpfad „A/B/C“ auflösen; Fehlendes wird angelegt. Leerer Pfad = Wurzel. */
  ensurePath(incidentId: number, path: string, operator: string): number | null {
    let parentId: number | null = null;
    for (const raw of path.split('/')) {
      const name = sanitizeName(raw);
      if (!name) continue;
      const existing = this.store.findFolder(incidentId, parentId, name);
      parentId = existing ? existing.id : this.store.addFolder({ incidentId, parentId, name, system: false, createdBy: operator }).id;
    }
    return parentId;
  }

  // --- Dokumente ---

  document(docId: number): StoredDocument {
    const doc = this.store.document(docId);
    if (!doc) throw new HttpError(404, `Dokument ${docId} nicht gefunden`);
    const { storageName, ...rest } = doc;
    return { ...rest, path: join(this.dir, storageName) };
  }

  /** Entwürfe sieht nur, wer sie angelegt hat */
  visibleDocument(docId: number, viewerId: number | null): StoredDocument {
    const doc = this.document(docId);
    if (doc.draft && doc.createdByUserId !== viewerId) throw new HttpError(404, `Dokument ${docId} nicht gefunden`);
    return doc;
  }

  /** Freier Name im Ordner: „Bericht.docx“, „Bericht (2).docx“ … */
  private uniqueName(incidentId: number, folderId: number | null, filename: string, exceptId = 0): string {
    const ext = extensionOf(filename);
    const stem = ext ? filename.slice(0, -(ext.length + 1)) : filename;
    let name = filename;
    for (let n = 2; this.store.documentNameTaken(incidentId, folderId, name, exceptId); n++) name = `${stem} (${n})${ext ? `.${ext}` : ''}`;
    return name;
  }

  async upload(
    incidentId: number,
    folderId: number | null,
    file: { filename: string; mimeType: string; stream: Readable; description: string },
    actor: Actor,
    maxBytes: number,
  ): Promise<IncidentDocument> {
    this.requireOpen(incidentId);
    this.checkFolder(incidentId, folderId);
    const storageName = randomUUID();
    const path = join(this.dir, storageName);
    const size = await writeStream(path, file.stream, maxBytes);
    try {
      const doc = this.store.transaction(() => {
        const d = this.store.addDocument({
          incidentId,
          folderId,
          filename: this.uniqueName(incidentId, folderId, sanitizeName(file.filename) || 'Dokument'),
          storageName,
          mimeType: file.mimeType,
          sizeBytes: size,
          description: file.description,
          uploadedBy: actor.name,
          createdByUserId: actor.id,
        });
        this.journal(incidentId, `Dokument hinzugefügt: ${this.displayPath(d)}`, actor.name);
        return d;
      });
      this.deps.notify(['documents', 'journal']);
      return doc;
    } catch (err) {
      await unlink(path).catch(() => {});
      throw err;
    }
  }

  /**
   * Fertige Datei ablegen (z. B. einen Druck): Ordnerpfad mit Platzhaltern wie bei Vorlagen, fehlende Ordner werden
   * angelegt. Auch ohne angemeldeten Benutzer möglich.
   */
  async storeFile(
    incidentId: number,
    pathPattern: string,
    file: { filename: string; mimeType: string; content: Buffer; description: string },
    by: { id: number | null; name: string },
  ): Promise<{ documentId: number; path: string }> {
    const incident = this.requireOpen(incidentId);
    let path: string;
    try {
      path = renderPlaceholders(pathPattern, documentPlaceholders({ incident, vehicle: this.deps.vehicle(), userName: by.name, now: new Date() }));
    } catch (e) {
      throw new HttpError(400, `Ablageort: ${(e as Error).message}`);
    }
    const storageName = randomUUID();
    const target = join(this.dir, storageName);
    await writeFile(target, file.content);
    try {
      const doc = this.store.transaction(() => {
        const folderId = this.ensurePath(incidentId, path, by.name);
        const d = this.store.addDocument({
          incidentId,
          folderId,
          filename: this.uniqueName(incidentId, folderId, sanitizeName(file.filename) || 'Dokument'),
          storageName,
          mimeType: file.mimeType,
          sizeBytes: file.content.length,
          description: file.description.slice(0, 500),
          uploadedBy: by.name,
          createdByUserId: by.id,
        });
        this.journal(incidentId, `Dokument hinzugefügt: ${this.displayPath(d)}${file.description ? ` (${file.description})` : ''}`, by.name);
        return d;
      });
      this.deps.notify(['documents', 'journal']);
      return { documentId: doc.id, path: this.displayPath(doc) };
    } catch (err) {
      await unlink(target).catch(() => {});
      throw err;
    }
  }

  private displayPath(d: Pick<IncidentDocument, 'incidentId' | 'folderId' | 'filename'>): string {
    return [this.pathOf(d.incidentId, d.folderId), d.filename].filter(Boolean).join('/');
  }

  /** Neues Dokument als Entwurf anlegen; sichtbar für alle erst nach dem ersten Speichern */
  private async createDraft(
    incidentId: number,
    folderId: number | null,
    filename: string,
    mimeType: string,
    content: Uint8Array,
    actor: Actor,
    templateId: number | null,
  ): Promise<IncidentDocument> {
    const storageName = randomUUID();
    const path = join(this.dir, storageName);
    await writeFile(path, content);
    try {
      const doc = this.store.addDocument({
        incidentId,
        folderId,
        filename: this.uniqueName(incidentId, folderId, filename),
        storageName,
        mimeType,
        sizeBytes: content.length,
        description: '',
        uploadedBy: actor.name,
        createdByUserId: actor.id,
        templateId,
        draft: true,
      });
      this.deps.notify(['documents']);
      return doc;
    } catch (err) {
      await unlink(path).catch(() => {});
      throw err;
    }
  }

  async createBlank(incidentId: number, input: NewBlankDocument, actor: Actor): Promise<IncidentDocument> {
    this.requireOpen(incidentId);
    this.checkFolder(incidentId, input.folderId);
    const kind = BLANK_KINDS[input.kind];
    const stem = sanitizeName(input.name.replace(new RegExp(`\\.${kind.ext}$`, 'i'), '')) || kind.label;
    return this.createDraft(incidentId, input.folderId, `${stem}.${kind.ext}`, kind.mime, blankDocument(input.kind), actor, null);
  }

  /** Vorlage kopieren: Ablageort und Dateiname aus den Platzhaltern, auf Wunsch auch den Inhalt füllen */
  async createFromTemplate(incidentId: number, templateId: number, actor: Actor): Promise<IncidentDocument> {
    const incident = this.requireOpen(incidentId);
    const t = this.deps.templates.get(templateId);
    const ctx = { incident, vehicle: this.deps.vehicle(), userName: actor.name, now: new Date() };
    const render = (pattern: string, bags: ReturnType<typeof documentPlaceholders>, what: string) => {
      try {
        return renderPlaceholders(pattern, bags);
      } catch (e) {
        throw new HttpError(400, `Vorlage „${t.name}“, ${what}: ${(e as Error).message}`);
      }
    };
    const path = render(t.targetPath, documentPlaceholders(ctx), 'Ablageort');
    const folderId = this.store.transaction(() => this.ensurePath(incidentId, path, actor.name));
    const bags = documentPlaceholders(ctx, this.store.documentCount(incidentId, folderId) + 1);
    const ext = extensionOf(t.filename);
    const stem = sanitizeName(render(t.filenamePattern || t.name, bags, 'Dateiname')) || t.name;
    const filename = ext ? `${stem}.${ext}` : stem;
    let content: Uint8Array = await readFile(t.path);
    if (t.fillContent) content = fillDocument(content, t.filename, bags);
    return this.createDraft(incidentId, folderId, filename, t.mimeType, content, actor, t.id);
  }

  patch(docId: number, p: DocumentPatch, actor: Actor): IncidentDocument {
    const doc = this.visibleDocument(docId, actor.id);
    this.requireOpen(doc.incidentId);
    if (p.folderId !== undefined) this.checkFolder(doc.incidentId, p.folderId);
    const folderId = p.folderId !== undefined ? p.folderId : doc.folderId;
    let filename = p.filename !== undefined ? sanitizeName(p.filename) : doc.filename;
    if (!filename) throw new HttpError(400, 'Dateiname fehlt');
    // Endung beibehalten, damit das Dokument im richtigen Programm öffnet
    const ext = extensionOf(doc.filename);
    if (ext && extensionOf(filename) !== ext) filename = `${filename}.${ext}`;
    if (this.store.documentNameTaken(doc.incidentId, folderId, filename, doc.id)) throw new HttpError(409, `„${filename}“ gibt es in diesem Ordner schon`);
    const before = this.displayPath(doc);
    const after = this.store.transaction(() => {
      this.store.patchDocument(docId, { folderId, filename, description: p.description });
      const next = this.document(docId);
      const now = this.displayPath(next);
      if (!doc.draft && now !== before) this.journal(doc.incidentId, `Dokument verschoben/umbenannt: ${before} → ${now}`, actor.name);
      return next;
    });
    this.deps.notify(doc.draft ? ['documents'] : ['documents', 'journal']);
    const { path: _, ...rest } = after;
    return rest;
  }

  /** Entwürfe darf der Ersteller jederzeit verwerfen; sonst wie bisher mit Tagebucheintrag */
  async remove(docId: number, actor: Actor): Promise<void> {
    const doc = this.visibleDocument(docId, actor.id);
    if (doc.draft) {
      this.store.removeDocument(docId);
      await unlink(doc.path).catch(() => {});
      this.deps.notify(['documents']);
      return;
    }
    this.requireOpen(doc.incidentId);
    const path = this.displayPath(doc);
    this.store.transaction(() => {
      this.store.removeDocument(docId);
      this.journal(doc.incidentId, `Dokument entfernt: ${path}`, actor.name);
    });
    await unlink(doc.path).catch(() => {});
    this.deps.notify(['documents', 'journal']);
  }

  /** Darf der Inhalt noch geändert werden? (Office-Server: Schreibrecht) */
  writable(doc: IncidentDocument): boolean {
    return !this.incident(doc.incidentId).closedAt;
  }

  /** Neuer Inhalt aus dem Office-Server (WOPI PutFile) */
  async saveContent(docId: number, body: Buffer, by: string): Promise<IncidentDocument> {
    const doc = this.document(docId);
    this.requireOpen(doc.incidentId);
    await writeStream(doc.path, Readable.from([body]), Number.MAX_SAFE_INTEGER);
    const saved = this.store.transaction(() => {
      const d = this.store.savedDocument(docId, body.length, by);
      if (doc.draft) this.journal(doc.incidentId, `Dokument erstellt: ${this.displayPath(d)}`, by);
      return d;
    });
    this.deps.notify(doc.draft ? ['documents', 'journal'] : ['documents']);
    return saved;
  }

  /** Nie gespeicherte Entwürfe entfernen (beim Start) */
  async cleanupDrafts(now = Date.now()): Promise<number> {
    const stale = this.store.staleDrafts(new Date(now - DRAFT_MAX_AGE_MS).toISOString());
    for (const d of stale) {
      this.store.removeDocument(d.id);
      await unlink(join(this.dir, d.storageName)).catch(() => {});
    }
    return stale.length;
  }
}
