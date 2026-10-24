import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../errors.js';
import type { DocumentService } from '../services/documents.js';
import { writeStream } from '../services/files.js';
import type { OfficeService, WopiAccess } from '../services/office.js';
import type { TemplateService } from '../services/templates.js';
import { MAX_DOCUMENT_BYTES } from './documents.js';

/** Datei hinter einer WOPI-Kennung: d<id> = Einsatzdokument, t<id> = Vorlage */
interface WopiFile {
  name: string;
  path: string;
  size: number;
  version: string;
  modifiedAt: string;
  writable: boolean;
  save: (body: Buffer, by: string) => Promise<string>;
}

/**
 * WOPI-Host für Collabora Online (https://sdk.collaboraonline.com/docs/advanced_integration.html).
 * Der Office-Server ruft diese Endpunkte ohne Sitzungscookie auf; berechtigt ist er über das access_token,
 * das ELVIS beim Öffnen des Editors für genau eine Datei und einen Benutzer ausstellt (auth/access.ts: public).
 */
export function wopiRoutes(app: FastifyInstance, deps: { office: OfficeService; documents: DocumentService; templates: TemplateService }): void {
  const { office, documents, templates } = deps;

  const fileOf = (ref: string): WopiFile => {
    const m = /^([dt])(\d+)$/.exec(ref);
    if (!m) throw new HttpError(404, 'Unbekannte Datei');
    const id = Number(m[2]);
    if (m[1] === 'd') {
      const doc = documents.document(id);
      return {
        name: doc.filename,
        path: doc.path,
        size: doc.sizeBytes,
        version: String(doc.version),
        modifiedAt: doc.updatedAt,
        writable: documents.writable(doc),
        save: async (body, by) => (await documents.saveContent(id, body, by)).updatedAt,
      };
    }
    const t = templates.get(id);
    return {
      name: t.filename,
      path: t.path,
      size: t.sizeBytes,
      version: t.updatedAt,
      modifiedAt: t.updatedAt,
      writable: true,
      save: async (body, by) => {
        await writeStream(t.path, Readable.from([body]), MAX_DOCUMENT_BYTES);
        templates.saved(id, body.length, by);
        return templates.get(id).updatedAt;
      },
    };
  };

  const authorize = (req: FastifyRequest): { access: WopiAccess; file: WopiFile } => {
    const { ref } = req.params as { ref: string };
    const access = office.resolve((req.query as { access_token?: string }).access_token, ref);
    if (!access) throw new HttpError(401, 'Ungültiges oder abgelaufenes Zugriffstoken');
    return { access, file: fileOf(ref) };
  };

  app.register(async (wopi) => {
    // PutFile schickt den Dateiinhalt roh, mit beliebigem Content-Type
    wopi.removeAllContentTypeParsers();
    wopi.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_DOCUMENT_BYTES }, (_req, body, done) => done(null, body));

    // CheckFileInfo
    wopi.get('/api/wopi/files/:ref', async (req) => {
      const { access, file } = authorize(req);
      const canWrite = access.canWrite && file.writable;
      return {
        BaseFileName: file.name,
        Size: (await stat(file.path)).size,
        Version: file.version,
        LastModifiedTime: file.modifiedAt,
        OwnerId: 'elvis',
        UserId: String(access.userId),
        UserFriendlyName: access.userName,
        UserCanWrite: canWrite,
        ReadOnly: !canWrite,
        SupportsUpdate: true,
        SupportsLocks: false,
        // „Speichern unter“ würde neben ELVIS vorbei neue Dateien anlegen
        UserCanNotWriteRelative: true,
        PostMessageOrigin: access.origin,
        // Drucken/Exportieren meldet Collabora per postMessage (Download_As): ELVIS druckt dann über den Druckserver
        DownloadAsPostMessage: true,
      };
    });

    // GetFile
    wopi.get('/api/wopi/files/:ref/contents', async (req, reply) => {
      const { file } = authorize(req);
      return reply.header('content-type', 'application/octet-stream').send(createReadStream(file.path));
    });

    // PutFile
    wopi.post('/api/wopi/files/:ref/contents', async (req, reply) => {
      const { access, file } = authorize(req);
      if (!access.canWrite || !file.writable) throw new HttpError(403, 'Nur lesender Zugriff');
      // Wurde die Datei zwischenzeitlich anders geändert? Collabora fragt dann den Benutzer.
      const expected = req.headers['x-cool-wopi-timestamp'] ?? req.headers['x-lool-wopi-timestamp'];
      if (typeof expected === 'string' && expected && expected !== file.modifiedAt) return reply.code(409).send({ COOLStatusCode: 1010 });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return { LastModifiedTime: await file.save(body, access.userName) };
    });

    // Sperren u. Ä. (X-WOPI-Override) unterstützen wir nicht – SupportsLocks: false
    wopi.post('/api/wopi/files/:ref', async (req, reply) => {
      authorize(req);
      return reply.code(501).send();
    });
  });
}
