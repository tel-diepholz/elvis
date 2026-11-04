import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument as LibPdf, PDFDict, PDFName } from 'pdf-lib';
import PDFKit from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { personInputSchema, type DamageAccount, type Incident, type IncidentDocument, type JournalEntry, type Unit } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64');

let app: App;
let cookie = '';
let dataDir: string;
let tileServer: Server;
let converted: string[];

type Method = 'GET' | 'POST' | 'PATCH';
async function req<T = unknown>(method: Method, url: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: (res.body && res.headers['content-type']?.toString().includes('json') ? res.json() : res.rawPayload) as T, headers: res.headers };
}

function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Uint8Array }) {
  const boundary = '----elvis' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(Buffer.from(file.data), Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(incidentId: number, file: { name: string; type: string; data: Uint8Array }): Promise<IncidentDocument> {
  const { payload, headers } = multipart({ description: `Test ${file.name}` }, file);
  const res = await app.server.inject({ method: 'POST', url: `/api/incidents/${incidentId}/documents`, payload, headers: { ...headers, cookie } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** PDF mit n Seiten (pdfkit) */
async function pdfWithPages(n: number): Promise<Buffer> {
  const doc = new PDFKit({ size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  for (let i = 0; i < n; i++) {
    if (i) doc.addPage();
    doc.text(`Plan Seite ${i + 1}`);
  }
  doc.end();
  return done;
}

/** Namen der eingebetteten Dateien (EmbeddedFiles-Namensbaum) */
function embeddedNames(pdf: LibPdf): string[] {
  const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict);
  const files = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
  const arr = files.lookup(PDFName.of('Names')) as unknown as { asArray(): unknown[] };
  return arr
    .asArray()
    .filter((_, i) => i % 2 === 0)
    .map((s) => (s as { decodeText(): string }).decodeText());
}

beforeEach(async () => {
  converted = [];
  tileServer = createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
  await new Promise<void>((r) => tileServer.listen(0, '127.0.0.1', r));
  const { port } = tileServer.address() as AddressInfo;
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-report-'));
  const officePdf = await pdfWithPages(1);
  app = await buildApp(
    parseConfig({ dataDir, map: { sources: [{ id: 'test', name: 'Test', url: `http://127.0.0.1:${port}/{z}/{x}/{y}.png`, attribution: '© Test' }] } }),
    {
      logger: false,
      officeConvert: async (_content, filename) => {
        converted.push(filename);
        return officePdf;
      },
    },
  );
  cookie = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  tileServer.closeAllConnections();
  await new Promise((r) => tileServer.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

async function seed(): Promise<Incident> {
  const inc = (await req<Incident>('POST', '/api/incidents', { keyword: 'B3', title: 'Brand Lagerhalle', location: 'Industriestr. 5', lat: 52.6, lon: 8.4 })).body;
  await req('POST', `/api/incidents/${inc.id}/journal`, { category: 'lage', text: 'Rauchentwicklung über Halle 3 – Öl läuft aus', important: true });
  const account = (await req<DamageAccount>('POST', `/api/incidents/${inc.id}/damage-accounts`, { name: 'EA Nord' })).body;
  await req('POST', `/api/damage-accounts/${account.id}/entries`, { side: 'schaden', text: 'Dachstuhl brennt' });
  await req('POST', `/api/damage-accounts/${account.id}/entries`, { side: 'massnahme', text: 'Riegelstellung' });
  expect((await req('POST', `/api/damage-accounts/${account.id}/counts`, { category: 'sk2', value: 3, forces: 1 })).status).toBe(200);
  const unit = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'HLF 20', accountId: account.id })).body;
  await req('PATCH', `/api/units/${unit.id}`, { lat: 52.601, lon: 8.401, mapVisible: true });
  app.personnel.add(unit.id, [personInputSchema.parse({ lastName: 'Schäfer', firstName: 'Jörg', birthDate: '1980-02-01', address: 'Hauptstr. 1', emergencyContact: 'Anna Schäfer' })], 'Test');
  await req('POST', `/api/incidents/${inc.id}/objects`, { kind: 'point', name: 'Hydrant', lat: 52.602, lon: 8.402, data: { detail: 'DN 100' } });
  await upload(inc.id, { name: 'foto.png', type: 'image/png', data: PNG });
  await upload(inc.id, { name: 'plan.pdf', type: 'application/pdf', data: await pdfWithPages(2) });
  await upload(inc.id, { name: 'bericht.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: Buffer.from('PK fake') });
  await upload(inc.id, { name: 'daten.bin', type: 'application/octet-stream', data: Buffer.from([1, 2, 3]) });
  return inc;
}

describe('Einsatzbericht', () => {
  it('erzeugt ein PDF mit Karte, eingefügten Dokumenten und allen Originalen als Anhang', async () => {
    const inc = await seed();
    const res = await req<Buffer>('GET', `/api/incidents/${inc.id}/report.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('Einsatzbericht_B3_');

    const pdf = await LibPdf.load(res.body);
    // Hauptteil (mehrere Abschnitte) + 2 Seiten plan.pdf + 1 Seite umgewandeltes docx
    expect(pdf.getPageCount()).toBeGreaterThan(12);
    expect(converted).toEqual(['bericht.docx']);
    const names = embeddedNames(pdf);
    expect(names).toEqual(expect.arrayContaining(['A1_bericht.docx', 'A2_daten.bin', 'A3_foto.png', 'A4_plan.pdf']));
    // Karte im Querformat eingesetzt
    expect(pdf.getPages().some((p) => p.getWidth() > p.getHeight())).toBe(true);
    // Text des Berichts (pdfkit schreibt Hex-kodiert, deshalb nur grob über die Größe prüfen)
    expect(res.body.length).toBeGreaterThan(10_000);
  });

  it('legt den Bericht beim Beenden unter Protokolle ab und nimmt ihn nicht in spätere Berichte auf', async () => {
    const inc = await seed();
    expect((await req('POST', `/api/incidents/${inc.id}/close`, {})).status).toBe(200);
    await app.report.idle();

    const listing = (await req<{ folders: { id: number; name: string }[]; documents: IncidentDocument[] }>('GET', `/api/incidents/${inc.id}/documents`)).body;
    const report = listing.documents.find((d) => d.filename.startsWith('Einsatzbericht_'));
    expect(report).toBeDefined();
    expect(listing.folders.find((f) => f.id === report!.folderId)?.name).toBe('Protokolle');
    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${inc.id}/journal`)).body.map((j) => j.text);
    expect(journal.some((t) => t.startsWith('Dokument hinzugefügt: Protokolle/Einsatzbericht_'))).toBe(true);

    // Neu erzeugt aus dem Archiv: der abgelegte Bericht ist kein Anhang
    const again = await LibPdf.load((await req<Buffer>('GET', `/api/incidents/${inc.id}/report.pdf`)).body);
    expect(embeddedNames(again).some((n) => n.includes('Einsatzbericht'))).toBe(false);
  });

  it('kommt ohne Office-Server, Dokumente und Positionen aus', async () => {
    await app.close();
    app = await buildApp(parseConfig({ dataDir }), { logger: false, officeConvert: null });
    const inc = (await req<Incident>('POST', '/api/incidents', { title: 'Leer' })).body;
    const res = await req<Buffer>('GET', `/api/incidents/${inc.id}/report.pdf`);
    expect(res.status).toBe(200);
    expect((await LibPdf.load(res.body)).getPageCount()).toBeGreaterThan(5);
  });

  it('meldet unbekannte Einsätze mit 404', async () => {
    expect((await req('GET', '/api/incidents/999/report.pdf')).status).toBe(404);
  });
});
