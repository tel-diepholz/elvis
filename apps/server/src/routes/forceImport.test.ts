import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ForceImportPreview, ForceImportResult, ForceUnit, ForceUnitInput } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { importTemplate, parseCsv, parseImport, parseXlsx } from '../services/forceImport.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie: admin } });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

/** Datei wie aus dem Browser (multipart/form-data) hochladen */
async function upload(filename: string, content: Buffer | string) {
  const boundary = '----elvis-test';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const payload = Buffer.concat([Buffer.from(head), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app.server.inject({ method: 'POST', url: '/api/system/forces/import/preview', payload, headers: { cookie: admin, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: res.json() as ForceImportPreview & { error?: string } };
}

/** Kleinste gültige xlsx: Arbeitsmappe mit einem Blatt, Texte teils geteilt, teils inline, eine Zahl */
function xlsx(rows: (string | number)[][]): Buffer {
  const shared: string[] = [];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r.map((v, ci) => {
        const ref = `${col(ci)}${ri + 1}`;
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        if (ci === 0) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
        shared.push(v);
        return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
      });
      return `<row r="${ri + 1}">${cells.join('')}</row>`;
    })
    .join('');
  return Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Kräfte" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`),
    }),
  );
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-force-import-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Dateien lesen', () => {
  it('CSV mit Semikolon, Anführungszeichen und Zeilenumbruch im Feld', () => {
    expect(parseCsv('Name;Bemerkung\r\n"HLF; 20";"Zeile 1\nZeile ""2"""\r\nLF 10;\r\n')).toEqual([
      ['Name', 'Bemerkung'],
      ['HLF; 20', 'Zeile 1\nZeile "2"'],
      ['LF 10', ''],
    ]);
    expect(parseCsv('Name,Funkrufname\nELW 1,Florian 1')).toEqual([
      ['Name', 'Funkrufname'],
      ['ELW 1', 'Florian 1'],
    ]);
  });

  it('CSV aus Excel in Windows-1252 und die Vorlage', () => {
    const latin1 = Buffer.from('Name;Stärke\nLöschzug;0/1/8\n', 'latin1');
    expect(parseImport('kraefte.csv', latin1).rows[0]?.row).toMatchObject({ name: 'Löschzug', leaders: 0, subLeaders: 1, crew: 8 });
    const template = parseImport('vorlage.csv', Buffer.from(importTemplate()));
    expect(template.ignored).toEqual([]);
    expect(template.rows.every((r) => r.row)).toBe(true);
  });

  it('xlsx: erstes Blatt, geteilte und Inline-Texte, Zahlen', () => {
    expect(parseXlsx(xlsx([['Name', 'Mannschaft'], ['HLF 20', 8]]))).toEqual([
      [
        ['Name', 'Mannschaft'],
        ['HLF 20', '8'],
      ],
    ]);
  });

  it('Spalten an Überschriften erkennen, Fehler je Zeile melden', () => {
    const csv = 'Name der Einheit;Rufname;Wehr;Führer;Unterführer;Mannschaft;Art;Farbe\nHLF 20;Florian 1;FF Mitte;0;1;acht;THW;rot\n;;;;;;;\n;Florian 2;;;;;;\n';
    const parsed = parseImport('k.csv', Buffer.from(csv));
    expect(parsed.columns).toMatchObject({ name: 'Name der Einheit', callsign: 'Rufname', organization: 'Wehr', leaders: 'Führer', crew: 'Mannschaft', signOrg: 'Art' });
    expect(parsed.ignored).toEqual(['Farbe']);
    // Leerzeile übersprungen, Zeilennummern wie in der Datei
    expect(parsed.rows.map((r) => [r.line, r.row !== null, r.messages])).toEqual([
      [2, false, ['Mannschaft: „acht“ ist keine Zahl']],
      [4, false, ['Name: Name fehlt']],
    ]);
  });

  it('ohne Namensspalte oder altes Excel-Format: verständlicher Fehler', () => {
    expect(() => parseImport('k.csv', Buffer.from('Fahrzeugnummer;Typ\n1;HLF\n'))).toThrow('Spalte „Name“ nicht gefunden');
    expect(() => parseImport('k.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toThrow('.xlsx oder CSV');
  });
});

describe('Import in die Kräfteverwaltung', () => {
  const force = async (input: ForceUnitInput) => (await req<ForceUnit>('POST', '/api/system/forces', input)).body;
  const byName = async () => new Map((await req<ForceUnit[]>('GET', '/api/forces')).body.map((u) => [u.name, u]));

  it('Vorschau, dann anlegen mit Zeichen, Stärke und Zugehörigkeit', async () => {
    const preview = await upload('kraefte.csv', importTemplate());
    expect(preview.status).toBe(200);
    expect(preview.body.rows.map((r) => r.action)).toEqual(['create', 'create', 'create']);

    const result = await req<ForceImportResult>('POST', '/api/system/forces/import', { rows: preview.body.rows.map((r) => r.row), updateExisting: true });
    expect(result.body).toMatchObject({ created: 3, updated: 0, skipped: 0, linked: 2 });
    const units = await byName();
    const zug = units.get('1. Zug Diepholz')!;
    const elw = units.get('ELW 1 Diepholz')!;
    expect(elw).toMatchObject({ callsign: 'Florian Diepholz 11/12-1', organization: 'FF Diepholz', strength: { leaders: 1, subLeaders: 1, crew: 1 }, sign: { text: 'ELW 1', org: 'feuerwehr' } });
    expect(zug.members).toEqual([
      { unitId: elw.id, role: 'Führungsfahrzeug' },
      { unitId: units.get('HLF 20 Diepholz')!.id, role: 'Löschfahrzeug' },
    ]);
  });

  it('vorhandene aktualisieren oder überspringen; leere Spalten lassen Werte stehen', async () => {
    const hlf = await force({ name: 'HLF 20', callsign: 'Florian 1/44-1', notes: 'bleibt', strength: { leaders: 0, subLeaders: 1, crew: 8 } });
    await force({ name: 'Löschzug', members: [{ unitId: hlf.id, role: 'Löschfahrzeug' }] });
    // gleicher Funkrufname, anderer Name → dieselbe Einheit
    const xl = xlsx([
      ['Name', 'Funkrufname', 'Mannschaft', 'Bemerkung', 'Gehört zu', 'Rolle'],
      ['HLF 20/1', 'Florian 1/44-1', 6, '', 'Löschzug', 'Erstangriff'],
      ['MTW', '', 3, '', 'Löschzug', ''],
    ]);
    const preview = await upload('kraefte.xlsx', xl);
    expect(preview.body.rows.map((r) => [r.action, r.matchId])).toEqual([
      ['update', hlf.id],
      ['create', null],
    ]);
    const rows = preview.body.rows.map((r) => r.row);

    const skipped = await req<ForceImportResult>('POST', '/api/system/forces/import', { rows, updateExisting: false });
    expect(skipped.body).toMatchObject({ created: 1, updated: 0, skipped: 1, linked: 1 });
    expect((await byName()).get('HLF 20')?.strength.crew).toBe(8);

    const updated = await req<ForceImportResult>('POST', '/api/system/forces/import', { rows, updateExisting: true });
    expect(updated.body).toMatchObject({ created: 0, updated: 2, linked: 0 });
    const units = await byName();
    expect(units.get('HLF 20/1')).toMatchObject({ id: hlf.id, notes: 'bleibt', strength: { leaders: 0, subLeaders: 1, crew: 6 } });
    // Rolle der bestehenden Mitgliedschaft übernommen, MTW einmal ergänzt
    expect(units.get('Löschzug')?.members.map((m) => [units.get('MTW')!.id === m.unitId ? 'MTW' : 'HLF', m.role])).toEqual([
      ['HLF', 'Erstangriff'],
      ['MTW', ''],
    ]);
  });

  it('Doppelte, unbekannte und mehrdeutige Zuordnungen, Zyklen', async () => {
    await force({ name: 'GW-L', organization: 'FF Nord' });
    await force({ name: 'GW-L', organization: 'FF Süd' });
    const csv = ['Name;Organisation;Gehört zu', 'GW-L;;', 'ELW;;Zug X', 'ELW;;', 'Zug A;;Zug B', 'Zug B;;Zug A', 'TLF;;TLF'].join('\n');
    const preview = await upload('k.csv', csv);
    expect(preview.body.rows.map((r) => [r.line, r.action, r.messages[0] ?? ''])).toEqual([
      [2, 'error', 'Mehrdeutig: 2 vorhandene Einheiten „GW-L“ – Funkrufname oder Organisation angeben'],
      [3, 'error', 'Gehört zu: „Zug X“ nicht gefunden'],
      [4, 'error', 'Doppelt – schon in Zeile 3'],
      [5, 'create', ''],
      [6, 'create', ''],
      [7, 'error', 'Gehört zu: eine Einheit kann nicht zu sich selbst gehören'],
    ]);
    const valid = preview.body.rows.filter((r) => r.action !== 'error').map((r) => r.row);
    const result = await req<ForceImportResult>('POST', '/api/system/forces/import', { rows: valid, updateExisting: true });
    // Zug A gehört zu Zug B; Zug B zu Zug A wäre ein Kreis
    expect(result.body).toMatchObject({ created: 2, linked: 1 });
    expect(result.body.rows.find((r) => r.row?.name === 'Zug B')?.messages).toEqual(['Gehört zu: Zug A steckt bereits in Zug B – nicht verknüpft']);
    expect((await upload('k.csv', 'Name\nELW\nELW\n')).body.rows[1]?.messages).toEqual(['Doppelt – schon in Zeile 2']);
  });

  it('nur Admins; Vorlage zum Herunterladen', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/api/system/forces/import/template', headers: { cookie: admin } });
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.startsWith('﻿Name;Funkrufname')).toBe(true);
    expect((await app.server.inject({ method: 'POST', url: '/api/system/forces/import', payload: { rows: [] } })).statusCode).toBe(401);
  });
});
