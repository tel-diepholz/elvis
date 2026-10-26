import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Aircraft, AircraftDetail, AircraftPhoto, Incident, JournalEntry, MapObject, Ship, TrackedData, TrafficHit, TrafficResult, TrafficSettings, User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { TrafficHttpError, type AisSocket } from '../services/traffic.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

// Antworten wie von opendata.adsb.fi (gekürzt)
const RYANAIR = { hex: '4cadc1', type: 'adsb_icao', flight: 'RYR963Z ', r: 'EI-IGO', t: 'B38M', desc: 'BOEING 737 MAX 8', ownOp: 'Ryanair', year: '2021', emergency: 'none', baro_rate: -64, ias: 290, mach: 0.78, alt_baro: 35000, gs: 568.9, track: 105.18, squawk: '4635', category: 'A3', lat: 52.1386, lon: 7.4736, seen_pos: 0.4 };
const MLAT = { hex: '3c4b26', type: 'mlat', flight: 'CHX31   ', r: 'D-HDSN', t: 'EC35', alt_baro: 1500, gs: 110, track: 270, category: 'A7', lat: 52.61, lon: 8.35, seen_pos: 2 };
const GROUND = { hex: '3c6444', type: 'adsb_icao', flight: 'DLH4AB', alt_baro: 'ground', gs: 3, lat: 53.63, lon: 9.99, seen_pos: 1 };
const NOPOS = { hex: '3c0001', type: 'mode_s', alt_baro: 12000 };
const OLD = { hex: '3c0002', type: 'adsb_icao', lat: 52.5, lon: 8.4, seen_pos: 120 };

let app: App;
let admin = '';
let dataDir: string;
let requests: string[];
let responses: Record<string, unknown>;
let failing: boolean | 429;
let sockets: FakeSocket[];

class FakeSocket implements AisSocket {
  sent: unknown[] = [];
  closed = false;
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  constructor(readonly url: string) {}
  on(event: string, cb: (...args: never[]) => void): void {
    (this.handlers[event] ??= []).push(cb as (arg?: unknown) => void);
  }
  opened = false;
  send(data: string): void {
    // wie ws: Senden vor „open“ wirft
    if (!this.opened) throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  emit(event: string, arg?: unknown): void {
    if (event === 'open') this.opened = true;
    this.handlers[event]?.forEach((h) => h(arg));
  }
}

async function build(): Promise<App> {
  return buildApp(parseConfig({ dataDir }), {
    logger: false,
    trafficRequestGapMs: 0,
    trafficFetch: async (url) => {
      requests.push(url);
      if (failing === 429) throw new TrafficHttpError(429, 20);
      if (failing) throw new Error('fetch failed');
      const path = new URL(url).pathname;
      return responses[path] ?? { ac: [] };
    },
    aisSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
}

beforeEach(async () => {
  requests = [];
  responses = { '/api/v2/lat/52.5/lon/8.5/dist/100': { aircraft: [RYANAIR, MLAT, GROUND, NOPOS, OLD] } };
  failing = false;
  sockets = [];
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-traffic-'));
  app = await build();
  admin = await adminCookie(app);
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function req<T>(method: 'GET' | 'PUT' | 'POST' | 'PATCH', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

const startIncident = async (lat = 52.6, lon = 8.37) => {
  const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Vermisste Person', keyword: 'TH' })).body;
  await req('PATCH', `/api/incidents/${incident.id}`, { lat, lon });
  return incident;
};

describe('Flugzeuge', () => {
  it('liefert ADS-B- und MLAT-Ziele mit Position und teilt sich gerundete Abfragen', async () => {
    const res = await req<TrafficResult<Aircraft>>('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('adsb.fi');
    expect(res.body.items.map((a) => [a.hex, a.source])).toEqual([
      ['4cadc1', 'adsb'],
      ['3c4b26', 'mlat'],
      ['3c6444', 'adsb'],
    ]);
    expect(res.body.items[0]).toMatchObject({ callsign: 'RYR963Z', registration: 'EI-IGO', type: 'B38M', altFt: 35000, speedKt: 568.9, track: 105.18, onGround: false });
    expect(res.body.items[2]).toMatchObject({ onGround: true, altFt: 0 });
    // Leicht verschobene Karte: gleiche gerundete Abfrage aus dem Cache
    await req('GET', '/api/traffic/aircraft?lat=52.65&lon=8.45&radius=35');
    expect(requests).toEqual(['https://opendata.adsb.fi/api/v2/lat/52.5/lon/8.5/dist/100']);
  });

  it('meldet einen ausgefallenen Dienst', async () => {
    failing = true;
    const res = await req<TrafficResult<Aircraft>>('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40');
    expect(res.body.items).toEqual([]);
    expect(res.body.problem).toMatch(/adsb.fi nicht erreichbar/);
  });

  it('pausiert nach HTTP 429 und zeigt bis dahin den letzten Stand', async () => {
    expect((await req<TrafficResult<Aircraft>>('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40')).body.items).toHaveLength(3);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    failing = 429;
    const throttled = (await req<TrafficResult<Aircraft>>('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40')).body;
    expect(throttled.items).toHaveLength(3);
    expect(throttled.problem).toMatch(/HTTP 429/);
    // Während der Pause (Retry-After 20 s) keine weitere Anfrage an den Dienst
    failing = false;
    vi.setSystemTime(Date.now() + 10_000);
    const paused = (await req<TrafficResult<Aircraft>>('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40')).body;
    expect(paused.problem).toMatch(/drosselt/);
    expect(requests).toHaveLength(2);
    vi.setSystemTime(Date.now() + 15_000);
    expect((await req<TrafficResult<Aircraft>>('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40')).body.problem).toBeNull();
  });

  it('sucht nach Rufzeichen, Kennzeichen und ICAO-Adresse', async () => {
    responses['/api/v2/callsign/RYR963Z'] = { ac: [RYANAIR] };
    responses['/api/v2/registration/D-HDSN'] = { ac: [MLAT] };
    responses['/api/v2/hex/4cadc1'] = { ac: [RYANAIR] };
    expect((await req<TrafficResult<TrafficHit>>('GET', '/api/traffic/search?q=ryr963z')).body.items.map((h) => h.kind === 'aircraft' && h.hex)).toEqual(['4cadc1']);
    expect((await req<TrafficResult<TrafficHit>>('GET', '/api/traffic/search?q=D-HDSN')).body.items.map((h) => h.kind === 'aircraft' && h.callsign)).toEqual(['CHX31']);
    expect((await req<TrafficResult<TrafficHit>>('GET', '/api/traffic/search?q=4CADC1')).body.items).toHaveLength(1);
    expect(requests).toEqual([
      'https://opendata.adsb.fi/api/v2/callsign/RYR963Z',
      'https://opendata.adsb.fi/api/v2/registration/RYR963Z',
      'https://opendata.adsb.fi/api/v2/registration/D-HDSN',
      'https://opendata.adsb.fi/api/v2/hex/4cadc1',
    ]);
  });

  it('lassen sich abschalten', async () => {
    await req('PUT', '/api/system/traffic', { aircraft: false, ships: true });
    const res = await req<TrafficResult<Aircraft>>('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40');
    expect(res.body.problem).toMatch(/abgeschaltet/);
    expect(requests).toEqual([]);
  });
});

describe('Detailseiten', () => {
  it('liefern ein Flugzeug mit Typ, Halter und Foto (planespotters, einen Tag gemerkt)', async () => {
    responses['/api/v2/hex/4cadc1'] = { ac: [RYANAIR] };
    responses['/pub/photos/hex/4cadc1'] = {
      photos: [{ thumbnail_large: { src: 'https://t.plnspttrs.net/1_280.jpg', size: { width: 420, height: 280 } }, link: 'https://www.planespotters.net/photo/1', photographer: 'Karl D.' }],
    };
    const detail = (await req<{ aircraft: AircraftDetail; problem: string | null }>('GET', '/api/traffic/aircraft/4cadc1')).body;
    expect(detail.aircraft).toMatchObject({ callsign: 'RYR963Z', description: 'BOEING 737 MAX 8', operator: 'Ryanair', year: '2021', vertRateFpm: -64, iasKt: 290, mach: 0.78, emergency: null });
    const photo = async () => (await req<{ photo: AircraftPhoto | null }>('GET', '/api/traffic/aircraft/4cadc1/photo')).body.photo;
    expect(await photo()).toEqual({ src: 'https://t.plnspttrs.net/1_280.jpg', width: 420, height: 280, link: 'https://www.planespotters.net/photo/1', photographer: 'Karl D.' });
    await photo();
    expect(requests.filter((u) => u.includes('planespotters'))).toEqual(['https://api.planespotters.net/pub/photos/hex/4cadc1']);
    expect((await req('GET', '/api/traffic/aircraft/XYZ')).status).toBe(400);
  });
});

describe('Verfolgte Flugzeuge', () => {
  it('folgen der Live-Position ohne Tagebuchflut und melden Signalverlust einmal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
    const incident = await startIncident();
    const added = await req<MapObject>('POST', `/api/incidents/${incident.id}/objects`, { kind: 'aircraft', name: 'CHX31', lat: 52.61, lon: 8.35, data: { id: '3c4b26', detail: 'EC35 · D-HDSN' } });
    expect(added.status).toBe(201);

    responses['/api/v2/hex/3c4b26'] = { ac: [MLAT] };
    await app.traffic.track();
    responses['/api/v2/hex/3c4b26'] = { ac: [{ ...MLAT, lat: 52.62, lon: 8.3, seen_pos: 0 }] };
    vi.setSystemTime(new Date('2026-10-26T10:00:10Z'));
    await app.traffic.track();

    const objects = async () => (await req<MapObject[]>('GET', `/api/incidents/${incident.id}/objects`)).body;
    const tracked = (await objects())[0]!;
    expect([tracked.lat, tracked.lon]).toEqual([52.62, 8.3]);
    expect((tracked.data as TrackedData).trail).toEqual([
      [52.61, 8.35],
      [52.62, 8.3],
    ]);
    expect((tracked.data as TrackedData).last).toMatchObject({ altFt: 1500, speedKt: 110 });

    // Verschieben von Hand geht nicht
    expect((await req('PATCH', `/api/map-objects/${tracked.id}`, { lat: 52 })).status).toBe(400);

    // Kein Empfang mehr: erst nach 3 Minuten „kein Signal“, und nur einmal
    responses['/api/v2/hex/3c4b26'] = { ac: [] };
    await app.traffic.track();
    vi.setSystemTime(new Date('2026-10-26T10:04:00Z'));
    await app.traffic.track();
    await app.traffic.track();
    expect((await objects())[0]!.data).toMatchObject({ lostSince: '2026-10-26T10:00:10.000Z' });

    responses['/api/v2/hex/3c4b26'] = { ac: [{ ...MLAT, lat: 52.63, seen_pos: 0 }] };
    await app.traffic.track();
    const texts = (await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body.map((e) => e.text);
    expect(texts.filter((t) => t.includes('CHX31'))).toEqual(['Kartenobjekt hinzugefügt: Flugzeug „CHX31“', 'Flugzeug „CHX31“: kein Signal mehr', 'Flugzeug „CHX31“: Signal wieder da']);
  });
});

describe('Verfolgung spart Anfragen', () => {
  it('übernimmt die Position aus einer frischen Gebietsabfrage statt einzeln nachzufragen', async () => {
    const incident = await startIncident();
    await req('POST', `/api/incidents/${incident.id}/objects`, { kind: 'aircraft', name: 'CHX31', lat: 52.6, lon: 8.3, data: { id: '3c4b26' } });
    await req('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40');
    await app.traffic.track();
    expect(requests).toEqual(['https://opendata.adsb.fi/api/v2/lat/52.5/lon/8.5/dist/100']);
    expect((await req<MapObject[]>('GET', `/api/incidents/${incident.id}/objects`)).body[0]).toMatchObject({ lat: 52.61, lon: 8.35 });
  });
});

describe('Schiffe (AIS)', () => {
  const position = (mmsi: number, lat: number, lon: number, name = 'WESERSTAR') =>
    JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: `${name}           `, latitude: lat, longitude: lon }, Message: { PositionReport: { UserID: mmsi, Latitude: lat, Longitude: lon, Sog: 8.4, Cog: 312.5, TrueHeading: 511, NavigationalStatus: 0 } } });

  it('verbindet erst mit Schlüssel, führt Position und Stammdaten zusammen und folgt dem Einsatzort', async () => {
    expect((await req<TrafficResult<Ship>>('GET', '/api/traffic/ships?south=52&west=8&north=53&east=9')).body.problem).toMatch(/Schlüssel/);
    expect(sockets).toHaveLength(0);

    const saved = await req<TrafficSettings>('PUT', '/api/system/traffic', { aircraft: true, ships: true, aisKey: 'geheimer-schluessel-123' });
    expect(saved.body).toMatchObject({ aisKeySet: true });
    expect(JSON.stringify(saved.body)).not.toContain('geheimer');
    // Ohne Einsatz abonniert ELVIS das Gebiet um die Fahrzeugposition (hier: Simulation der Wetterstation)
    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    ws.emit('open');
    expect(ws.sent[0]).toMatchObject({ APIKey: 'geheimer-schluessel-123', FilterMessageTypes: expect.arrayContaining(['PositionReport', 'ShipStaticData']) });

    // Einsatzort in Bremen: neues Gebiet über dieselbe Verbindung
    await startIncident(53.08, 8.8);
    await app.traffic.track();
    expect(sockets).toHaveLength(1);
    expect(ws.sent.at(-1)).toMatchObject({ BoundingBoxes: [[[52.08, 7.3], [54.08, 10.3]]] });
    const subscriptions = ws.sent.length;

    ws.emit('message', Buffer.from(position(211234560, 53.1, 8.75)));
    ws.emit('message', JSON.stringify({ MessageType: 'ShipStaticData', MetaData: { MMSI: 211234560 }, Message: { ShipStaticData: { UserID: 211234560, Name: 'WESERSTAR@@@@', CallSign: 'DA1234', Type: 79, Destination: 'BREMEN' } } }));
    ws.emit('message', position(211999999, 55.5, 8.0, 'FERN')); // außerhalb des Ausschnitts

    expect((await req<{ ship: Ship | null }>('GET', '/api/traffic/ships/211234560')).body.ship).toMatchObject({ name: 'WESERSTAR', destination: 'BREMEN' });
    expect((await req<{ ship: Ship | null }>('GET', '/api/traffic/ships/211000000')).body.ship).toBeNull();
    const ships = (await req<TrafficResult<Ship>>('GET', '/api/traffic/ships?south=53&west=8.5&north=53.2&east=9')).body;
    expect(ships.items).toHaveLength(1);
    expect(ships.items[0]).toMatchObject({ mmsi: '211234560', name: 'WESERSTAR', callsign: 'DA1234', shipType: 79, destination: 'BREMEN', sogKn: 8.4, cog: 312.5, heading: null });
    expect((await req<TrafficResult<TrafficHit>>('GET', '/api/traffic/search?q=wesers')).body.items.map((h) => h.kind)).toEqual(['ship']);

    // Kleine Verschiebung (unter 20 km): kein neues Abo
    await req('PATCH', `/api/incidents/${(await req<Incident>('GET', '/api/incidents/active')).body.id}`, { lat: 53.1, lon: 8.82 });
    await app.traffic.track();
    expect(ws.sent).toHaveLength(subscriptions);

    // Schiffe abschalten: Verbindung zu
    await req('PUT', '/api/system/traffic', { aircraft: true, ships: false });
    expect(ws.closed).toBe(true);
  });

  it('sendet ein während des Verbindungsaufbaus geändertes Gebiet erst nach „open“', async () => {
    await req('PUT', '/api/system/traffic', { aircraft: true, ships: true, aisKey: 'geheimer-schluessel-123' });
    expect(sockets).toHaveLength(1);
    // Einsatzort setzen, solange die Verbindung noch aufgebaut wird: kein Fehler, kein vorzeitiges Abo
    await startIncident(53.54, 8.58);
    expect((await req('GET', '/api/traffic/ships?south=53&west=8&north=54&east=9')).status).toBe(200);
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.emit('open');
    expect(sockets[0]!.sent).toEqual([expect.objectContaining({ BoundingBoxes: [[[52.54, 7.08], [54.54, 10.08]]] })]);
  });

  it('Einstellungen nur für Admins', async () => {
    const user = (await req<User>('POST', '/api/users', { firstName: 'Anna', lastName: 'Test', pin: '1111' })).body;
    const login = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
    const anna = sessionCookie(login.headers['set-cookie']);
    expect((await req('GET', '/api/system/traffic', undefined, anna)).status).toBe(403);
    expect((await req('GET', '/api/traffic/aircraft?lat=52.6&lon=8.37&radius=40', undefined, anna)).status).toBe(200);
  });
});
