import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { extensionOf, printOptionsSchema, printSettingsInputSchema, sanitizeName, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { OfficeService } from '../services/office.js';
import type { PrintService } from '../services/printing.js';
import { operatorOf, parse } from './util.js';

export const MAX_PRINT_BYTES = 50 * 1024 * 1024;

/** Lädt eine Datei vom Office-Server (PDF zum Drucken aus Collabora) */
export type OfficeDownload = (url: string, maxBytes: number) => Promise<Buffer>;

const defaultDownload: OfficeDownload = async (url, maxBytes) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('Datei zu groß');
  return buf;
};

const officePrintSchema = z.object({
  url: z.string().url().max(4000),
  filename: z.string().trim().min(1).max(200),
  options: printOptionsSchema,
});

export function printingRoutes(
  app: FastifyInstance,
  deps: { printing: PrintService; office: OfficeService; store: Store; notify: (t: Topic[]) => void; download?: OfficeDownload },
): void {
  const { printing } = deps;

  // --- Drucken (auch anonym) ---

  app.get('/api/printing', async () => printing.status());

  /** Multipart: Feld „options“ (JSON) vor der Datei */
  app.post('/api/printing/jobs', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_PRINT_BYTES } });
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt');
    const raw = file.fields.options;
    let options;
    try {
      options = parse(printOptionsSchema, JSON.parse(raw && !Array.isArray(raw) && raw.type === 'field' ? String(raw.value) : '{}'));
    } catch (e) {
      file.file.resume();
      throw e instanceof HttpError ? e : new HttpError(400, 'Ungültige Druckeinstellungen');
    }
    let content: Buffer;
    try {
      content = await file.toBuffer();
    } catch {
      throw new HttpError(413, `Datei größer als ${MAX_PRINT_BYTES / 1024 / 1024} MB`);
    }
    const job = await printing.print({ filename: file.filename || 'Dokument.pdf', content }, options, { userId: req.user?.id ?? null, name: operatorOf(req) });
    return reply.code(201).send(job);
  });

  /**
   * Druck aus Collabora: Der Editor meldet „Download_As“ (Type print) mit der Adresse des PDFs auf dem Office-Server.
   * ELVIS lädt es dort selbst – nur vom laufenden Office-Server, nicht von beliebigen Adressen.
   */
  app.post('/api/printing/office', async (req, reply) => {
    const body = parse(officePrintSchema, req.body);
    const office = deps.office.url();
    if (!office) throw new HttpError(503, 'Office-Server (Collabora) läuft nicht');
    if (new URL(body.url).origin !== new URL(office).origin) throw new HttpError(400, 'Adresse gehört nicht zum Office-Server');
    let content: Buffer;
    try {
      content = await (deps.download ?? defaultDownload)(body.url, MAX_PRINT_BYTES);
    } catch (e) {
      throw new HttpError(502, `PDF konnte nicht vom Office-Server geladen werden: ${(e as Error).message}`);
    }
    const name = sanitizeName(body.filename) || 'Dokument';
    const ext = extensionOf(name);
    const filename = `${ext ? name.slice(0, -(ext.length + 1)) : name}.pdf`;
    const job = await printing.print({ filename, content }, body.options, { userId: req.user?.id ?? null, name: operatorOf(req) });
    return reply.code(201).send(job);
  });

  app.get('/api/printing/jobs/:ref', async (req) => printing.job(parse(z.object({ ref: z.string().regex(/^[\w-]{8,40}$/) }), req.params).ref));

  // --- Einstellungen (nur Admins über /api/system/) ---

  app.get('/api/system/printing', async () => ({ settings: printing.settings(), jobs: printing.recent() }));

  app.put('/api/system/printing', async (req) => {
    const input = parse(printSettingsInputSchema, req.body);
    const next = printing.setSettings(input, operatorOf(req));
    deps.store.addAudit({
      operator: operatorOf(req),
      target: 'druck',
      action: 'einstellungen',
      params: '',
      success: true,
      message: input.archive ? `Ablage unter „${input.folderPath || '/'}“` : 'Ablage aus',
    });
    deps.notify(['audit']);
    return next;
  });
}
