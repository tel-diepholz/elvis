import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePageRanges, mediaLabel, type DocumentListing, type Incident, type PrintJob, type PrintStatus } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { GROUP, OP, TAG, attr, decodeResponse, encodeMessage, type IppGroup } from '../services/ipp.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

/** Simulierter CUPS-Server: merkt sich die Anfragen und antwortet wie CUPS */
interface Received {
  url: string;
  operation: number;
  attrs: IppGroup;
  job: IppGroup;
  body: Buffer;
}
let received: Received[] = [];
let accepting = true;
let jobState = 3;
let downloads: string[] = [];

const PRINTER = [
  attr(TAG.name, 'printer-name', 'Laser_ELW'),
  attr(TAG.text, 'printer-info', 'Laserdrucker ELW'),
  attr(TAG.text, 'printer-location', 'Führungsraum'),
  attr(TAG.enum, 'printer-state', 3),
  attr(TAG.boolean, 'printer-is-accepting-jobs', true),
  attr(TAG.boolean, 'color-supported', false),
  attr(TAG.keyword, 'sides-supported', 'one-sided', 'two-sided-long-edge', 'two-sided-short-edge'),
  attr(TAG.keyword, 'media-supported', 'iso_a5_148x210mm', 'iso_a4_210x297mm', 'na_letter_8.5x11in'),
  attr(TAG.keyword, 'media-default', 'iso_a4_210x297mm'),
  attr(TAG.integer, 'number-up-supported', 1, 2, 4),
  attr(TAG.keyword, 'print-color-mode-supported', 'monochrome'),
];

async function fakeCups(url: string, body: Buffer): Promise<Buffer> {
  const msg = decodeResponse(body);
  const job = decodeResponse(body).jobs[0] ?? {};
  received.push({ url, operation: msg.status, attrs: msg.operation, job, body });
  const op = [attr(TAG.charset, 'attributes-charset', 'utf-8'), attr(TAG.language, 'attributes-natural-language', 'de')];
  if (msg.status === OP.cupsGetPrinters) {
    const printer = PRINTER.map((a) => (a.name === 'printer-is-accepting-jobs' ? attr(TAG.boolean, a.name, accepting) : a));
    // Sammlungen überspringt der Decoder
    const col = [attr(TAG.begCollection, 'media-col-default', ''), attr(TAG.memberName, '', 'media-size'), attr(TAG.begCollection, '', ''), attr(TAG.endCollection, '', ''), attr(TAG.endCollection, '', '')];
    return encodeMessage(0, msg.requestId, [{ tag: GROUP.operation, attributes: op }, { tag: GROUP.printer, attributes: [...printer, ...col] }]);
  }
  if (msg.status === OP.printJob) {
    return encodeMessage(0, msg.requestId, [
      { tag: GROUP.operation, attributes: op },
      { tag: GROUP.job, attributes: [attr(TAG.integer, 'job-id', 42), attr(TAG.enum, 'job-state', 3)] },
    ]);
  }
  if (msg.status === OP.getJobAttributes) {
    return encodeMessage(0, msg.requestId, [
      { tag: GROUP.operation, attributes: op },
      { tag: GROUP.job, attributes: [attr(TAG.enum, 'job-state', jobState), attr(TAG.text, 'job-state-message', jobState === 9 ? 'fertig' : '')] },
    ]);
  }
  return encodeMessage(0x0501, msg.requestId, [{ tag: GROUP.operation, attributes: op }]);
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

function multipart(options: object, file: { name: string; type: string; data: Buffer }) {
  const boundary = '----elvis' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${JSON.stringify(options)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Ohne Cookie = anonymer Arbeitsplatz */
async function print(options: object, file = { name: 'Lageplan.pdf', type: 'application/pdf', data: PDF }, cookie?: string) {
  const { payload, headers } = multipart(options, file);
  const res = await app.server.inject({ method: 'POST', url: '/api/printing/jobs', payload, headers: { ...headers, ...(cookie ? { cookie } : {}) } });
  return { status: res.statusCode, body: res.json() as PrintJob & { error?: string } };
}

async function get<T>(url: string, cookie = admin) {
  const res = await app.server.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.json() as T };
}

beforeEach(async () => {
  received = [];
  accepting = true;
  jobState = 3;
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-print-'));
  downloads = [];
  app = await buildApp(parseConfig({ dataDir }), {
    logger: false,
    ippTransport: fakeCups,
    officeDownload: async (url) => (downloads.push(url), PDF),
  });
  admin = await adminCookie(app);
  app.printing.setProvisions([{ id: 'druckserver-cups', name: 'Druckserver', url: 'http://docker1:631' }]);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Druckserver', () => {
  it('listet die Drucker auch für anonyme Arbeitsplätze', async () => {
    const { status, body } = await get<PrintStatus>('/api/printing', '');
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.printers).toHaveLength(1);
    expect(body.printers[0]).toMatchObject({
      id: 'druckserver-cups/Laser_ELW',
      info: 'Laserdrucker ELW',
      location: 'Führungsraum',
      state: 'idle',
      color: false,
      duplex: true,
      mediaDefault: 'iso_a4_210x297mm',
      numberUp: [1, 2, 4],
    });
    // A4 vor A5 vor Letter
    expect(body.printers[0]!.media).toEqual(['iso_a4_210x297mm', 'iso_a5_148x210mm', 'na_letter_8.5x11in']);
    expect(received[0]!.url).toBe('http://docker1:631/');
  });

  it('meldet einen nicht erreichbaren Druckserver, ohne zu scheitern', async () => {
    await app.close();
    app = await buildApp(parseConfig({ dataDir }), { logger: false, ippTransport: async () => Promise.reject(new Error('ECONNREFUSED')) });
    app.printing.setProvisions([{ id: 'x', name: 'Druckserver', url: 'http://docker1:631' }]);
    const { body } = await get<PrintStatus>('/api/printing', '');
    expect(body.printers).toEqual([]);
    expect(body.errors[0]).toContain('ECONNREFUSED');
  });

  it('druckt anonym mit den gewählten Einstellungen per IPP', async () => {
    const res = await print({ printerId: 'druckserver-cups/Laser_ELW', copies: 2, sides: 'two-sided-long-edge', color: 'monochrome', media: 'iso_a5_148x210mm', orientation: 'landscape', pageRanges: '1-3, 5', numberUp: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ filename: 'Lageplan.pdf', copies: 2, state: 'pending', submittedBy: 'Anonym', archivedPath: null });

    const job = received.find((r) => r.operation === OP.printJob)!;
    expect(job.url).toBe('http://docker1:631/printers/Laser_ELW');
    expect(job.attrs['printer-uri']).toEqual(['ipp://docker1:631/printers/Laser_ELW']);
    expect(job.attrs['document-format']).toEqual(['application/pdf']);
    expect(job.job).toMatchObject({
      copies: [2],
      sides: ['two-sided-long-edge'],
      'print-color-mode': ['monochrome'],
      media: ['iso_a5_148x210mm'],
      'orientation-requested': [4],
      'page-ranges': [[1, 3], [5, 5]],
      'number-up': [2],
      'fit-to-page': [true],
    });
    expect(job.body.subarray(job.body.length - PDF.length).equals(PDF)).toBe(true);

    const audit = (await get<{ target: string; operator: string; message: string }[]>('/api/audit')).body;
    expect(audit[0]).toMatchObject({ target: 'druck', operator: 'Anonym', message: 'Lageplan.pdf' });
  });

  it('prüft Datei und Einstellungen gegen den Drucker', async () => {
    const id = 'druckserver-cups/Laser_ELW';
    expect((await print({ printerId: id }, { name: 'a.txt', type: 'text/plain', data: Buffer.from('hallo') })).status).toBe(415);
    expect((await print({ printerId: id, color: 'color' })).body.error).toContain('schwarzweiß');
    expect((await print({ printerId: id, color: 'monochrome', media: 'iso_a3_297x420mm' })).status).toBe(400);
    expect((await print({ printerId: id, color: 'monochrome', pageRanges: '5-2' })).status).toBe(400);
    expect((await print({ printerId: id, color: 'monochrome', numberUp: 16 })).status).toBe(400);
    expect((await print({ printerId: 'druckserver-cups/Gibtsnicht', color: 'monochrome' })).status).toBe(404);
    accepting = false;
    expect((await print({ printerId: id, color: 'monochrome' })).status).toBe(409);
    expect(received.some((r) => r.operation === OP.printJob)).toBe(false);
  });

  it('legt den Druck im laufenden Einsatz im eingestellten Ordner ab', async () => {
    const put = await app.server.inject({ method: 'PUT', url: '/api/system/printing', headers: { cookie: admin }, payload: { archive: true, folderPath: 'Drucke/{{einsatz.stichwort}}', defaultPrinter: null } });
    expect(put.statusCode).toBe(200);
    const incident = (await app.server.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: admin }, payload: { title: 'Brand', keyword: 'B3' } })).json() as Incident;

    const status = (await get<PrintStatus>('/api/printing', '')).body;
    expect(status.archive).toEqual({ enabled: true, incident: { id: incident.id, title: 'Brand' }, path: 'Drucke/{{einsatz.stichwort}}' });

    const res = await print({ printerId: 'druckserver-cups/Laser_ELW', color: 'monochrome' });
    expect(res.status).toBe(201);
    expect(res.body.archivedPath).toBe('Drucke/B3/Lageplan.pdf');
    // zweiter Druck derselben Datei bekommt einen freien Namen
    expect((await print({ printerId: 'druckserver-cups/Laser_ELW', color: 'monochrome' })).body.archivedPath).toBe('Drucke/B3/Lageplan (2).pdf');

    const listing = (await get<DocumentListing>(`/api/incidents/${incident.id}/documents`)).body;
    const doc = listing.documents.find((d) => d.id === res.body.documentId)!;
    expect(doc).toMatchObject({ filename: 'Lageplan.pdf', mimeType: 'application/pdf', uploadedBy: 'Anonym', draft: false, description: 'Gedruckt auf Laserdrucker ELW' });
    const content = await app.server.inject({ method: 'GET', url: `/api/documents/${doc.id}/content`, headers: { cookie: admin } });
    expect(content.rawPayload.equals(PDF)).toBe(true);
  });

  it('legt ohne laufenden Einsatz oder bei abgeschalteter Ablage nichts ab', async () => {
    expect((await print({ printerId: 'druckserver-cups/Laser_ELW', color: 'monochrome' })).body.archivedPath).toBeNull();
    await app.server.inject({ method: 'PUT', url: '/api/system/printing', headers: { cookie: admin }, payload: { archive: false, folderPath: 'Drucke', defaultPrinter: null } });
    await app.server.inject({ method: 'POST', url: '/api/incidents', headers: { cookie: admin }, payload: { title: 'Brand' } });
    expect((await print({ printerId: 'druckserver-cups/Laser_ELW', color: 'monochrome' })).body.archivedPath).toBeNull();
  });

  it('fragt den Status offener Aufträge beim Druckserver nach', async () => {
    const { body: job } = await print({ printerId: 'druckserver-cups/Laser_ELW', color: 'monochrome' });
    jobState = 9;
    const { body } = await get<PrintJob>(`/api/printing/jobs/${job.ref}`, '');
    expect(body).toMatchObject({ state: 'completed', stateMessage: 'fertig' });
    const query = received.find((r) => r.operation === OP.getJobAttributes)!;
    expect(query.attrs['job-id']).toEqual([42]);
    // abgeschlossen: keine weitere Nachfrage
    const before = received.length;
    await get<PrintJob>(`/api/printing/jobs/${job.ref}`, '');
    expect(received.length).toBe(before);
    expect((await get(`/api/printing/jobs/unbekannt123`, '')).status).toBe(404);
  });

  it('Einstellungen und Auftragsliste nur für Admins', async () => {
    expect((await get('/api/system/printing', '')).status).toBe(401);
    expect((await app.server.inject({ method: 'PUT', url: '/api/system/printing', payload: { archive: false, folderPath: '', defaultPrinter: null } })).statusCode).toBe(401);
    await print({ printerId: 'druckserver-cups/Laser_ELW', color: 'monochrome' });
    const { body } = await get<{ jobs: PrintJob[] }>('/api/system/printing');
    expect(body.jobs).toHaveLength(1);
  });
});

describe('Drucken aus Collabora', () => {
  const pdfUrl = 'http://office:9980/cool/abc/download/123';
  const post = (payload: object, cookie = admin) => app.server.inject({ method: 'POST', url: '/api/printing/office', payload, headers: cookie ? { cookie } : {} });
  const options = { printerId: 'druckserver-cups/Laser_ELW', color: 'monochrome' };

  it('lädt das PDF vom Office-Server und druckt es unter dem Dokumentnamen', async () => {
    app.office.setProvisions([{ id: 'collabora-code', name: 'Collabora', url: 'http://office:9980', wopiBase: '' }]);
    const res = await post({ url: pdfUrl, filename: 'Lagemeldung 001.docx', options });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ filename: 'Lagemeldung 001.pdf', submittedBy: 'Max Müller' });
    expect(downloads).toEqual([pdfUrl]);
    expect(received.some((r) => r.operation === OP.printJob)).toBe(true);
  });

  it('lädt nur vom laufenden Office-Server und nur mit Anmeldung', async () => {
    expect((await post({ url: pdfUrl, filename: 'a.docx', options })).statusCode).toBe(503);
    app.office.setProvisions([{ id: 'collabora-code', name: 'Collabora', url: 'http://office:9980', wopiBase: '' }]);
    expect((await post({ url: 'http://evil:9980/x.pdf', filename: 'a.docx', options })).statusCode).toBe(400);
    expect((await post({ url: pdfUrl, filename: 'a.docx', options }, '')).statusCode).toBe(401);
    expect(downloads).toEqual([]);
  });
});

describe('Druckoptionen', () => {
  it('liest Seitenbereiche', () => {
    expect(parsePageRanges('')).toEqual([]);
    expect(parsePageRanges('1-3, 5, 8-')).toEqual([[1, 3], [5, 5], [8, 99999]]);
    expect(parsePageRanges('3-1')).toBeNull();
    expect(parsePageRanges('1-3,2')).toBeNull();
    expect(parsePageRanges('a')).toBeNull();
  });

  it('benennt Papierformate', () => {
    expect(mediaLabel('iso_a4_210x297mm')).toBe('A4');
    expect(mediaLabel('na_letter_8.5x11in')).toBe('Letter');
    expect(mediaLabel('iso_b5_176x250mm')).toBe('B5 (176×250 mm)');
    expect(mediaLabel('custom')).toBe('custom');
  });
});
