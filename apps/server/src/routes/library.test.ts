import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { objectBadge, waterPropsFromOsm, type LibraryFile, type LibraryObject, type LibraryObjectDetail, type ObjectType } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { OverpassFetch } from '../services/overpass.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';
let answer: () => unknown = () => ({ elements: [] });
const overpassFetch: OverpassFetch = async () => answer();

beforeEach(async () => {
  answer = () => ({ elements: [] });
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-library-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false, overpassFetch });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body && res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) as T };
}

async function upload<T>(url: string, name: string, data: string) {
  const boundary = '----elvis' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.server.inject({ method: 'POST', url, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: admin } });
  return { status: res.statusCode, body: res.json() as T };
}

const types = async () => (await req<ObjectType[]>('GET', '/api/library/types')).body;

describe('Objektbibliothek', () => {
  it('bringt Wasserentnahmestelle und Einsatzobjekt mit; vordefinierte Felder bleiben', async () => {
    const list = await types();
    expect(list.map((t) => [t.builtin, t.name])).toEqual([
      ['water', 'Wasserentnahmestelle'],
      ['site', 'Einsatzobjekt'],
    ]);
    const water = list[0]!;
    // Feld ergänzen geht, vordefiniertes entfernen nicht
    const extra = { ...water, fields: [...water.fields, { key: 'betreiber', label: 'Betreiber', type: 'text' }] };
    expect((await req('PUT', `/api/system/library/types/${water.id}`, extra)).status).toBe(200);
    expect((await req('PUT', `/api/system/library/types/${water.id}`, { ...water, fields: water.fields.slice(1) })).status).toBe(400);
    expect((await req('DELETE', `/api/system/library/types/${water.id}`)).status).toBe(409);
    // Typen pflegen nur Admins
    expect((await req('POST', '/api/system/library/types', { name: 'Gefahrstofflager', icon: 'Biohazard', color: '#f59e0b' }, '')).status).toBe(401);
  });

  it('legt eigene Typen und Objekte an, prüft Felder und sucht im Ausschnitt', async () => {
    const t = (
      await req<ObjectType>('POST', '/api/system/library/types', {
        name: 'Sammelplatz',
        icon: 'Users',
        color: '#16a34a',
        fields: [
          { key: 'plaetze', label: 'Plätze', type: 'number', badge: true },
          { key: 'art', label: 'Art', type: 'select', options: ['innen', 'außen'] },
        ],
      })
    ).body;
    expect(t.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect((await req('POST', '/api/system/library/types', { name: 'sammelplatz', icon: 'Users', color: '#16a34a' })).status).toBe(409);

    const bad = await req<{ error: string }>('POST', '/api/library/objects', { typeId: t.id, name: 'Turnhalle', lat: 52.9, lon: 8.7, props: { art: 'oben' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('Art');

    const o = (await req<LibraryObjectDetail>('POST', '/api/library/objects', { typeId: t.id, name: 'Turnhalle', lat: 52.9, lon: 8.7, props: { plaetze: '120', art: 'innen', fremd: 'x' } })).body;
    expect(o.props).toEqual({ plaetze: 120, art: 'innen' });
    expect(objectBadge(t, o.props)).toBe('120');

    expect((await req<LibraryObject[]>('GET', '/api/library/objects?bbox=52.8,8.6,53,8.8')).body).toHaveLength(1);
    expect((await req<LibraryObject[]>('GET', '/api/library/objects?bbox=50,6,51,7')).body).toHaveLength(0);
    expect((await req<LibraryObject[]>(`GET`, `/api/library/objects?types=${t.id + 100}`)).body).toHaveLength(0);
    expect((await req<LibraryObject[]>('GET', '/api/library/objects?q=turn')).body).toHaveLength(1);

    // Typ mit Objekten lässt sich nicht löschen
    expect((await req('DELETE', `/api/system/library/types/${t.id}`)).status).toBe(409);
    // Anonym lesen ja (Karte), ändern nein
    expect((await req('GET', '/api/library/objects', undefined, '')).status).toBe(200);
    expect((await req('DELETE', `/api/library/objects/${o.id}`, undefined, '')).status).toBe(401);

    const upd = (await req<LibraryObjectDetail>('PUT', `/api/library/objects/${o.id}`, { typeId: t.id, name: 'Sporthalle', lat: 52.9, lon: 8.7, props: {} })).body;
    expect(upd).toMatchObject({ name: 'Sporthalle', rev: 2, props: {} });
  });

  it('hängt Dateien an Einsatzobjekte und entfernt sie mit dem Objekt', async () => {
    const site = (await types()).find((t) => t.builtin === 'site')!;
    const o = (await req<LibraryObjectDetail>('POST', '/api/library/objects', { typeId: site.id, name: 'Klinikum', lat: 52.6, lon: 8.4, props: { bma: true, objektnummer: 'BMA 17' } })).body;
    const f1 = await upload<LibraryFile>(`/api/library/objects/${o.id}/files`, 'Feuerwehrplan.pdf', '%PDF-1 plan');
    expect(f1.status).toBe(201);
    const f2 = await upload<LibraryFile>(`/api/library/objects/${o.id}/files`, 'Feuerwehrplan.pdf', '%PDF-1 neu');
    expect(f2.body.filename).toBe('Feuerwehrplan (2).pdf');

    const detail = (await req<LibraryObjectDetail>('GET', `/api/library/objects/${o.id}`)).body;
    expect(detail.files.map((f) => f.filename)).toEqual(['Feuerwehrplan (2).pdf', 'Feuerwehrplan.pdf']);
    expect(detail.fileCount).toBe(2);
    const content = await app.server.inject({ method: 'GET', url: `/api/library/files/${f1.body.id}/content` });
    expect(content.body).toBe('%PDF-1 plan');
    expect(content.headers['content-security-policy']).toContain('sandbox');

    expect((await req('DELETE', `/api/library/objects/${o.id}`)).status).toBe(204);
    expect((await req('GET', `/api/library/objects/${o.id}`)).status).toBe(404);
    expect((await req('GET', `/api/library/files/${f1.body.id}/content`)).status).toBe(404);
    expect(readdirSync(join(dataDir, 'library'))).toEqual([]);
    expect(existsSync(join(dataDir, 'library'))).toBe(true);
  });

  it('übernimmt Wasserentnahmestellen aus OSM ohne Doppelte', async () => {
    answer = () => ({
      elements: [
        { type: 'node', id: 1, lat: 52.7, lon: 8.5, tags: { emergency: 'fire_hydrant', 'fire_hydrant:type': 'pillar', 'fire_hydrant:diameter': '100' } },
        { type: 'node', id: 2, lat: 52.71, lon: 8.51, tags: { emergency: 'suction_point', name: 'Saugstelle Hunte' } },
      ],
    });
    const bounds = { s: 52.6, w: 8.4, n: 52.8, e: 8.6 };
    expect((await req('POST', '/api/library/import/osm-water', { bounds })).body).toMatchObject({ added: 2, skipped: 0 });
    expect((await req('POST', '/api/library/import/osm-water', { bounds })).body).toMatchObject({ added: 0, skipped: 2 });
    const objects = (await req<LibraryObject[]>('GET', '/api/library/objects')).body;
    expect(objects.map((o) => [o.name, o.props, o.source])).toEqual([
      ['Hydrant Überflur', { art: 'Hydrant Überflur', dn: 100 }, 'osm:N1'],
      ['Saugstelle Hunte', { art: 'Saugstelle' }, 'osm:N2'],
    ]);
  });

  it('liest Tags von Wasserentnahmestellen', () => {
    expect(waterPropsFromOsm({ emergency: 'fire_hydrant', 'fire_hydrant:type': 'underground', 'fire_hydrant:diameter': '80', flow_rate: '800' })).toEqual({
      name: 'Hydrant Unterflur',
      props: { art: 'Hydrant Unterflur', dn: 80, leistung: 800 },
    });
    expect(waterPropsFromOsm({ emergency: 'fire_water_pond', name: 'Teich Mühle', volume: '200' }).props).toEqual({ art: 'Löschteich', volumen: 200 });
  });
});
