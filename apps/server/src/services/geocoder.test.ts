import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GeocodeResponse } from '@elvis/shared';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { GeocoderService, nominatimResult, toResult, type GeocodeFetch, type NominatimPlace, type PhotonFeature } from './geocoder.js';

const street = (id: number, extra: Partial<NonNullable<PhotonFeature['properties']>> = {}): PhotonFeature => ({
  geometry: { coordinates: [8.5042465, 52.709856] },
  properties: {
    osm_type: 'W',
    osm_id: id,
    type: 'street',
    name: 'Lange Straße',
    postcode: '49406',
    city: 'Barnstorf',
    district: 'Barnstorf',
    county: 'Landkreis Diepholz',
    countrycode: 'DE',
    extent: [8.504107, 52.709893, 8.504386, 52.709819],
    ...extra,
  },
});

/** Fake-Dienste: je Basisadresse feste Antwort oder Fehler; merkt sich die Aufrufe */
function fakeFetch(answers: Record<string, PhotonFeature[] | unknown[] | object | Error>) {
  const calls: string[] = [];
  const fetch: GeocodeFetch = async (url, opts) => {
    calls.push(url);
    expect(opts.userAgent).toBe('ELVIS-Test');
    const base = Object.keys(answers).find((b) => url.startsWith(b));
    const a = base ? answers[base]! : new Error('unbekannt');
    if (a instanceof Error) throw a;
    // Photon antwortet mit FeatureCollection, Nominatim (/search) mit einer Liste, /lookup mit GeoJSON
    return url.includes('/api?') ? { features: a } : a;
  };
  return { fetch, calls };
}

const ONLINE = 'https://photon.example';
const LOCAL = { id: 'ortssuche-photon', name: 'Ortssuche (lokal)', type: 'photon' as const, url: 'http://10.0.0.2:2322/' };

describe('Ortssuche', () => {
  it('erkennt Koordinaten und UTMREF selbst, ohne einen Dienst zu fragen', async () => {
    const f = fakeFetch({});
    const geo = new GeocoderService({ onlineUrl: ONLINE, userAgent: 'ELVIS-Test' }, f.fetch);
    const r = await geo.search('32U MD 66507 40110', null);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ kind: 'coordinate', detail: 'UTMREF 32U MD 66507 40110' });
    expect(r.results[0]!.lat).toBeCloseTo(52.70986, 4);
    expect((await geo.search('52.70986, 8.50425', null)).results[0]!.detail).toMatch(/^Dezimalgrad · UTMREF 32U MD/);
    expect(f.calls).toEqual([]);
  });

  it('bevorzugt den lokalen Dienst, fällt auf den öffentlichen zurück und gewichtet nach Nähe', async () => {
    const f = fakeFetch({ [LOCAL.url]: [street(1)], [ONLINE]: [street(2, { name: 'Online-Straße' })] });
    const geo = new GeocoderService({ onlineUrl: ONLINE, userAgent: 'ELVIS-Test' }, f.fetch);
    expect(geo.setProvisions([LOCAL])).toBe(true);
    expect(geo.setProvisions([LOCAL])).toBe(false);

    const local = await geo.search('Lange Straße', { lat: 52.71, lon: 8.5 });
    expect(local).toMatchObject({ source: 'Ortssuche (lokal)', problem: null });
    expect(f.calls[0]).toBe('http://10.0.0.2:2322/api?q=Lange+Stra%C3%9Fe&limit=8&lang=de&lat=52.7100&lon=8.5000&zoom=12');

    // Lokaler Dienst fällt aus → öffentlicher
    const down = fakeFetch({ [LOCAL.url]: new Error('ECONNREFUSED'), [ONLINE]: [street(2, { name: 'Online-Straße' })] });
    const geo2 = new GeocoderService({ onlineUrl: ONLINE, userAgent: 'ELVIS-Test' }, down.fetch);
    geo2.setProvisions([LOCAL]);
    const online = await geo2.search('Lange Straße', null);
    expect(online).toMatchObject({ source: 'photon.example', results: [{ name: 'Online-Straße' }] });
  });

  it('nutzt zwischengespeicherte Online-Treffer, auch wenn der Dienst später ausfällt', async () => {
    const answers: Record<string, PhotonFeature[] | Error> = { [ONLINE]: [street(1)] };
    const f = fakeFetch(answers);
    const geo = new GeocoderService({ onlineUrl: ONLINE, userAgent: 'ELVIS-Test' }, f.fetch);
    await geo.search('Lange Straße', { lat: 52.711, lon: 8.501 });
    // gleiche Suche, Kartenmitte nur leicht verschoben → aus dem Speicher
    expect((await geo.search('lange straße ', { lat: 52.712, lon: 8.502 })).source).toBe('photon.example');
    expect(f.calls).toHaveLength(1);

    // Nach Ablauf fragt ELVIS neu; ist der Dienst weg, bleiben die alten Treffer
    const later = new GeocoderService({ onlineUrl: ONLINE, userAgent: 'ELVIS-Test' }, f.fetch, () => Date.now() + 2 * 24 * 3600_000);
    (later as unknown as { cache: unknown }).cache = (geo as unknown as { cache: unknown }).cache;
    answers[ONLINE] = new Error('offline');
    const stale = await later.search('Lange Straße', { lat: 52.711, lon: 8.501 });
    expect(stale.source).toBe('photon.example (zwischengespeichert)');
    expect(stale.results[0]!.name).toBe('Lange Straße');
  });

  it('meldet, wenn kein Dienst erreichbar oder eingerichtet ist', async () => {
    const f = fakeFetch({ [ONLINE]: new Error('getaddrinfo ENOTFOUND') });
    const geo = new GeocoderService({ onlineUrl: ONLINE, userAgent: 'ELVIS-Test' }, f.fetch);
    const r = await geo.search('Barnstorf', null);
    expect(r.results).toEqual([]);
    expect(r.problem).toMatch(/nicht erreichbar \(photon\.example: getaddrinfo ENOTFOUND\)/);
    const none = new GeocoderService({ onlineUrl: null, userAgent: 'ELVIS-Test' }, f.fetch);
    expect((await none.search('Barnstorf', null)).problem).toMatch(/Keine Ortssuche eingerichtet/);
    expect((await geo.search('B', null)).results).toEqual([]); // zu kurz, keine Anfrage
  });

  it('baut Haupt- und Detailzeile, Ausdehnung und fasst Straßenabschnitte zusammen', async () => {
    expect(toResult(street(1))).toEqual({
      id: 'W1',
      kind: 'street',
      name: 'Lange Straße',
      detail: '49406 Barnstorf · Landkreis Diepholz',
      lat: 52.709856,
      lon: 8.5042465,
      bounds: [[52.709819, 8.504107], [52.709893, 8.504386]],
      osm: 'W1',
    });
    const shop = toResult(street(3, { type: 'house', name: 'Modehaus', street: 'Lange Straße', housenumber: '3' }))!;
    expect(shop).toMatchObject({ kind: 'house', name: 'Modehaus', detail: 'Lange Straße 3 · 49406 Barnstorf · Landkreis Diepholz' });
    const address = toResult(street(4, { type: 'house', name: undefined, street: 'Lange Straße', housenumber: '5' }))!;
    expect(address.name).toBe('Lange Straße 5');
    expect(toResult(street(5, { countrycode: 'NL', country: 'Niederlande' }))!.detail).toMatch(/Niederlande$/);

    const f = fakeFetch({ [ONLINE]: [street(1), street(2), street(6, { city: 'Diepholz', postcode: '49356' })] });
    const geo = new GeocoderService({ onlineUrl: ONLINE, userAgent: 'ELVIS-Test' }, f.fetch);
    expect((await geo.search('Lange Straße', null)).results.map((r) => r.detail)).toEqual(['49406 Barnstorf · Landkreis Diepholz', '49356 Diepholz · Barnstorf · Landkreis Diepholz']);
  });

  it('versteht Nominatim: Straße, Ort und Geschäft mit Adresse', () => {
    // Echte Antworten von nominatim.openstreetmap.org (gekürzt)
    const address = { suburb: 'Walsen', town: 'Barnstorf', municipality: 'Samtgemeinde Barnstorf', county: 'Landkreis Diepholz', state: 'Niedersachsen', postcode: '49406', country: 'Deutschland', country_code: 'de' };
    const road: NominatimPlace = { osm_type: 'way', osm_id: 23092155, lat: '52.7092911', lon: '8.5058151', category: 'highway', addresstype: 'primary', name: 'Lange Straße', place_rank: 26, boundingbox: ['52.7089940', '52.7096276', '8.5049626', '8.5066748'], address: { road: 'Lange Straße', ...address } };
    expect(nominatimResult(road)).toEqual({
      id: 'W23092155',
      kind: 'street',
      name: 'Lange Straße',
      detail: '49406 Barnstorf · Walsen · Landkreis Diepholz',
      lat: 52.7092911,
      lon: 8.5058151,
      bounds: [[52.708994, 8.5049626], [52.7096276, 8.5066748]],
      osm: 'W23092155',
    });
    const town: NominatimPlace = { osm_type: 'relation', osm_id: 1461203, lat: '52.708931', lon: '8.505279', category: 'boundary', addresstype: 'town', name: 'Barnstorf', place_rank: 16, address: { town: 'Barnstorf', county: 'Landkreis Diepholz' } };
    expect(nominatimResult(town)).toMatchObject({ kind: 'city', name: 'Barnstorf', detail: 'Landkreis Diepholz', osm: 'R1461203', bounds: null });
    const shop: NominatimPlace = { osm_type: 'way', osm_id: 390256498, lat: '52.7089168', lon: '8.5060633', category: 'shop', addresstype: 'shop', name: 'Barnstorfer Mode - & Sporthaus', place_rank: 30, address: { house_number: '3', road: 'Lange Straße', ...address } };
    expect(nominatimResult(shop)).toMatchObject({ kind: 'house', detail: 'Lange Straße 3 · 49406 Barnstorf · Walsen · Landkreis Diepholz' });
    const plain: NominatimPlace = { osm_type: 'node', osm_id: 5, lat: '52.7', lon: '8.5', category: 'place', addresstype: 'place', place_rank: 30, address: { house_number: '5', road: 'Lange Straße', ...address } };
    expect(nominatimResult(plain)).toMatchObject({ kind: 'house', name: 'Lange Straße 5', detail: '49406 Barnstorf · Walsen · Landkreis Diepholz', osm: 'N5' });
    expect(nominatimResult({ osm_type: 'relation', osm_id: 1, lat: '1', lon: '2', addresstype: 'suburb', name: 'Walsen' })!.kind).toBe('district');
    expect(nominatimResult({ osm_type: 'node', osm_id: 2, lat: '1', lon: '2', addresstype: 'hamlet', name: 'Dörpel' })!.kind).toBe('locality');
  });

  it('fragt lokales Nominatim mit Suchfenster und weicht bei leerer Antwort auf den öffentlichen Dienst aus', async () => {
    const nominatim = { id: 'ortssuche-nominatim', name: 'Ortssuche (lokal)', type: 'nominatim' as const, url: 'http://10.0.0.2:8088' };
    const town: NominatimPlace = { osm_type: 'relation', osm_id: 1461203, lat: '52.708931', lon: '8.505279', addresstype: 'town', name: 'Barnstorf', place_rank: 16 };
    const answers: Record<string, unknown> = { 'http://10.0.0.2:8088/search': [town], [ONLINE]: [street(2, { name: 'Online-Straße' })] };
    const f = fakeFetch(answers as Record<string, object>);
    const geo = new GeocoderService({ onlineUrl: ONLINE, userAgent: 'ELVIS-Test' }, f.fetch);
    geo.setProvisions([nominatim]);
    expect(await geo.search('Barnstorf', { lat: 52.71, lon: 8.5 })).toMatchObject({ source: 'Ortssuche (lokal)', results: [{ name: 'Barnstorf', osm: 'R1461203' }] });
    expect(f.calls[0]).toBe('http://10.0.0.2:8088/search?q=Barnstorf&format=jsonv2&addressdetails=1&limit=8&accept-language=de&viewbox=8.2000%2C52.8900%2C8.8000%2C52.5300');

    // Halb getippt: lokal nichts, öffentlich schon
    answers['http://10.0.0.2:8088/search'] = [];
    expect(await geo.search('Barnst', null)).toMatchObject({ source: 'photon.example', results: [{ name: 'Online-Straße' }] });
    // Offline und lokal nichts gefunden: kein Ausfall, nur keine Treffer
    answers[ONLINE] = new Error('offline');
    expect(await geo.search('Xyzzy', null)).toEqual({ results: [], source: 'Ortssuche (lokal)', problem: null });
  });

  it('lädt Umrisse lokal oder öffentlich, speichert sie und nutzt veraltete, wenn nichts erreichbar ist', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'elvis-outline-'));
    const polygon = { type: 'Polygon', coordinates: [[[8.4, 52.6], [8.5, 52.6], [8.5, 52.7], [8.4, 52.6]]] };
    const lookup = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: polygon }] };
    const answers: Record<string, unknown> = { 'http://10.0.0.2:8088/lookup': lookup, 'https://nominatim.example/lookup': lookup };
    const f = fakeFetch(answers as Record<string, object>);
    try {
      const geo = new GeocoderService({ onlineUrl: null, outlineUrl: 'https://nominatim.example', dataDir, userAgent: 'ELVIS-Test' }, f.fetch);
      // Nur Flächen: Punkte und Unsinn fragen keinen Dienst
      expect(await geo.outline('N123')).toBeNull();
      expect(await geo.outline('R1;DROP')).toBeNull();
      expect(f.calls).toEqual([]);

      // Ohne Addon: öffentliches Nominatim, danach aus dem Datenverzeichnis
      expect(await geo.outline('R1461203')).toEqual(polygon);
      expect(f.calls).toEqual(['https://nominatim.example/lookup?osm_ids=R1461203&format=geojson&polygon_geojson=1&polygon_threshold=0.00005']);
      expect(existsSync(join(dataDir, 'outlines', 'R1461203.json'))).toBe(true);
      expect(await geo.outline('R1461203')).toEqual(polygon);
      expect(f.calls).toHaveLength(1);

      // Mit Addon: lokales Nominatim zuerst
      geo.setProvisions([{ id: 'n', name: 'Ortssuche (lokal)', type: 'nominatim', url: 'http://10.0.0.2:8088/' }]);
      expect(await geo.outline('R2922547')).toEqual(polygon);
      expect(f.calls.at(-1)).toMatch(/^http:\/\/10\.0\.0\.2:8088\/lookup\?osm_ids=R2922547&/);

      // Veraltet (älter als 90 Tage) und kein Dienst erreichbar → gespeicherter Umriss
      const old = new Date(Date.now() - 100 * 24 * 3600_000);
      utimesSync(join(dataDir, 'outlines', 'R1461203.json'), old, old);
      answers['http://10.0.0.2:8088/lookup'] = new Error('offline');
      answers['https://nominatim.example/lookup'] = new Error('offline');
      expect(await geo.outline('R1461203')).toEqual(polygon);
      // Kein Umriss in der Antwort (z. B. Punkt) → null
      answers['http://10.0.0.2:8088/lookup'] = { type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [8, 52] } }] };
      expect(await geo.outline('R999')).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('ist über /api/map/search ohne Anmeldung erreichbar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'elvis-geo-'));
    const f = fakeFetch({ 'https://photon.komoot.io': [street(1)] });
    const app = await buildApp(parseConfig({ dataDir, map: { userAgent: 'ELVIS-Test' } }), { logger: false, geocodeFetch: f.fetch });
    try {
      const res = await app.server.inject({ method: 'GET', url: '/api/map/search?q=Lange%20Stra%C3%9Fe&lat=52.7&lon=8.5' });
      expect(res.statusCode).toBe(200);
      expect(res.json<GeocodeResponse>()).toMatchObject({ source: 'photon.komoot.io', results: [{ name: 'Lange Straße' }] });
      expect((await app.server.inject({ method: 'GET', url: '/api/map/search?q=x&lat=200&lon=8' })).statusCode).toBe(400);
      expect((await app.server.inject({ method: 'GET', url: '/api/map/outline/N1' })).statusCode).toBe(404);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
