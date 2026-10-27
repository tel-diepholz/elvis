import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Incident, MapHistoryState, MapObject, Unit } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let cookie = '';

async function req<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

/** Zeitpunkt zwischen zwei Änderungen (die Zeitstempel haben Millisekunden) */
async function moment(): Promise<string> {
  await new Promise((r) => setTimeout(r, 5));
  const t = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  return t;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-history-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  cookie = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Zeitstrahl der Lagekarte', () => {
  it('zeigt Objekte, Kräfte und Einsatzort so, wie sie zu einem Zeitpunkt waren', async () => {
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand', keyword: 'B3' })).body;
    const history = async (at: string) => (await req<MapHistoryState>('GET', `/api/incidents/${incident.id}/map-history?at=${encodeURIComponent(at)}`)).body;
    const t0 = await moment();

    const point = (await req<MapObject>('POST', `/api/incidents/${incident.id}/objects`, { kind: 'point', name: 'Hydrant', lat: 52.7, lon: 8.5, data: { detail: '' } })).body;
    const unit = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'HLF 1' })).body;
    await req('PATCH', `/api/units/${unit.id}`, { lat: 52.71, lon: 8.51 });
    await req('PATCH', `/api/incidents/${incident.id}`, { lat: 52.72, lon: 8.52 });
    const t1 = await moment();

    await req('PATCH', `/api/map-objects/${point.id}`, { name: 'Hydrant Nord', lat: 52.701 });
    await req('PATCH', `/api/units/${unit.id}`, { lat: 52.73, lon: 8.53 });
    // Änderungen ohne Bezug zur Karte erzeugen keinen neuen Stand
    await req('PATCH', `/api/units/${unit.id}`, { notes: 'Wasser knapp' });
    const t2 = await moment();

    await req('DELETE', `/api/map-objects/${point.id}`);
    const t3 = await moment();

    expect((await history(t0)).objects).toEqual([]);
    expect((await history(t0)).units).toEqual([]);

    const at1 = await history(t1);
    expect(at1.objects).toMatchObject([{ id: point.id, name: 'Hydrant', lat: 52.7 }]);
    expect(at1.units).toMatchObject([{ id: unit.id, lat: 52.71, lon: 8.51 }]);
    expect(at1.incident).toEqual({ lat: 52.72, lon: 8.52, vehicleVisible: true });

    const at2 = await history(t2);
    expect(at2.objects).toMatchObject([{ id: point.id, name: 'Hydrant Nord', lat: 52.701 }]);
    expect(at2.units).toMatchObject([{ id: unit.id, lat: 52.73, lon: 8.53 }]);

    // Entfernte Objekte kennt nur noch der Verlauf
    expect((await history(t3)).objects).toEqual([]);
    expect((await history(t2)).objects).toHaveLength(1);

    // Kraft: angelegt, gesetzt, verschoben – die Notiz zählt nicht
    const db = new Database(join(dataDir, 'elvis.sqlite'), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM map_history WHERE subject = 'unit'").get()).toEqual({ n: 3 });
    db.close();

    expect((await req('GET', `/api/incidents/${incident.id}/map-history?at=gestern`)).status).toBe(400);
    expect((await req('GET', `/api/incidents/${incident.id}/map-history?at=2000-01-01T00:00:00.000Z`)).status).toBe(400);
  });
});
