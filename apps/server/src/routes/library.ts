import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { libraryBboxSchema, libraryObjectInputSchema, objectTypeInputSchema, overpassBoundsSchema } from '@elvis/shared';
import { HttpError } from '../errors.js';
import type { LibraryService } from '../services/library.js';
import { MAX_DOCUMENT_BYTES, sendFile } from './documents.js';
import { idParam, operatorOf, parse } from './util.js';

const objectsQuery = z.object({
  bbox: libraryBboxSchema.optional(),
  /** Komma-getrennte Typ-IDs; leer = keine */
  types: z
    .string()
    .regex(/^(\d+(,\d+)*)?$/)
    .transform((v) => (v ? v.split(',').map(Number) : []))
    .optional(),
  q: z.string().max(100).optional(),
});

/**
 * Objektbibliothek: lesen auch ohne Anmeldung (wie die Karte), Objekte und Dateien pflegen alle Angemeldeten,
 * Typen nur Admins (/api/system/).
 */
export function libraryRoutes(app: FastifyInstance, library: LibraryService): void {
  app.get('/api/library/types', async () => library.types());
  app.get('/api/library/objects', async (req) => {
    const { bbox, types, q } = parse(objectsQuery, req.query);
    return library.objects({ bbox, typeIds: types, q });
  });
  app.get('/api/library/objects/:id', async (req) => library.object(parse(idParam, req.params).id));
  app.get('/api/library/files/:id/content', async (req, reply) => sendFile(reply, req, library.file(parse(idParam, req.params).id)));

  app.post('/api/library/objects', async (req, reply) => reply.code(201).send(library.createObject(parse(libraryObjectInputSchema, req.body), operatorOf(req))));
  app.put('/api/library/objects/:id', async (req) => library.updateObject(parse(idParam, req.params).id, parse(libraryObjectInputSchema, req.body), operatorOf(req)));
  app.delete('/api/library/objects/:id', async (req, reply) => {
    await library.removeObject(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });

  app.post('/api/library/objects/:id/files', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const file = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES } });
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt');
    return reply.code(201).send(await library.uploadFile(id, { filename: file.filename, mimeType: file.mimetype, stream: file.file }, operatorOf(req), MAX_DOCUMENT_BYTES));
  });
  app.delete('/api/library/files/:id', async (req, reply) => {
    await library.removeFile(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });

  app.post('/api/library/import/osm-water', async (req) => library.importOsmWater(parse(z.object({ bounds: overpassBoundsSchema }), req.body).bounds, operatorOf(req)));

  // --- Typen (Admins) ---
  app.post('/api/system/library/types', async (req, reply) => reply.code(201).send(library.createType(parse(objectTypeInputSchema, req.body), operatorOf(req))));
  app.put('/api/system/library/types/order', async (req) => library.reorderTypes(parse(z.object({ ids: z.array(z.number().int().positive()).max(200) }), req.body).ids, operatorOf(req)));
  app.put('/api/system/library/types/:id', async (req) => library.updateType(parse(idParam, req.params).id, parse(objectTypeInputSchema, req.body), operatorOf(req)));
  app.delete('/api/system/library/types/:id', async (req, reply) => {
    library.removeType(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });
}
