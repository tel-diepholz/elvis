import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentListing, DocumentTemplate, Incident, IncidentDocument, JournalEntry, OfficeSession, OfficeStatus, User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { fillXml } from '../services/office-fill.js';
import { parseDiscovery } from '../services/office.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

const DISCOVERY = `<?xml version="1.0" encoding="utf-8"?>
<wopi-discovery><net-zone name="external-http">
  <app name="writer"><action default="true" ext="docx" name="edit" urlsrc="http://office:9980/browser/1a/cool.html?&lt;ui=UI_LLCC&amp;&gt;"/></app>
  <app name="calc"><action ext="xlsx" name="edit" urlsrc="http://office:9980/browser/1a/cool.html?"/></app>
  <app name="writer-view"><action ext="pdf" name="view" urlsrc="http://office:9980/browser/1a/cool.html?"/></app>
</net-zone></wopi-discovery>`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown, cookie = admin, headers: Record<string, string> = {}) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const json = res.headers['content-type']?.toString().includes('json');
  return { status: res.statusCode, body: (json ? res.json() : res.rawPayload) as T };
}

/** Multipart-Formular: Felder vor der Datei, wie im Browser */
function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Uint8Array }) {
  const boundary = '----elvis' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(Buffer.from(file.data), Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload<T>(url: string, fields: Record<string, string>, file: { name: string; type: string; data: Uint8Array }, method: Method = 'POST', cookie = admin) {
  const { payload, headers } = multipart(fields, file);
  const res = await app.server.inject({ method, url, payload, headers: { ...headers, cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

/** docx, in dem Word den Platzhalter auf zwei Läufe verteilt hat */
function wordDoc(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      '<w:document><w:body><w:p><w:r><w:t>Einsatz {{einsatz.</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>stichwort}} in {{einsatz.ort}} – {{unbekannt.feld}}</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
}

async function userCookie(): Promise<{ cookie: string; user: User }> {
  const user = (await req<User>('POST', '/api/users', { firstName: 'Anna', lastName: 'Test', pin: '1111' })).body;
  const res = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
  return { cookie: sessionCookie(res.headers['set-cookie']), user };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-docs-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false, officeFetch: async () => DISCOVERY });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Platzhalter im Dokumentinhalt', () => {
  it('ersetzt auch über Läufe verteilte Platzhalter und lässt Unbekanntes stehen', () => {
    const xml = '<w:t>A {{einsatz.</w:t></w:r><w:r><w:t>stichwort}} & {{x.y}} {{ einsatz.ort }}</w:t>';
    expect(fillXml(xml, { einsatz: { stichwort: 'B<3>', ort: 'Diepholz' } })).toBe('<w:t>A B&lt;3&gt;</w:t></w:r><w:r><w:t> & {{x.y}} Diepholz</w:t>');
  });

  it('liest Aktionen aus der Discovery', () => {
    const d = parseDiscovery(DISCOVERY);
    expect([...d.edit.keys()]).toEqual(['docx', 'xlsx']);
    expect(d.view.get('pdf')).toBe('http://office:9980/browser/1a/cool.html?');
  });
});

describe('Dokumente', () => {
  it('legt beim Eröffnen die Ordnervorgabe an; Ordner lassen sich ergänzen, aber nur leere eigene von Admins löschen', async () => {
    const spec = { folders: [{ name: 'Lage', children: [{ name: 'Meldungen', children: [] }] }, { name: 'Fotos', children: [] }] };
    expect((await req('PUT', '/api/system/document-folders', spec)).status).toBe(200);
    expect((await req('PUT', '/api/system/document-folders', { folders: [{ name: 'a/b', children: [] }] })).status).toBe(400);

    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const list = (await req<DocumentListing>('GET', `/api/incidents/${incident.id}/documents`)).body;
    expect(list.folders.map((f) => [f.name, f.system])).toEqual([
      ['Fotos', true],
      ['Lage', true],
      ['Meldungen', true],
    ]);
    const lage = list.folders.find((f) => f.name === 'Lage')!;
    expect(list.folders.find((f) => f.name === 'Meldungen')!.parentId).toBe(lage.id);

    const { cookie } = await userCookie();
    const extra = await req<{ id: number }>('POST', `/api/incidents/${incident.id}/folders`, { parentId: lage.id, name: 'Skizzen' }, cookie);
    expect(extra.status).toBe(201);
    expect((await req('POST', `/api/incidents/${incident.id}/folders`, { parentId: lage.id, name: 'skizzen' }, cookie)).status).toBe(409);
    // Benutzer dürfen nichts löschen, Admins nur leere, nicht vorgegebene Ordner
    expect((await req('DELETE', `/api/document-folders/${extra.body.id}`, undefined, cookie)).status).toBe(403);
    expect((await req('DELETE', `/api/document-folders/${lage.id}`)).status).toBe(409);
    expect((await req('DELETE', `/api/document-folders/${extra.body.id}`)).status).toBe(204);

    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body.map((e) => e.text);
    expect(journal).toEqual(expect.arrayContaining(['Dokumentordner angelegt: Lage/Skizzen', 'Dokumentordner entfernt: Lage/Skizzen']));
  });

  it('lädt in Ordner hoch und verschiebt mit eindeutigen Namen', async () => {
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const folders = (await req<DocumentListing>('GET', `/api/incidents/${incident.id}/documents`)).body.folders;
    const fotos = folders.find((f) => f.name === 'Fotos')!;
    const file = { name: 'plan.pdf', type: 'application/pdf', data: strToU8('%PDF-1.4') };
    const a = await upload<IncidentDocument>(`/api/incidents/${incident.id}/documents`, { description: 'Halle 3', folderId: String(fotos.id) }, file);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ folderId: fotos.id, filename: 'plan.pdf', draft: false, description: 'Halle 3' });
    const b = (await upload<IncidentDocument>(`/api/incidents/${incident.id}/documents`, {}, file)).body;
    expect(b.folderId).toBeNull();
    // gleicher Name im Zielordner → abgelehnt; Endung bleibt beim Umbenennen erhalten
    expect((await req('PATCH', `/api/documents/${b.id}`, { folderId: fotos.id })).status).toBe(409);
    expect((await req<IncidentDocument>('PATCH', `/api/documents/${b.id}`, { folderId: fotos.id, filename: 'Plan Halle' })).body.filename).toBe('Plan Halle.pdf');
  });

  it('erstellt aus Vorlagen mit Pfad, Dateiname und Inhalt; Entwürfe sieht nur der Ersteller bis zum ersten Speichern', async () => {
    // Vorlagen pflegen nur Admins
    const { cookie, user } = await userCookie();
    const meta = { folderId: null, name: 'Lagemeldung', targetPath: 'Lagemeldungen/{{einsatz.stichwort}}', filenamePattern: 'Lagemeldung {{ordner.laufnummer}}' };
    const file = { name: 'lage.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: wordDoc() };
    expect((await upload('/api/templates', { meta: JSON.stringify(meta) }, file, 'POST', cookie)).status).toBe(403);
    const t = await upload<DocumentTemplate>('/api/templates', { meta: JSON.stringify(meta) }, file);
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ name: 'Lagemeldung', fillContent: true, filename: 'lage.docx' });
    expect((await req<{ templates: DocumentTemplate[] }>('GET', '/api/templates', undefined, cookie)).body.templates).toHaveLength(1);

    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand', keyword: 'B3', location: 'Diepholz' })).body;
    const created = await req<IncidentDocument>('POST', `/api/incidents/${incident.id}/documents/from-template`, { templateId: t.body.id }, cookie);
    expect(created.status).toBe(201);
    const doc = created.body;
    expect(doc).toMatchObject({ filename: 'Lagemeldung 001.docx', draft: true, templateId: t.body.id, createdByUserId: user.id });

    const mine = (await req<DocumentListing>('GET', `/api/incidents/${incident.id}/documents`, undefined, cookie)).body;
    const folder = mine.folders.find((f) => f.id === doc.folderId)!;
    expect(folder.name).toBe('B3');
    expect(mine.folders.find((f) => f.id === folder.parentId)!.name).toBe('Lagemeldungen');
    expect(mine.documents.map((d) => d.id)).toEqual([doc.id]);
    expect((await req<DocumentListing>('GET', `/api/incidents/${incident.id}/documents`)).body.documents).toEqual([]);
    expect((await req('GET', `/api/documents/${doc.id}/content`)).status).toBe(404);

    // Inhalt gefüllt, Unbekanntes bleibt stehen
    const content = (await req<Buffer>('GET', `/api/documents/${doc.id}/content`, undefined, cookie)).body;
    const xml = strFromU8(unzipSync(new Uint8Array(content))['word/document.xml']!);
    expect(xml).toContain('Einsatz B3</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t> in Diepholz – {{unbekannt.feld}}');

    // Office-Server: Sitzung, CheckFileInfo, Speichern
    app.office.setProvisions([{ id: 'collabora', name: 'Collabora', url: 'http://office:9980', wopiBase: 'http://elvis:8080' }]);
    expect((await req<OfficeStatus>('GET', '/api/office', undefined, cookie)).body).toMatchObject({ available: true, editable: ['docx', 'xlsx'] });
    const session = (await req<OfficeSession>('POST', `/api/documents/${doc.id}/edit`, undefined, cookie, { origin: 'https://elw.local' })).body;
    expect(session.readOnly).toBe(false);
    expect(session.actionUrl).toBe(
      `http://office:9980/browser/1a/cool.html?WOPISrc=${encodeURIComponent(`http://elvis:8080/api/wopi/files/d${doc.id}`)}&lang=de&closebutton=1`,
    );
    const token = encodeURIComponent(session.accessToken);
    const wopi = `/api/wopi/files/d${doc.id}`;
    expect((await req(`GET`, `${wopi}?access_token=falsch`, undefined, '')).status).toBe(401);
    expect((await req(`GET`, `/api/wopi/files/d${doc.id + 1}?access_token=${token}`, undefined, '')).status).toBe(401);
    const info = (await req<Record<string, unknown>>('GET', `${wopi}?access_token=${token}`, undefined, '')).body;
    expect(info).toMatchObject({ BaseFileName: 'Lagemeldung 001.docx', UserFriendlyName: 'Anna Test', UserCanWrite: true, PostMessageOrigin: 'https://elw.local', DownloadAsPostMessage: true });
    expect((await req<Buffer>('GET', `${wopi}/contents?access_token=${token}`, undefined, '')).body.length).toBe(content.length);

    const put = (headers: Record<string, string>) =>
      app.server.inject({ method: 'POST', url: `${wopi}/contents?access_token=${token}`, payload: Buffer.from('neu'), headers: { 'content-type': 'application/octet-stream', ...headers } });
    expect((await put({ 'x-cool-wopi-timestamp': '2000-01-01T00:00:00.000Z' })).statusCode).toBe(409);
    const saved = await put({ 'x-cool-wopi-timestamp': String(info.LastModifiedTime) });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().LastModifiedTime).not.toBe(info.LastModifiedTime);

    // Nach dem Speichern für alle sichtbar und im Tagebuch
    const all = (await req<DocumentListing>('GET', `/api/incidents/${incident.id}/documents`)).body.documents;
    expect(all).toMatchObject([{ id: doc.id, draft: false, version: 2, sizeBytes: 3, updatedBy: 'Anna Test' }]);
    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body.map((e) => e.text);
    expect(journal).toContain('Dokument erstellt: Lagemeldungen/B3/Lagemeldung 001.docx');

    // Laufende Nummer zählt weiter
    expect((await req<IncidentDocument>('POST', `/api/incidents/${incident.id}/documents/from-template`, { templateId: t.body.id })).body.filename).toBe('Lagemeldung 002.docx');

    // Abgeschlossener Einsatz: nur noch lesen
    await req('POST', `/api/incidents/${incident.id}/close`);
    expect((await req<Record<string, unknown>>('GET', `${wopi}?access_token=${token}`, undefined, '')).body.UserCanWrite).toBe(false);
    expect((await put({})).statusCode).toBe(403);
    expect((await req<OfficeSession>('POST', `/api/documents/${doc.id}/edit`)).body.readOnly).toBe(true);
  });

  it('erstellt leere Dokumente und verwirft Entwürfe', async () => {
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const doc = (await req<IncidentDocument>('POST', `/api/incidents/${incident.id}/documents/blank`, { kind: 'tabelle', folderId: null, name: 'Atemschutz' })).body;
    expect(doc).toMatchObject({ filename: 'Atemschutz.xlsx', draft: true });
    const content = (await req<Buffer>('GET', `/api/documents/${doc.id}/content`)).body;
    expect(Object.keys(unzipSync(new Uint8Array(content)))).toContain('xl/workbook.xml');
    expect((await req('DELETE', `/api/documents/${doc.id}`)).status).toBe(204);
    // Verwerfen eines Entwurfs steht nicht im Tagebuch
    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body.map((e) => e.text);
    expect(journal.some((t) => t.includes('Atemschutz'))).toBe(false);
  });

  it('meldet unbekannte Platzhalter im Ablageort', async () => {
    const meta = { folderId: null, name: 'Kaputt', targetPath: '{{einsatz.gibtsnicht}}' };
    const t = (await upload<DocumentTemplate>('/api/templates', { meta: JSON.stringify(meta) }, { name: 'x.docx', type: 'application/octet-stream', data: wordDoc() })).body;
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const res = await req<{ error: string }>('POST', `/api/incidents/${incident.id}/documents/from-template`, { templateId: t.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('{{einsatz.gibtsnicht}}');
  });
});
