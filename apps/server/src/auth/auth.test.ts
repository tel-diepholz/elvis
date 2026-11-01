import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthStatus, LoginCandidate, User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';
import { accessLevel } from './access.js';
import { LoginLimiter } from './limiter.js';

let app: App;
let dataDir: string;
let admin: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-auth-'));
  app = await buildApp(parseConfig({ dataDir, docker: { enabled: true } }), { logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function call<T = unknown>(method: Method, url: string, cookie?: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T, setCookie: res.headers['set-cookie'] };
}

async function login(userId: number, pin: string) {
  return call<User & { error?: string }>('POST', '/api/auth/login', undefined, { userId, pin });
}

async function createUser(cookie: string, firstName: string, pin = '1111', isAdmin = false) {
  const res = await call<User>('POST', '/api/users', cookie, { firstName, lastName: 'Test', pin, isAdmin });
  return res;
}

describe('Ersteinrichtung und Anmeldung', () => {
  it('legt beim ersten Start den ersten Admin an – danach nicht mehr', async () => {
    expect((await call<AuthStatus>('GET', '/api/auth/status')).body).toEqual({ hasUsers: false, user: null, roles: [], roleChosen: false, lastRoleIds: [] });
    admin = await adminCookie(app);
    const status = await call<AuthStatus>('GET', '/api/auth/status', admin);
    expect(status.body.user).toMatchObject({ firstName: 'Max', lastName: 'Müller', isAdmin: true, createdBy: 'Ersteinrichtung' });
    expect(status.body.user?.lastLoginAt).toBeTruthy();
    expect((await call('POST', '/api/auth/setup', undefined, { firstName: 'A', lastName: 'B', pin: '1234' })).status).toBe(409);
  });

  it('meldet per Namensauswahl und PIN an, die Auswahl verrät keine PINs', async () => {
    admin = await adminCookie(app);
    const candidates = await call<LoginCandidate[]>('GET', '/api/auth/candidates');
    expect(candidates.body).toEqual([{ id: 1, firstName: 'Max', lastName: 'Müller' }]);

    const ok = await login(1, '4711');
    expect(ok.status).toBe(200);
    const cookie = sessionCookie(ok.setCookie);
    expect((await call<AuthStatus>('GET', '/api/auth/status', cookie)).body.user?.lastLoginAt).toBeTruthy();
    expect(String(ok.setCookie)).toMatch(/HttpOnly/i);
    expect(String(ok.setCookie)).toMatch(/SameSite=Strict/i);
  });

  it('sperrt nach drei falschen PINs', async () => {
    admin = await adminCookie(app);
    expect((await login(1, '0000')).body.error).toBe('PIN falsch – noch 2 Versuche');
    expect((await login(1, '0001')).body.error).toBe('PIN falsch – noch 1 Versuch');
    expect((await login(1, '0002')).status).toBe(401);
    const locked = await login(1, '4711');
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/erneut möglich in \d+ s/);
  });

  it('beendet die Sitzung beim Abmelden', async () => {
    admin = await adminCookie(app);
    expect((await call('GET', '/api/incidents', admin)).status).toBe(200);
    expect((await call('POST', '/api/auth/logout', admin)).status).toBe(204);
    expect((await call('GET', '/api/incidents', admin)).status).toBe(401);
  });
});

describe('Anonymer Arbeitsplatz', () => {
  it('darf den Fahrzeugzustand lesen, aber nichts ändern und keine Einsatzdaten sehen', async () => {
    admin = await adminCookie(app);
    expect((await call('GET', '/api/devices')).status).toBe(200);
    expect((await call('GET', '/api/alerts')).status).toBe(200);
    expect((await call('GET', '/api/map/sources')).status).toBe(200);
    expect((await call('POST', '/api/devices/radio/commands', undefined, { action: 'status.set', params: { deviceId: 'mrt-1', status: 3 } })).status).toBe(401);
    expect((await call('GET', '/api/incidents')).status).toBe(401);
    expect((await call('GET', '/api/incidents/active')).status).toBe(401);
    expect((await call('GET', '/api/audit')).status).toBe(401);
    expect((await call('GET', '/api/users')).status).toBe(401);
    expect((await call('POST', '/api/users', undefined, { firstName: 'X', lastName: 'Y', pin: '1234' })).status).toBe(401);
  });
});

describe('Rechte', () => {
  it('Benutzer dürfen Benutzer anlegen, aber keine Admin-Rechte vergeben', async () => {
    admin = await adminCookie(app);
    const anna = (await createUser(admin, 'Anna')).body;
    const user = sessionCookie((await login(anna.id, '1111')).setCookie);

    expect((await createUser(user, 'Ben')).status).toBe(201);
    expect((await createUser(user, 'Carla', '2222', true)).status).toBe(403);
    expect((await call('PATCH', `/api/users/${anna.id}`, user, { isAdmin: true })).status).toBe(403);
    expect((await call('PATCH', '/api/users/1', user, { firstName: 'Hans' })).status).toBe(403);
    expect((await call('DELETE', '/api/users/1', user)).status).toBe(403);
    // eigener Name ja
    expect((await call<User>('PATCH', `/api/users/${anna.id}`, user, { firstName: 'Annabell' })).body.firstName).toBe('Annabell');
  });

  it('Docker- und Addon-Verwaltung nur für Admins', async () => {
    admin = await adminCookie(app);
    const anna = (await createUser(admin, 'Anna')).body;
    const user = sessionCookie((await login(anna.id, '1111')).setCookie);
    expect((await call('GET', '/api/addons', user)).status).toBe(403);
    expect((await call('GET', '/api/docker/hosts', user)).status).toBe(403);
    expect((await call('GET', '/api/addons', admin)).status).toBe(200);
  });

  it('trägt den angemeldeten Benutzer als Bearbeiter ein', async () => {
    admin = await adminCookie(app);
    const anna = (await createUser(admin, 'Anna')).body;
    const user = sessionCookie((await login(anna.id, '1111')).setCookie);
    const incident = (await call<{ id: number }>('POST', '/api/incidents', user, { title: 'Test' })).body;
    const journal = (await call<{ author: string }[]>('GET', `/api/incidents/${incident.id}/journal`, user)).body;
    expect(journal[0]?.author).toBe('Anna Test');
  });

  it('schützt den letzten Admin', async () => {
    admin = await adminCookie(app);
    expect((await call('PATCH', '/api/users/1', admin, { isAdmin: false })).status).toBe(409);
    expect((await call('DELETE', '/api/users/1', admin)).status).toBe(409);
    const second = (await createUser(admin, 'Zweit', '2222', true)).body;
    expect(second.isAdmin).toBe(true);
    expect((await call('PATCH', '/api/users/1', admin, { isAdmin: false })).status).toBe(200);
  });

  it('beendet Sitzungen, wenn ein Admin die PIN zurücksetzt', async () => {
    admin = await adminCookie(app);
    const anna = (await createUser(admin, 'Anna')).body;
    const user = sessionCookie((await login(anna.id, '1111')).setCookie);
    expect((await call('PATCH', `/api/users/${anna.id}`, admin, { pin: '9999' })).status).toBe(200);
    expect((await call('GET', '/api/incidents', user)).status).toBe(401);
    expect((await login(anna.id, '9999')).status).toBe(200);
  });

  it('eigene PIN nur mit der aktuellen PIN ändern', async () => {
    admin = await adminCookie(app);
    expect((await call('POST', '/api/auth/pin', admin, { currentPin: '0000', newPin: '1357' })).status).toBe(403);
    expect((await call('POST', '/api/auth/pin', admin, { currentPin: '4711', newPin: '1357' })).status).toBe(204);
    expect((await login(1, '1357')).status).toBe(200);
  });
});

describe('Eingaben', () => {
  it('verlangt genau vier Ziffern und eindeutige Namen', async () => {
    admin = await adminCookie(app);
    expect((await createUser(admin, 'Anna', '123')).status).toBe(400);
    expect((await createUser(admin, 'Anna', '12a4')).status).toBe(400);
    expect((await createUser(admin, 'Anna')).status).toBe(201);
    expect((await call('POST', '/api/users', admin, { firstName: 'anna', lastName: 'TEST', pin: '1234' })).status).toBe(409);
  });
});

describe('Zugriffsregeln', () => {
  it('ordnet Endpunkte richtig ein', () => {
    expect(accessLevel('GET', '/api/devices')).toBe('public');
    expect(accessLevel('POST', '/api/devices/power/commands')).toBe('user');
    expect(accessLevel('GET', '/api/incidents/active')).toBe('user');
    expect(accessLevel('GET', '/api/docker/setup/abc.sh')).toBe('public');
    expect(accessLevel('POST', '/api/docker/setup/abc/done')).toBe('public');
    expect(accessLevel('GET', '/api/docker/hosts')).toBe('admin');
    expect(accessLevel('GET', '/api/addons?x=1')).toBe('admin');
    expect(accessLevel('POST', '/api/addons/orthophotos/ui/api/selection')).toBe('admin');
    expect(accessLevel('POST', '/api/auth/pin')).toBe('user');
    expect(accessLevel('PUT', '/api/auth/role')).toBe('user');
    expect(accessLevel('POST', '/api/system/task-templates')).toBe('admin');
    expect(accessLevel('GET', '/api/roles')).toBe('user');
    expect(accessLevel('GET', '/einsatz/tagebuch')).toBe('public');
    expect(accessLevel('GET', '/api/irgendwas-neues')).toBe('user');
    // Dokumente: WOPI prüft sein Token selbst, Vorlagen pflegen nur Admins, Ordnervorgabe unter /api/system/
    expect(accessLevel('POST', '/api/wopi/files/d1/contents?access_token=x')).toBe('public');
    expect(accessLevel('GET', '/api/templates')).toBe('user');
    expect(accessLevel('POST', '/api/templates/1/edit')).toBe('admin');
    expect(accessLevel('DELETE', '/api/template-folders/1')).toBe('admin');
    expect(accessLevel('PUT', '/api/system/document-folders')).toBe('admin');
    expect(accessLevel('POST', '/api/incidents/1/documents/from-template')).toBe('user');
  });
});

describe('Sperre', () => {
  it('verdoppelt die Sperrzeit und sperrt auch das Gerät', () => {
    let t = 0;
    const l = new LoginLimiter(() => t);
    l.failure(1, 'a');
    l.failure(1, 'a');
    l.failure(1, 'a'); // 30 s
    expect(() => l.assertAllowed(1, 'a')).toThrow(/30 s/);
    t += 31_000;
    l.assertAllowed(1, 'a');
    l.failure(1, 'a'); // 60 s
    expect(() => l.assertAllowed(1, 'a')).toThrow(/60 s|1 min/);
    l.success(1);
    // Gerätesperre über viele Benutzer
    for (let u = 10; u < 20; u++) l.failure(u, 'b');
    expect(() => l.assertAllowed(99, 'b')).toThrow(/Gerät/);
    l.assertAllowed(99, 'c');
  });
});
