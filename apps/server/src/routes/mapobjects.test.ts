import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DisplaySelf, Incident, JournalEntry, MapObject } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let cookie = '';

async function req<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, as = cookie) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: as ? { cookie: as } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-objects-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  cookie = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const bremen = {
  kind: 'area',
  name: 'Bremen',
  lat: 53.0793,
  lon: 8.8017,
  data: { detail: 'Bundesland', osm: 'R62718', outline: { type: 'Polygon', coordinates: [[[8.5, 53.0], [8.9, 53.0], [8.9, 53.2], [8.5, 53.0]]] } },
};

describe('Kartenobjekte', () => {
  it('gehören zum Einsatz, stehen im Tagebuch und sind nach dem Einsatz nur noch lesbar', async () => {
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Gefahrstoffaustritt', keyword: 'ABC1' })).body;
    const url = `/api/incidents/${incident.id}/objects`;

    const area = await req<MapObject>('POST', url, bremen);
    expect(area.status).toBe(201);
    expect(area.body).toMatchObject({ kind: 'area', name: 'Bremen', visible: true, incidentId: incident.id, createdBy: 'Max Müller' });
    const gauss = (await req<MapObject>('POST', url, { kind: 'gauss', name: 'Gauß-Fahne', lat: 52.7, lon: 8.5 })).body;
    expect(gauss.data).toEqual({ stability: 'auto', cloudOktas: 4, terrain: 'rural', sourceHeightM: 0, releaseRateKgS: null });
    const sector = (await req<MapObject>('POST', url, { kind: 'sector', name: 'Sektor', lat: 52.7, lon: 8.5 })).body;
    expect(sector.data).toEqual({ sectorM: 1000 });
    const point = (await req<MapObject>('POST', url, { kind: 'point', name: 'Lange Straße 3', lat: 52.709, lon: 8.506, data: { detail: '49406 Barnstorf' } })).body;

    // Symbol für Punkte (Lucide-Name); andere Objekte und unbekannte Namen werden abgewiesen
    expect((await req<MapObject>('PATCH', `/api/map-objects/${point.id}`, { icon: 'Flame' })).body.data).toEqual({ detail: '49406 Barnstorf', icon: 'Flame' });
    expect((await req<MapObject>('PATCH', `/api/map-objects/${point.id}`, { icon: null })).body.data).toEqual({ detail: '49406 Barnstorf', icon: null });
    expect((await req('PATCH', `/api/map-objects/${point.id}`, { icon: 'GibtEsNicht' })).status).toBe(400);
    expect((await req('PATCH', `/api/map-objects/${area.body.id}`, { icon: 'Flame' })).status).toBe(400);
    expect((await req('POST', url, { kind: 'point', name: 'X', lat: 52.7, lon: 8.5, data: { detail: '', icon: 'GibtEsNicht' } })).status).toBe(400);

    // Ungültiges wird abgewiesen
    expect((await req('POST', url, { kind: 'kreis', name: 'X', lat: 1, lon: 1 })).status).toBe(400);
    expect((await req('POST', url, { ...bremen, data: { ...bremen.data, outline: { type: 'Point', coordinates: [8, 53] } } })).status).toBe(400);
    expect((await req('POST', url, { kind: 'gauss', name: 'G', lat: 95, lon: 8 })).status).toBe(400);

    // Einstellungen, Sichtbarkeit und Lage ändern
    const patched = await req<MapObject>('PATCH', `/api/map-objects/${gauss.id}`, { data: { stability: 'IV', sourceHeightM: 20 }, visible: false });
    expect(patched.body).toMatchObject({ visible: false, data: { stability: 'IV', sourceHeightM: 20, terrain: 'rural' } });
    expect((await req('PATCH', `/api/map-objects/${area.body.id}`, { data: { sectorM: 500 } })).status).toBe(400);
    // Farbe: Flächen, Punkte und Sektoren; null setzt auf die Vorgabe zurück; Gauß-Fahnen behalten ihre Stufenfarben
    expect(area.body.color).toBeNull();
    expect((await req<MapObject>('PATCH', `/api/map-objects/${area.body.id}`, { color: '#43a047' })).body.color).toBe('#43a047');
    expect((await req('PATCH', `/api/map-objects/${area.body.id}`, { color: 'grün' })).status).toBe(400);
    expect((await req('PATCH', `/api/map-objects/${gauss.id}`, { color: '#43a047' })).status).toBe(400);
    expect((await req<MapObject>('PATCH', `/api/map-objects/${sector.id}`, { color: '#8e24aa' })).body.color).toBe('#8e24aa');
    expect((await req<MapObject>('PATCH', `/api/map-objects/${sector.id}`, { color: null })).body.color).toBeNull();
    await req('PATCH', `/api/map-objects/${sector.id}`, { lat: 52.71, lon: 8.51 });
    expect((await req('DELETE', `/api/map-objects/${sector.id}`)).status).toBe(204);

    const list = (await req<MapObject[]>('GET', url)).body;
    expect(list.map((o) => o.name)).toEqual(['Bremen', 'Gauß-Fahne', 'Lange Straße 3']);
    expect(list[0]!.kind === 'area' && list[0]!.data.outline.type).toBe('Polygon');

    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body.map((e) => e.text);
    expect(journal).toEqual(
      expect.arrayContaining([
        'Kartenobjekt hinzugefügt: Fläche „Bremen“',
        'Kartenobjekt hinzugefügt: Gauß-Fahne „Gauß-Fahne“',
        'Kartenobjekt verschoben: Sektor 60° „Sektor“',
        'Kartenobjekt entfernt: Sektor 60° „Sektor“',
      ]),
    );
    // Einstellungen und Sichtbarkeit sind kein Tagebuchereignis
    expect(journal.filter((t) => t.includes('Gauß-Fahne „Gauß-Fahne“'))).toHaveLength(1);

    // Eigenes Fahrzeug ausblenden: am Einsatz, ohne Tagebucheintrag
    expect(incident.vehicleVisible).toBe(true);
    expect((await req<Incident>('PATCH', `/api/incidents/${incident.id}`, { vehicleVisible: false })).body.vehicleVisible).toBe(false);
    const after = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body;
    expect(after.filter((e) => e.text.startsWith('Einsatzdaten geändert'))).toEqual([]);

    // Ohne Anmeldung nichts, gekoppelter Bildschirm darf lesen
    expect((await req('GET', url, undefined, '')).status).toBe(401);
    const start = await app.server.inject({ method: 'POST', url: '/api/display/pair' });
    const display = String(start.headers['set-cookie']).split(';')[0]!;
    await req('POST', '/api/system/displays/pair', { code: (start.json() as DisplaySelf & { code: string }).code, name: 'Lagetisch' });
    expect((await req<MapObject[]>('GET', url, undefined, display)).body).toHaveLength(3);
    expect((await req('POST', url, bremen, display)).status).toBe(401);

    // Abgeschlossen: lesbar, nicht änderbar
    await req('POST', `/api/incidents/${incident.id}/close`);
    expect((await req<MapObject[]>('GET', url)).body).toHaveLength(3);
    expect((await req('POST', url, bremen)).status).toBe(409);
    expect((await req('PATCH', `/api/map-objects/${gauss.id}`, { visible: true })).status).toBe(409);
    expect((await req('DELETE', `/api/map-objects/${area.body.id}`)).status).toBe(409);
  });
});
