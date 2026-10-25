import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import {
  documentPatchSchema,
  folderSpecsSchema,
  fromTemplateSchema,
  newBlankDocumentSchema,
  newFolderSchema,
  templateFolderInputSchema,
  templateMetaSchema,
  type Topic,
} from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { DocumentService } from '../services/documents.js';
import type { OfficeService } from '../services/office.js';
import type { TemplateService } from '../services/templates.js';
import { actorOf, idParam, operatorOf, originOf, parse } from './util.js';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/** Formularfeld aus einem Multipart-Upload (Felder müssen vor der Datei stehen) */
function field(file: MultipartFile, name: string): string | undefined {
  const f = file.fields[name];
  return f && !Array.isArray(f) && f.type === 'field' ? String(f.value) : undefined;
}

function sendFile(reply: FastifyReply, req: FastifyRequest, f: { filename: string; mimeType: string; path: string }) {
  const disposition = (req.query as { download?: string }).download ? 'attachment' : 'inline';
  return reply
    .header('content-type', f.mimeType)
    .header('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
    .send(createReadStream(f.path));
}

const folderIdField = (v: string | undefined) => {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Ungültiger Ordner');
  return n;
};

export function documentRoutes(
  app: FastifyInstance,
  deps: { documents: DocumentService; templates: TemplateService; office: OfficeService; store: Store; notify: (t: Topic[]) => void },
): void {
  const { documents, templates, office } = deps;

  // --- Einsatzdokumente ---

  app.get('/api/incidents/:id/documents', async (req) => documents.listing(parse(idParam, req.params).id, req.user?.id ?? null));

  app.post('/api/incidents/:id/folders', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(documents.createFolder(id, parse(newFolderSchema, req.body), operatorOf(req)));
  });

  app.delete('/api/document-folders/:id', async (req, reply) => {
    documents.removeFolder(parse(idParam, req.params).id, actorOf(req));
    return reply.code(204).send();
  });

  app.post('/api/incidents/:id/documents', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const file = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES } });
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt');
    const doc = await documents.upload(
      id,
      folderIdField(field(file, 'folderId')),
      { filename: file.filename, mimeType: file.mimetype, stream: file.file, description: (field(file, 'description') ?? '').slice(0, 500) },
      actorOf(req),
      MAX_DOCUMENT_BYTES,
    );
    return reply.code(201).send(doc);
  });

  app.post('/api/incidents/:id/documents/blank', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(await documents.createBlank(id, parse(newBlankDocumentSchema, req.body), actorOf(req)));
  });

  app.post('/api/incidents/:id/documents/from-template', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(await documents.createFromTemplate(id, parse(fromTemplateSchema, req.body).templateId, actorOf(req)));
  });

  app.get('/api/documents/:id/content', async (req, reply) => {
    const doc = documents.visibleDocument(parse(idParam, req.params).id, req.user?.id ?? null);
    return sendFile(reply, req, doc);
  });

  app.patch('/api/documents/:id', async (req) => documents.patch(parse(idParam, req.params).id, parse(documentPatchSchema, req.body), actorOf(req)));

  app.delete('/api/documents/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await documents.remove(id, actorOf(req));
    office.revoke(`d${id}`);
    return reply.code(204).send();
  });

  // --- Bearbeitung im Office-Server ---

  app.get('/api/office', async () => office.status());

  app.post('/api/documents/:id/edit', async (req) => {
    const doc = documents.visibleDocument(parse(idParam, req.params).id, req.user?.id ?? null);
    const actor = actorOf(req);
    const session = await office.session(`d${doc.id}`, doc.filename, actor, documents.writable(doc), originOf(req));
    if (!session) throw new HttpError(503, 'Bearbeitung nicht verfügbar – Office-Server (Collabora) läuft nicht oder kennt das Format nicht');
    return session;
  });

  // --- Vorlagen ---

  app.get('/api/templates', async () => templates.tree());

  app.get('/api/templates/:id/content', async (req, reply) => sendFile(reply, req, templates.get(parse(idParam, req.params).id)));

  app.post('/api/templates', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES } });
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt');
    let meta;
    try {
      meta = parse(templateMetaSchema, JSON.parse(field(file, 'meta') ?? '{}'));
    } catch (e) {
      file.file.resume();
      throw e instanceof HttpError ? e : new HttpError(400, 'Ungültige Angaben zur Vorlage');
    }
    const t = await templates.create(meta, { filename: file.filename, mimeType: file.mimetype, stream: file.file }, operatorOf(req), MAX_DOCUMENT_BYTES);
    return reply.code(201).send(t);
  });

  app.put('/api/templates/:id', async (req) => templates.update(parse(idParam, req.params).id, parse(templateMetaSchema, req.body), operatorOf(req)));

  app.put('/api/templates/:id/file', async (req) => {
    const { id } = parse(idParam, req.params);
    const file = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES } });
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt');
    return templates.replaceFile(id, { filename: file.filename, mimeType: file.mimetype, stream: file.file }, operatorOf(req), MAX_DOCUMENT_BYTES);
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await templates.remove(id);
    office.revoke(`t${id}`);
    return reply.code(204).send();
  });

  app.post('/api/templates/:id/edit', async (req) => {
    const t = templates.get(parse(idParam, req.params).id);
    const session = await office.session(`t${t.id}`, t.filename, actorOf(req), true, originOf(req));
    if (!session) throw new HttpError(503, 'Bearbeitung nicht verfügbar – Office-Server (Collabora) läuft nicht oder kennt das Format nicht');
    return session;
  });

  app.post('/api/template-folders', async (req, reply) => reply.code(201).send(templates.createFolder(parse(templateFolderInputSchema, req.body))));

  app.put('/api/template-folders/:id', async (req) => templates.updateFolder(parse(idParam, req.params).id, parse(templateFolderInputSchema, req.body)));

  app.delete('/api/template-folders/:id', async (req, reply) => {
    templates.removeFolder(parse(idParam, req.params).id);
    return reply.code(204).send();
  });

  // --- Vorgabe der Ordnerstruktur (Einstellungen, nur Admins über /api/system/) ---

  app.get('/api/system/document-folders', async () => documents.folderSpec());

  app.put('/api/system/document-folders', async (req) => {
    const { folders } = parse(z.object({ folders: folderSpecsSchema }), req.body);
    const next = documents.setFolderSpec(folders, operatorOf(req));
    deps.store.addAudit({ operator: operatorOf(req), target: 'dokumente', action: 'ordnervorgabe', params: '', success: true, message: `${folders.length} Ordner auf oberster Ebene` });
    deps.notify(['audit', 'settings']);
    return next;
  });
}
