import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { DisplayDevice, DisplaySelf, ServerMessage } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T, setCookie: res.headers['set-cookie'] };
}

const until = async (cond: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 20));
  expect(await cond()).toBe(true);
};

/** Bildschirm koppeln: Code anfordern (Cookie), Admin trägt ihn ein */
async function pairDisplay(name: string): Promise<{ cookie: string; display: DisplayDevice }> {
  const start = await req<DisplaySelf>('POST', '/api/display/pair', undefined, '');
  const cookie = String(start.setCookie).split(';')[0]!;
  expect(start.body.state).toBe('pending');
  const code = (start.body as { code: string }).code;
  const paired = await req<DisplayDevice>('POST', '/api/system/displays/pair', { code, name });
  expect(paired.status).toBe(201);
  return { cookie, display: paired.body };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-test-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Bildschirme: Kopplung', () => {
  it('koppelt per Code, erkennt den Bildschirm am Cookie und lässt sich widerrufen', async () => {
    expect((await req<DisplaySelf>('GET', '/api/display/self', undefined, '')).body).toEqual({ state: 'unpaired' });
    const start = await req<DisplaySelf>('POST', '/api/display/pair', undefined, '');
    expect(start.body).toMatchObject({ state: 'pending', code: expect.stringMatching(/^\d{6}$/) });
    expect(String(start.setCookie)).toMatch(/elvis_display=.*HttpOnly/);
    const cookie = String(start.setCookie).split(';')[0]!;
    // erneutes Anfordern mit demselben Cookie liefert denselben Code
    expect((await req<DisplaySelf>('POST', '/api/display/pair', undefined, cookie)).body).toEqual(start.body);

    expect((await req('POST', '/api/system/displays/pair', { code: '000000', name: 'X' })).status).toBe(404);
    expect((await req('POST', '/api/system/displays/pair', { code: (start.body as { code: string }).code, name: 'Lagetisch' }, '')).status).toBe(401);
    const paired = await req<DisplayDevice>('POST', '/api/system/displays/pair', { code: (start.body as { code: string }).code, name: 'Lagetisch' });
    expect(paired.body).toMatchObject({ name: 'Lagetisch', layout: { cols: 12, rows: 8, tiles: [] }, online: false });

    const self = await req<DisplaySelf>('GET', '/api/display/self', undefined, cookie);
    expect(self.body).toMatchObject({ state: 'paired', display: { id: paired.body.id, name: 'Lagetisch' } });
    // derselbe Code funktioniert kein zweites Mal
    expect((await req('POST', '/api/system/displays/pair', { code: (start.body as { code: string }).code, name: 'Doppelt' })).status).toBe(404);

    expect((await req('POST', '/api/display/heartbeat', { width: 1920, height: 1080 }, cookie)).status).toBe(204);
    expect((await req<DisplayDevice[]>('GET', '/api/displays', undefined, '')).body[0]).toMatchObject({ screen: { width: 1920, height: 1080 } });

    // Gekoppelte Bildschirme dürfen den laufenden Einsatz lesen, sonst nichts aus dem Einsatz
    await req('POST', '/api/incidents', { title: 'Brand', keyword: 'B3' });
    expect((await req('GET', '/api/incidents/active', undefined, cookie)).status).toBe(200);
    expect((await req('GET', '/api/incidents', undefined, cookie)).status).toBe(401);
    expect((await req('GET', '/api/incidents/active', undefined, '')).status).toBe(401);

    await req('DELETE', `/api/system/displays/${paired.body.id}`);
    expect((await req<DisplaySelf>('GET', '/api/display/self', undefined, cookie)).body).toEqual({ state: 'unpaired' });
    expect((await req('GET', '/api/incidents/active', undefined, cookie)).status).toBe(401);
  });
});

describe('Bildschirme: Layout und Fernsteuerung', () => {
  it('prüft Layouts, meldet Online-Status und schickt Befehle nur an den richtigen Bildschirm', async () => {
    const a = await pairDisplay('Lagetisch');
    const b = await pairDisplay('Monitor Führungsraum');
    const user = admin;

    const tile = (id: string, type: string, x: number, y: number, w: number, h: number, config = {}) => ({ id, type, x, y, w, h, config });
    const good = { cols: 12, rows: 8, tiles: [tile('t1', 'map', 0, 0, 8, 8, { follow: true }), tile('t2', 'clock', 8, 0, 4, 2), tile('t3', 'camera', 8, 2, 4, 3, { cameraId: 'cam-1' })] };
    const saved = await req<DisplayDevice>('PUT', `/api/displays/${a.display.id}/layout`, { layout: good }, user);
    expect(saved.status).toBe(200);
    expect(saved.body.layout.tiles).toHaveLength(3);
    const overlap = await req<{ error: string }>('PUT', `/api/displays/${a.display.id}/layout`, { layout: { ...good, tiles: [...good.tiles, tile('t4', 'alerts', 7, 0, 2, 2)] } }, user);
    expect(overlap.body.error).toMatch(/überlappen/);
    expect((await req<{ error: string }>('PUT', `/api/displays/${a.display.id}/layout`, { layout: { ...good, tiles: [tile('t1', 'map', 10, 0, 4, 2)] } }, user)).body.error).toMatch(/ragt über das Raster/);
    expect((await req('PUT', `/api/displays/${a.display.id}/layout`, { layout: good }, '')).status).toBe(401);

    // Bildschirme verbinden sich per WebSocket
    await app.server.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.server.address() as AddressInfo).port;
    const connect = (cookie: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { cookie } });
      const messages: ServerMessage[] = [];
      ws.on('message', (m) => messages.push(JSON.parse(String(m)) as ServerMessage));
      return { ws, messages };
    };
    const wa = connect(a.cookie);
    const wb = connect(b.cookie);
    await until(async () => (await req<DisplayDevice[]>('GET', '/api/displays')).body.every((d) => d.online));

    expect((await req('POST', `/api/displays/${a.display.id}/command`, { action: 'identify' }, user)).status).toBe(200);
    await until(() => wa.messages.some((m) => m.type === 'displayCommand'));
    expect(wa.messages.find((m) => m.type === 'displayCommand')).toEqual({ type: 'displayCommand', action: 'identify' });
    expect(wb.messages.some((m) => m.type === 'displayCommand')).toBe(false);
    // Layout-Änderung erreicht alle als Invalidierung
    expect(wb.messages.some((m) => m.type === 'invalidate' && m.topics.includes('displays'))).toBe(true);

    wb.ws.close();
    await until(async () => (await req<DisplayDevice[]>('GET', '/api/displays')).body.find((d) => d.id === b.display.id)?.online === false);
    expect((await req<{ error: string }>('POST', `/api/displays/${b.display.id}/command`, { action: 'reload' }, user)).body.error).toMatch(/nicht verbunden/);

    // Entkoppeln trennt die Verbindung
    const closed = new Promise<number>((r) => wa.ws.on('close', (code) => r(code)));
    await req('DELETE', `/api/system/displays/${a.display.id}`);
    expect(await closed).toBe(4001);

    const audit = (await req<{ message: string }[]>('GET', '/api/audit')).body.map((x) => x.message);
    expect(audit).toEqual(expect.arrayContaining(['Bildschirm „Lagetisch“ gekoppelt', 'Lagetisch: 3 Kachel(n) – Lagekarte, Uhr, Kamera', 'Lagetisch: erkennen', 'Bildschirm „Lagetisch“ entkoppelt']));
    app.server.server.closeAllConnections();
  });

  it('steuert Kartenkacheln fern und merkt sich den vom Bildschirm gemeldeten Ausschnitt', async () => {
    const a = await pairDisplay('Lagetisch');
    const layout = { cols: 12, rows: 8, tiles: [{ id: 'm1', type: 'map', x: 0, y: 0, w: 8, h: 8, config: { follow: false } }, { id: 'c1', type: 'clock', x: 8, y: 0, w: 4, h: 2, config: {} }] };
    await req('PUT', `/api/displays/${a.display.id}/layout`, { layout });
    const view = { lat: 52.6, lon: 8.37, zoom: 16 };

    // Der Bildschirm meldet seinen Ausschnitt (Gerätecookie), nur für Kartenkacheln
    expect((await req('POST', '/api/display/map-view', { tileId: 'm1', ...view }, '')).status).toBe(401);
    expect((await req('POST', '/api/display/map-view', { tileId: 'c1', ...view }, a.cookie)).status).toBe(404);
    expect((await req('POST', '/api/display/map-view', { tileId: 'm1', ...view, zoom: 40 }, a.cookie)).status).toBe(400);
    expect((await req('POST', '/api/display/map-view', { tileId: 'm1', ...view }, a.cookie)).status).toBe(204);
    expect((await req<DisplayDevice[]>('GET', '/api/displays', undefined, '')).body[0]?.mapViews).toEqual({ m1: view });

    // Fernsteuerung nur mit Anmeldung und nur an verbundene Bildschirme
    const next = { lat: 52.61, lon: 8.38, zoom: 17 };
    expect((await req('POST', `/api/displays/${a.display.id}/map-view`, { tileId: 'm1', ...next }, '')).status).toBe(401);
    expect((await req<{ error: string }>('POST', `/api/displays/${a.display.id}/map-view`, { tileId: 'm1', ...next })).body.error).toMatch(/nicht verbunden/);
    expect((await req<DisplayDevice[]>('GET', '/api/displays')).body[0]?.mapViews).toEqual({ m1: view });

    await app.server.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { cookie: a.cookie } });
    const messages: ServerMessage[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(String(m)) as ServerMessage));
    await until(async () => (await req<DisplayDevice[]>('GET', '/api/displays')).body[0]?.online === true);

    expect((await req('POST', `/api/displays/${a.display.id}/map-view`, { tileId: 'c1', ...next })).status).toBe(404);
    expect((await req('POST', `/api/displays/${a.display.id}/map-view`, { tileId: 'm1', ...next })).status).toBe(200);
    await until(() => messages.some((m) => m.type === 'displayMapView'));
    expect(messages.find((m) => m.type === 'displayMapView')).toEqual({ type: 'displayMapView', tileId: 'm1', view: next });
    expect((await req<DisplayDevice[]>('GET', '/api/displays')).body[0]?.mapViews).toEqual({ m1: next });

    // Verschwindet die Kachel aus der Anordnung, verschwindet auch ihr Ausschnitt
    await req('PUT', `/api/displays/${a.display.id}/layout`, { layout: { ...layout, tiles: [layout.tiles[1]] } });
    expect((await req<DisplayDevice[]>('GET', '/api/displays')).body[0]?.mapViews).toEqual({});
    ws.close();
    app.server.server.closeAllConnections();
  });
});

describe('Bildschirme: Szenen', () => {
  it('speichert Anordnungen als Szenen, erkennt die aktive und ruft sie auf', async () => {
    const { display } = await pairDisplay('Lagetisch');
    const tile = (id: string, type: string, x: number, y: number, w: number, h: number, config = {}) => ({ id, type, x, y, w, h, config });
    const lage = { cols: 12, rows: 8, tiles: [tile('m', 'map', 0, 0, 8, 8), tile('c', 'clock', 8, 0, 4, 2)] };
    const kameras = { cols: 12, rows: 8, tiles: [tile('k1', 'camera', 0, 0, 6, 4), tile('k2', 'camera', 6, 0, 6, 4, { cameraId: 'cam-2' })] };
    const layout = (l: unknown) => req<DisplayDevice>('PUT', `/api/displays/${display.id}/layout`, { layout: l });
    const get = async () => (await req<DisplayDevice[]>('GET', '/api/displays')).body.find((d) => d.id === display.id)!;

    await layout(lage);
    const s1 = await req<{ id: number; name: string; tiles: number }>('POST', `/api/displays/${display.id}/scenes`, { name: 'Lage' });
    expect(s1.status).toBe(201);
    expect(s1.body).toMatchObject({ name: 'Lage', tiles: 2 });
    expect((await get()).activeSceneId).toBe(s1.body.id);
    expect((await req<{ error: string }>('POST', `/api/displays/${display.id}/scenes`, { name: 'lage' })).body.error).toMatch(/gibt es schon/);

    await layout(kameras);
    expect((await get()).activeSceneId).toBeNull();
    const s2 = await req<{ id: number }>('POST', `/api/displays/${display.id}/scenes`, { name: 'Kameras' });
    // Reihenfolge der Kacheln spielt für die Erkennung keine Rolle
    await layout({ ...kameras, tiles: [...kameras.tiles].reverse() });
    expect((await get()).activeSceneId).toBe(s2.body.id);

    // Szene aufrufen
    const applied = await req<DisplayDevice>('POST', `/api/displays/${display.id}/scenes/${s1.body.id}/apply`);
    expect(applied.body.layout.tiles.map((t) => t.type)).toEqual(['map', 'clock']);
    expect(applied.body.activeSceneId).toBe(s1.body.id);
    expect((await req('POST', `/api/displays/${display.id}/scenes/${s1.body.id}/apply`, undefined, '')).status).toBe(401);

    // überschreiben mit aktueller Anordnung, umbenennen
    await layout({ ...lage, tiles: [tile('m', 'map', 0, 0, 12, 8)] });
    const over = await req<{ tiles: number }>('PUT', `/api/displays/${display.id}/scenes/${s1.body.id}`, { overwrite: true });
    expect(over.body.tiles).toBe(1);
    expect((await get()).activeSceneId).toBe(s1.body.id);
    expect((await req<{ name: string }>('PUT', `/api/displays/${display.id}/scenes/${s1.body.id}`, { name: 'Lage groß' })).body.name).toBe('Lage groß');
    expect((await req<{ error: string }>('PUT', `/api/displays/${display.id}/scenes/${s1.body.id}`, { name: 'Kameras' })).body.error).toMatch(/gibt es schon/);

    // Reihenfolge und Löschen
    await req('PUT', `/api/displays/${display.id}/scenes/order`, { ids: [s2.body.id, s1.body.id] });
    expect((await get()).scenes.map((s) => s.name)).toEqual(['Kameras', 'Lage groß']);
    expect((await req('DELETE', `/api/displays/${display.id}/scenes/${s2.body.id}`)).status).toBe(204);
    expect((await get()).scenes.map((s) => s.name)).toEqual(['Lage groß']);
    expect((await req('DELETE', `/api/displays/${display.id}/scenes/9999`)).status).toBe(404);

    const audit = (await req<{ message: string }[]>('GET', '/api/audit')).body.map((a) => a.message);
    expect(audit).toEqual(expect.arrayContaining(['Lagetisch: Szene „Lage“ gespeichert', 'Lagetisch: Szene „Lage“ angezeigt', 'Lagetisch: Szene „Lage“ mit aktueller Anordnung überschrieben', 'Lagetisch: Szene „Kameras“ gelöscht']));

    // Schutz: nur Admins schalten um; geschützt weder überschreiben noch löschen, umbenennen und aufrufen geht
    const lageId = s1.body.id;
    const user = await req<{ id: number }>('POST', '/api/users', { firstName: 'Anna', lastName: 'Test', pin: '1111' });
    const login = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.body.id, pin: '1111' } });
    const anna = sessionCookie(login.headers['set-cookie']);
    expect((await req('PUT', `/api/displays/${display.id}/scenes/${lageId}/lock`, { locked: true }, anna)).status).toBe(403);
    const locked = await req<DisplayDevice>('PUT', `/api/displays/${display.id}/scenes/${lageId}/lock`, { locked: true });
    expect(locked.body.scenes.find((s) => s.id === lageId)?.locked).toBe(true);
    expect((await req<{ error: string }>('PUT', `/api/displays/${display.id}/scenes/${lageId}`, { overwrite: true }, anna)).body.error).toMatch(/geschützt/);
    expect((await req('PUT', `/api/displays/${display.id}/scenes/${lageId}`, { overwrite: true })).status).toBe(409);
    expect((await req('DELETE', `/api/displays/${display.id}/scenes/${lageId}`)).status).toBe(409);
    expect((await req('PUT', `/api/displays/${display.id}/scenes/${lageId}`, { name: 'Lage' }, anna)).status).toBe(200);
    expect((await req('POST', `/api/displays/${display.id}/scenes/${lageId}/apply`, undefined, anna)).status).toBe(200);
    await req('PUT', `/api/displays/${display.id}/scenes/${lageId}/lock`, { locked: false });
    expect((await req('PUT', `/api/displays/${display.id}/scenes/${lageId}`, { overwrite: true }, anna)).status).toBe(200);

    // Entkoppeln löscht auch die Szenen
    await req('DELETE', `/api/system/displays/${display.id}`);
    const again = await pairDisplay('Neu');
    expect(again.display.scenes).toEqual([]);
  });
});
