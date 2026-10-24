import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User, Workstation, WorkstationLoginResult, WorkstationState } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

const SECRET = 'addon-geheimnis';
let app: App;
let dataDir: string;
let admin = '';

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = { cookie: admin }) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}
const asDevice = (token: string) => ({ authorization: `Bearer ${token}` });

async function enroll(mac = 'aa:bb:cc:dd:ee:01', hostname = 'elvis-ap-ee01') {
  const res = await req<{ workstation: Workstation; token: string }>('POST', '/api/clients/enroll', { hostname, mac }, asDevice(SECRET));
  expect(res.status).toBe(201);
  return res.body;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-test-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
  app.workstations.setProvisions([{ id: 'arbeitsplatz-ap', name: 'Arbeitsplätze', token: SECRET }]);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Arbeitsplätze: Registrierung', () => {
  it('nimmt nur das Token des Addons an und speichert das Gerätetoken gehasht', async () => {
    expect((await req('POST', '/api/clients/enroll', { hostname: 'x', mac: 'aa:bb:cc:dd:ee:01' }, asDevice('falsch'))).status).toBe(401);
    expect((await req('POST', '/api/clients/enroll', { hostname: 'x', mac: 'aa:bb:cc:dd:ee:01' }, {})).status).toBe(401);
    expect((await req('POST', '/api/clients/enroll', { hostname: 'x', mac: 'kaputt' }, asDevice(SECRET))).status).toBe(400);

    const { workstation, token } = await enroll();
    expect(workstation).toMatchObject({ name: 'elvis-ap-ee01', mac: 'aa:bb:cc:dd:ee:01' });
    const row = app.server && (await req<Workstation[]>('GET', '/api/system/workstations')).body;
    expect(row).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain(token);

    const state = await req<WorkstationState>('GET', '/api/clients/state', undefined, asDevice(token));
    expect(state.status).toBe(200);
    expect(state.body.users.map((u) => u.lastName)).toEqual(['Müller']);
    expect(state.body.incident).toBeNull();
    expect((await req('GET', '/api/clients/state', undefined, asDevice('unbekannt'))).status).toBe(401);
  });

  it('ersetzt bei Neuinstallation (gleiche MAC) das Token und behält den Namen', async () => {
    const first = await enroll();
    await req('PUT', `/api/system/workstations/${first.workstation.id}`, { name: 'Notebook ELW' });
    const second = await enroll('aa:bb:cc:dd:ee:01', 'elvis-ap-neu');
    expect(second.workstation).toMatchObject({ id: first.workstation.id, name: 'Notebook ELW', hostname: 'elvis-ap-neu' });
    expect((await req('GET', '/api/clients/state', undefined, asDevice(first.token))).status).toBe(401);
    expect((await req('GET', '/api/clients/state', undefined, asDevice(second.token))).status).toBe(200);
  });

  it('Verwaltung nur für Admins, Entfernen sperrt das Gerät', async () => {
    const { workstation, token } = await enroll();
    expect((await req('GET', '/api/system/workstations', undefined, {})).status).toBe(401);
    expect((await req('DELETE', `/api/system/workstations/${workstation.id}`)).status).toBe(204);
    expect((await req('GET', '/api/clients/state', undefined, asDevice(token))).status).toBe(401);
  });
});

describe('Arbeitsplätze: Anmeldung', () => {
  it('prüft die PIN ohne Web-Sitzung, protokolliert und sperrt nach Fehlversuchen', async () => {
    const { token } = await enroll();
    const user = (await req<User[]>('GET', '/api/users')).body[0]!;

    const ok = await app.server.inject({ method: 'POST', url: '/api/clients/login', payload: { userId: user.id, pin: '4711' }, headers: asDevice(token) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toBeUndefined();
    expect((ok.json() as WorkstationLoginResult).user).toMatchObject({ id: user.id, lastName: 'Müller' });
    expect((await req<Workstation[]>('GET', '/api/system/workstations')).body[0]!.lastUser).toBe('Max Müller');

    expect((await req('POST', '/api/clients/login', { userId: user.id, pin: '4711', purpose: 'unlock' }, asDevice(token))).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await req('POST', '/api/clients/login', { userId: user.id, pin: '0000' }, asDevice(token))).status).toBe(401);
    expect((await req('POST', '/api/clients/login', { userId: user.id, pin: '4711' }, asDevice(token))).status).toBe(429);

    const audit = (await req<{ action: string; target: string; success: boolean }[]>('GET', '/api/audit')).body;
    expect(audit.some((a) => a.action === 'login' && a.target.startsWith('arbeitsplatz:') && a.success)).toBe(true);
    expect(audit.some((a) => a.action === 'login' && !a.success)).toBe(true);
    expect(audit.some((a) => a.action === 'unlock' && a.success)).toBe(true);
    expect((await req('POST', '/api/clients/login', { userId: user.id, pin: '4711' }, asDevice('unbekannt'))).status).toBe(401);
  });

  it('liefert den aktiven Einsatz und einen PIN-Stempel, der sich mit der PIN ändert', async () => {
    const { token } = await enroll();
    const other = await enroll('aa:bb:cc:dd:ee:02', 'elvis-ap-ee02');
    const user = (await req<User[]>('GET', '/api/users')).body[0]!;
    await req('POST', '/api/incidents', { keyword: 'B3', title: 'Lagerhalle' });

    const before = (await req<WorkstationState>('GET', '/api/clients/state', undefined, asDevice(token))).body;
    expect(before.incident).toMatchObject({ keyword: 'B3', title: 'Lagerhalle' });
    const stamp = before.users[0]!.pinStamp;
    // je Gerät verschieden
    expect((await req<WorkstationState>('GET', '/api/clients/state', undefined, asDevice(other.token))).body.users[0]!.pinStamp).not.toBe(stamp);

    expect((await req('PATCH', `/api/users/${user.id}`, { pin: '1234' })).status).toBe(200);
    const after = (await req<WorkstationState>('GET', '/api/clients/state', undefined, asDevice(token))).body;
    expect(after.users[0]!.pinStamp).not.toBe(stamp);
  });

  it('Lebenszeichen setzt Version und angemeldeten Benutzer', async () => {
    const { token } = await enroll();
    expect((await req('POST', '/api/clients/heartbeat', { version: '1.0.0', user: null }, asDevice(token))).status).toBe(204);
    const [ws] = (await req<Workstation[]>('GET', '/api/system/workstations')).body;
    expect(ws).toMatchObject({ version: '1.0.0', lastUser: null });
    expect(ws!.lastSeenAt).not.toBeNull();
  });
});

describe('Arbeitsplätze: Updates', () => {
  const PROXY = 'http://10.0.0.2:3142';

  it('stößt ein Update an, liefert den Auftrag an das Gerät und übernimmt dessen Rückmeldungen', async () => {
    const { workstation, token } = await enroll();
    expect((await req('POST', `/api/system/workstations/${workstation.id}/update`, { apt: true })).status).toBe(409); // ohne apt-Cache
    app.workstations.setProvisions([{ id: 'arbeitsplatz-ap', name: 'Arbeitsplätze', token: SECRET, aptProxy: PROXY }]);
    expect((await req('POST', `/api/system/workstations/${workstation.id}/update`, { apt: false, firmware: false })).status).toBe(400);
    expect((await req('POST', `/api/system/workstations/${workstation.id}/update`, { apt: true }, {})).status).toBe(401);

    const [requested] = (await req<Workstation[]>('POST', `/api/system/workstations/${workstation.id}/update`, { apt: true, firmware: true })).body;
    expect(requested!.update).toMatchObject({ state: 'pending', apt: true, firmware: true, requestedBy: 'Max Müller' });
    const id = requested!.update!.id;

    const state = async () => (await req<WorkstationState>('GET', '/api/clients/state', undefined, asDevice(token))).body;
    expect((await state()).update).toEqual({ id, apt: true, firmware: true, aptProxy: PROXY });

    const report = (body: object) => req('POST', '/api/clients/update', body, asDevice(token));
    expect((await report({ id: 'upd-falsch', state: 'running' })).status).toBe(409);
    expect((await report({ id, state: 'running', message: 'Pakete werden geladen' })).status).toBe(200);
    expect((await req('DELETE', `/api/system/workstations/${workstation.id}/update`)).status).toBe(409); // läuft schon
    expect((await state()).update?.id).toBe(id);
    expect((await report({ id, state: 'done', message: '12 Pakete aktualisiert', log: 'x'.repeat(30_000).slice(0, 20_000) })).status).toBe(200);

    expect((await state()).update).toBeNull();
    const [ws] = (await req<Workstation[]>('GET', '/api/system/workstations')).body;
    expect(ws!.update).toMatchObject({ id, state: 'done', message: '12 Pakete aktualisiert' });
    expect(ws!.update!.finishedAt).not.toBeNull();
    expect(ws!.update!.log.length).toBe(16_000);
    expect((await report({ id, state: 'done' })).status).toBe(409); // abgeschlossen

    const audit = (await req<{ action: string; message: string }[]>('GET', '/api/audit')).body;
    expect(audit.some((a) => a.action === 'update' && a.message.includes('abgeschlossen'))).toBe(true);
  });

  it('nimmt wartende Updates zurück und stößt Updates für alle an', async () => {
    app.workstations.setProvisions([{ id: 'arbeitsplatz-ap', name: 'Arbeitsplätze', token: SECRET, aptProxy: PROXY }]);
    const a = await enroll();
    await enroll('aa:bb:cc:dd:ee:02', 'elvis-ap-ee02');
    const all = (await req<Workstation[]>('POST', '/api/system/workstations/all/update', {})).body;
    expect(all.map((w) => [w.update?.state, w.update?.apt, w.update?.firmware])).toEqual([
      ['pending', true, false],
      ['pending', true, false],
    ]);
    const cancelled = (await req<Workstation>('DELETE', `/api/system/workstations/${a.workstation.id}/update`)).body;
    expect(cancelled.update?.state).toBe('cancelled');
    expect((await req<WorkstationState>('GET', '/api/clients/state', undefined, asDevice(a.token))).body.update).toBeNull();
  });
});

describe('Arbeitsplätze: Betriebs-WLAN', () => {
  it('liefert die Zugangsdaten des Betriebs-WLANs nur, solange es eingeschaltet ist', async () => {
    const { token } = await enroll();
    const wifi = async () => (await req<WorkstationState>('GET', '/api/clients/state', undefined, asDevice(token))).body.wifi;
    expect(await wifi()).toBeNull();
    expect((await req('PUT', '/api/system/wifi/settings', { ops: { enabled: true, ssid: 'ELW Betrieb', password: 'geheim123' }, guest: { enabled: false, ssid: 'Gast' } })).status).toBe(200);
    expect(await wifi()).toEqual({ ssid: 'ELW Betrieb', psk: 'geheim123' });
    // Passwort bleibt beim Speichern ohne Passwort erhalten
    await req('PUT', '/api/system/wifi/settings', { ops: { enabled: true, ssid: 'ELW Neu', password: '' }, guest: { enabled: false, ssid: 'Gast' } });
    expect(await wifi()).toEqual({ ssid: 'ELW Neu', psk: 'geheim123' });
    await req('PUT', '/api/system/wifi/settings', { ops: { enabled: false, ssid: 'ELW Neu', password: '' }, guest: { enabled: false, ssid: 'Gast' } });
    expect(await wifi()).toBeNull();
  });
});
