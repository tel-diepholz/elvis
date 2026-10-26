import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FORCE_IMPORT_MAX_BYTES,
  JOURNAL_CATEGORY_LABELS,
  deployUnitSchema,
  forceImportSchema,
  forceUnitInputSchema,
  mapObjectPatchSchema,
  newMapObjectSchema,
  newUnitSchema,
  overpassQuerySchema,
  unitPatchSchema,
  type ForceImportPreview,
  type ForceImportResult,
  type JournalCategory,
  type Topic,
} from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { importTemplate, parseImport } from '../services/forceImport.js';
import type { ForceService } from '../services/forces.js';
import type { IncidentService } from '../services/incidents.js';
import { idParam, operatorOf, parse } from './util.js';

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

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

export function incidentRoutes(
  app: FastifyInstance,
  { incidents, forces, store, notify }: { incidents: IncidentService; forces: ForceService; store: Store; notify: (t: Topic[]) => void },
): void {
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

  // Gespeicherte Overpass-Abfragen
  app.get('/api/incidents/:id/overpass-queries', async (req) => incidents.overpassQueries(parse(idParam, req.params).id));

  app.post('/api/incidents/:id/overpass-queries', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(incidents.addOverpassQuery(id, parse(overpassQuerySchema, req.body), operatorOf(req)));
  });

  app.put('/api/overpass-queries/:id', async (req) => incidents.saveOverpassQuery(parse(idParam, req.params).id, parse(overpassQuerySchema, req.body)));

  app.delete('/api/overpass-queries/:id', async (req, reply) => {
    incidents.removeOverpassQuery(parse(idParam, req.params).id);
    return reply.code(204).send();
  });

  // Kräfte
  app.get('/api/incidents/:id/units', async (req) => incidents.units(parse(idParam, req.params).id));

  app.post('/api/incidents/:id/units', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(incidents.addUnit(id, parse(newUnitSchema, req.body), operatorOf(req)));
  });

  app.post('/api/incidents/:id/units/deploy', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(incidents.deploy(id, parse(deployUnitSchema, req.body), operatorOf(req)));
  });

  app.get('/api/units/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const unit = store.unit(id);
    if (!unit) throw new HttpError(404, `Einheit ${id} nicht gefunden`);
    return unit;
  });

  app.patch('/api/units/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return incidents.patchUnit(id, parse(unitPatchSchema, req.body), operatorOf(req));
  });

  // Kräfteverwaltung: lesen alle (Übernahme in den Einsatz), pflegen Admins (/api/system/)
  const audit = (operator: string, action: string, message: string) => {
    store.addAudit({ operator, target: 'kräfte', action, params: '', success: true, message });
    notify(['forces', 'audit']);
  };

  app.get('/api/forces', async () => forces.list());

  app.post('/api/system/forces', async (req, reply) => {
    const created = forces.create(parse(forceUnitInputSchema, req.body));
    audit(operatorOf(req), 'create', created.name);
    return reply.code(201).send(created);
  });

  app.put('/api/system/forces/:id', async (req) => {
    const updated = forces.update(parse(idParam, req.params).id, parse(forceUnitInputSchema, req.body));
    audit(operatorOf(req), 'update', updated.name);
    return updated;
  });

  app.delete('/api/system/forces/:id', async (req, reply) => {
    const removed = forces.remove(parse(idParam, req.params).id);
    audit(operatorOf(req), 'delete', removed.name);
    notify(['units']);
    return reply.code(204).send();
  });

  // Import aus CSV/Excel: erst Vorschau (Datei), dann die geprüften Zeilen übernehmen
  app.get('/api/system/forces/import/template', async (_req, reply) =>
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="kraefte-vorlage.csv"').send(importTemplate()),
  );

  app.post('/api/system/forces/import/preview', async (req): Promise<ForceImportPreview> => {
    const file = await req.file({ limits: { fileSize: FORCE_IMPORT_MAX_BYTES } });
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt');
    let content: Buffer;
    try {
      content = await file.toBuffer();
    } catch {
      throw new HttpError(413, `Datei größer als ${FORCE_IMPORT_MAX_BYTES / 1024 / 1024} MB`);
    }
    const parsed = parseImport(file.filename, content);
    return { columns: parsed.columns, ignored: parsed.ignored, rows: forces.planImport(parsed.rows, true) };
  });

  app.post('/api/system/forces/import', async (req): Promise<ForceImportResult> => {
    const { rows, updateExisting } = parse(forceImportSchema, req.body);
    const result = forces.importRows(rows, updateExisting);
    audit(operatorOf(req), 'import', `${result.created} neu, ${result.updated} aktualisiert, ${result.skipped} übersprungen, ${result.linked} zugeordnet`);
    return result;
  });

  /** Im Einsatz erfasste Einheit als Systemeinheit übernehmen */
  app.post('/api/system/forces/adopt/:id', async (req, reply) => {
    const adopted = forces.adopt(parse(idParam, req.params).id);
    audit(operatorOf(req), 'adopt', adopted.name);
    notify(['units']);
    return reply.code(201).send(adopted);
  });
}
