import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DASHBOARD, type DashboardLayout, type DashboardResponse, type Incident, type User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const layout: DashboardLayout = {
  tiles: [
    { id: 'a', type: 'map', x: 0, y: 0, w: 12, h: 6, config: { zoom: 14 } },
    { id: 'b', type: 'tasks', x: 0, y: 6, w: 6, h: 4, config: {} },
  ],
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-dashboard-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Übersicht je Benutzer', () => {
  it('liefert ohne eigene Anordnung die Grundeinstellung und verlangt eine Anmeldung', async () => {
    const res = await req<DashboardResponse>('GET', '/api/me/dashboard');
    expect(res.body).toEqual({ layout: DEFAULT_DASHBOARD, custom: false, updatedAt: null });
    expect((await req('GET', '/api/me/dashboard', undefined, '')).status).toBe(401);
    expect((await req('PUT', '/api/me/dashboard', layout, '')).status).toBe(401);
  });

  it('speichert je Benutzer, überdauert den Einsatz und lässt sich zurücksetzen', async () => {
    const saved = await req<DashboardResponse>('PUT', '/api/me/dashboard', layout);
    expect(saved.status).toBe(200);
    expect(saved.body.custom).toBe(true);
    expect(saved.body.layout).toEqual(layout);

    // Zweiter Benutzer sieht weiter die Grundeinstellung
    const created = await req<User>('POST', '/api/users', { firstName: 'Erika', lastName: 'Muster', pin: '1234', isAdmin: false });
    expect(created.status).toBe(201);
    const login = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: created.body.id, pin: '1234' } });
    const erika = sessionCookie(login.headers['set-cookie']);
    expect((await req<DashboardResponse>('GET', '/api/me/dashboard', undefined, erika)).body.custom).toBe(false);

    // Einsatz eröffnen und abschließen ändert nichts
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand', keyword: 'F2' })).body;
    await req('POST', `/api/incidents/${incident.id}/close`);
    expect((await req<DashboardResponse>('GET', '/api/me/dashboard')).body.layout).toEqual(layout);

    const reset = await req<DashboardResponse>('DELETE', '/api/me/dashboard');
    expect(reset.body).toEqual({ layout: DEFAULT_DASHBOARD, custom: false, updatedAt: null });
  });

  it('lehnt überlappende, zu breite und unbekannte Kacheln ab', async () => {
    const overlap = { tiles: [layout.tiles[0], { ...layout.tiles[1], y: 2 }] };
    expect((await req('PUT', '/api/me/dashboard', overlap)).status).toBe(400);
    expect((await req('PUT', '/api/me/dashboard', { tiles: [{ ...layout.tiles[0], x: 1 }] })).status).toBe(400);
    expect((await req('PUT', '/api/me/dashboard', { tiles: [{ ...layout.tiles[0], type: 'scenes' }] })).status).toBe(400);
    expect((await req('PUT', '/api/me/dashboard', { tiles: [layout.tiles[0], { ...layout.tiles[1], id: 'a' }] })).status).toBe(400);
  });
});
