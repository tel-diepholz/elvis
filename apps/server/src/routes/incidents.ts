import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JOURNAL_CATEGORY_LABELS, mapObjectPatchSchema, newMapObjectSchema, type JournalCategory } from '@elvis/shared';
import { HttpError } from '../errors.js';
import type { IncidentService } from '../services/incidents.js';
import { idParam, operatorOf, parse } from './util.js';

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const text = (max: number) => z.string().trim().max(max);
const coord = (min: number, max: number) => z.number().min(min).max(max).nullable();

const newIncident = z.object({
  keyword: text(40).optional(),
  title: text(200).min(1, 'Bezeichnung fehlt'),
  location: text(200).optional(),
  leader: text(100).optional(),
  lat: coord(-90, 90).optional(),
  lon: coord(-180, 180).optional(),
});

const categories = Object.keys(JOURNAL_CATEGORY_LABELS) as [JournalCategory, ...JournalCategory[]];
const newJournal = z.object({
  category: z.enum(categories),
  text: text(4000).min(1, 'Text fehlt'),
  sender: text(100).optional(),
  recipient: text(100).optional(),
  important: z.boolean().optional(),
  correctsId: z.number().int().positive().nullable().optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
});

const strength = z.object({
  leaders: z.number().int().min(0).max(999),
  subLeaders: z.number().int().min(0).max(999),
  crew: z.number().int().min(0).max(9999),
});
const fmsStatus = z.number().int().min(0).max(9).nullable();
const newUnit = z.object({
  callsign: text(100).min(1, 'Funkrufname fehlt'),
  unitType: text(40).optional(),
  organization: text(100).optional(),
  strength: strength.optional(),
  section: text(100).optional(),
  fmsStatus: fmsStatus.optional(),
  notes: text(1000).optional(),
});
const unitPatch = newUnit.partial().extend({ released: z.boolean().optional() });

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

export function incidentRoutes(app: FastifyInstance, incidents: IncidentService): void {
  app.get('/api/incidents', async () => incidents.list());
  app.get('/api/incidents/active', async () => incidents.active());

  app.post('/api/incidents', async (req, reply) => {
    const created = incidents.start(parse(newIncident, req.body), operatorOf(req));
    return reply.code(201).send(created);
  });

  app.get('/api/incidents/:id', async (req) => incidents.get(parse(idParam, req.params).id));

  app.patch('/api/incidents/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return incidents.update(id, parse(newIncident.partial().extend({ vehicleVisible: z.boolean().optional() }), req.body), operatorOf(req));
  });

  app.post('/api/incidents/:id/close', async (req) => incidents.close(parse(idParam, req.params).id, operatorOf(req)));

  // Einsatztagebuch
  app.get('/api/incidents/:id/journal', async (req) => incidents.journal(parse(idParam, req.params).id));

  app.post('/api/incidents/:id/journal', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(incidents.addJournal(id, parse(newJournal, req.body), operatorOf(req)));
  });

  app.get('/api/incidents/:id/journal.csv', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const incident = incidents.get(id);
    const header = ['Nr', 'Zeit', 'Erfasst', 'Kategorie', 'Von', 'An', 'Text', 'Wichtig', 'Korrigiert Nr', 'Bearbeiter'];
    const rows = incidents.journal(id).map((e) =>
      [
        String(e.id),
        e.timestamp,
        e.recordedAt,
        JOURNAL_CATEGORY_LABELS[e.category],
        e.sender,
        e.recipient,
        e.text,
        e.important ? 'ja' : '',
        e.correctsId ? String(e.correctsId) : '',
        e.author,
      ].map(csvCell),
    );
    const csv = '﻿' + [header.map(csvCell), ...rows].map((r) => r.join(';')).join('\r\n');
    const name = `ETB_${incident.startedAt.slice(0, 10)}_${incident.id}.csv`;
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(csv);
  });

  // Kartenobjekte (Flächen können große Umrisse mitbringen)
  app.get('/api/incidents/:id/objects', async (req) => incidents.mapObjects(parse(idParam, req.params).id));

  app.post('/api/incidents/:id/objects', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(incidents.addMapObject(id, parse(newMapObjectSchema, req.body), operatorOf(req)));
  });

  app.patch('/api/map-objects/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return incidents.patchMapObject(id, parse(mapObjectPatchSchema, req.body), operatorOf(req));
  });

  app.delete('/api/map-objects/:id', async (req, reply) => {
    incidents.removeMapObject(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });

  // Kräfte
  app.get('/api/incidents/:id/units', async (req) => incidents.units(parse(idParam, req.params).id));

  app.post('/api/incidents/:id/units', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(incidents.addUnit(id, parse(newUnit, req.body), operatorOf(req)));
  });

  app.patch('/api/units/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return incidents.patchUnit(id, parse(unitPatch, req.body), operatorOf(req));
  });

  // Dokumente
  app.get('/api/incidents/:id/documents', async (req) => incidents.documents(parse(idParam, req.params).id));

  app.post('/api/incidents/:id/documents', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const file = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES } });
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt');
    const descField = file.fields.description;
    const description = descField && !Array.isArray(descField) && descField.type === 'field' ? String(descField.value).slice(0, 500) : '';
    const doc = await incidents.addDocument(
      id,
      { filename: file.filename, mimeType: file.mimetype, stream: file.file, description },
      operatorOf(req),
      MAX_DOCUMENT_BYTES,
    );
    if (file.file.truncated) throw new HttpError(413, 'Datei zu groß');
    return reply.code(201).send(doc);
  });

  app.get('/api/documents/:id/content', async (req, reply) => {
    const doc = incidents.document(parse(idParam, req.params).id);
    const query = req.query as { download?: string };
    const disposition = query.download ? 'attachment' : 'inline';
    return reply
      .header('content-type', doc.mimeType)
      .header('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
      .send(createReadStream(doc.path));
  });

  app.delete('/api/documents/:id', async (req, reply) => {
    await incidents.removeDocument(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });
}
