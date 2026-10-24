import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextIntervalDue, taskIsDue, type AuthStatus, type Incident, type JournalEntry, type Role, type RoleInfo, type Task, type TaskTemplate, type User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

async function userCookie(firstName = 'Anna'): Promise<{ cookie: string; user: User }> {
  const user = (await req<User>('POST', '/api/users', { firstName, lastName: 'Test', pin: '1111' })).body;
  const res = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
  return { cookie: sessionCookie(res.headers['set-cookie']), user };
}

const role = async (name: string) => (await req<Role>('POST', '/api/system/roles', { name })).body;
const incident = async () => (await req<Incident>('POST', '/api/incidents', { title: 'Übung' })).body;
const tasksOf = async (incidentId: number, cookie = admin) => (await req<Task[]>('GET', `/api/incidents/${incidentId}/tasks`, undefined, cookie)).body;
const once = (dueAt: string | null = null) => ({ kind: 'once', dueAt });

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-tasks-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Rollen', () => {
  it('pflegen nur Admins, lesen alle', async () => {
    const el = await role('Einsatzleiter');
    expect(el).toMatchObject({ name: 'Einsatzleiter', description: '' });
    expect((await req('POST', '/api/system/roles', { name: 'einsatzleiter' })).status).toBe(409);
    const { cookie } = await userCookie();
    expect((await req('POST', '/api/system/roles', { name: 'Funk' }, cookie)).status).toBe(403);
    expect((await req<RoleInfo[]>('GET', '/api/roles', undefined, cookie)).body).toEqual([{ ...el, holders: [] }]);
  });

  it('fragt nach der Anmeldung nach der Rolle und gibt sie beim Abmelden frei', async () => {
    const funk = await role('Funk');
    const { cookie } = await userCookie();
    expect((await req<AuthStatus>('GET', '/api/auth/status', undefined, cookie)).body).toMatchObject({ role: null, roleChosen: false });

    expect((await req('PUT', '/api/auth/role', { roleId: funk.id }, cookie)).status).toBe(200);
    expect((await req<AuthStatus>('GET', '/api/auth/status', undefined, cookie)).body).toMatchObject({ role: { name: 'Funk' }, roleChosen: true });
    expect((await req<RoleInfo[]>('GET', '/api/roles')).body[0]?.holders).toEqual(['Anna Test']);

    // Wechsel über das Profilmenü, „ohne Rolle“ zählt als gewählt
    await req('PUT', '/api/auth/role', { roleId: null }, cookie);
    expect((await req<AuthStatus>('GET', '/api/auth/status', undefined, cookie)).body).toMatchObject({ role: null, roleChosen: true });

    await req('PUT', '/api/auth/role', { roleId: funk.id }, cookie);
    await req('POST', '/api/auth/logout', undefined, cookie);
    expect((await req<RoleInfo[]>('GET', '/api/roles')).body[0]?.holders).toEqual([]);
    expect((await req('PUT', '/api/auth/role', { roleId: null }, '')).status).toBe(401);
  });

  it('Löschen nimmt Sitzungen die Rolle', async () => {
    const funk = await role('Funk');
    await req('PUT', '/api/auth/role', { roleId: funk.id });
    expect((await req('DELETE', `/api/system/roles/${funk.id}`)).status).toBe(204);
    expect((await req<AuthStatus>('GET', '/api/auth/status')).body).toMatchObject({ role: null, roleChosen: true });
  });
});

describe('Aufgaben verteilen', () => {
  it('an alle, an sich selbst und an Rollen – unbesetzte Rollen sehen alle', async () => {
    const el = await role('Einsatzleiter');
    const funk = await role('Funk');
    const anna = await userCookie();
    await req('PUT', '/api/auth/role', { roleId: el.id });
    await req('PUT', '/api/auth/role', { roleId: funk.id }, anna.cookie);
    const { id } = await incident();

    const post = (summary: string, assignee: object, cookie = admin) => req<Task>('POST', `/api/incidents/${id}/tasks`, { summary, assignee, schedule: once() }, cookie);
    expect((await post('Lage erkunden', { kind: 'all' })).status).toBe(201);
    expect((await post('Müller anrufen', { kind: 'user', userId: anna.user.id }, anna.cookie)).body).toMatchObject({ assigneeName: 'Anna Test', mine: true });
    expect((await post('Funkskizze', { kind: 'role', roleId: funk.id })).body).toMatchObject({ assigneeName: 'Funk', mine: false, roleVacant: false });
    // anderen Benutzern nur über deren Rolle
    expect((await post('Fremd', { kind: 'user', userId: anna.user.id })).status).toBe(403);

    const mine = async (cookie: string) => (await tasksOf(id, cookie)).filter((t) => t.mine).map((t) => t.summary).sort();
    expect(await mine(admin)).toEqual(['Lage erkunden']);
    expect(await mine(anna.cookie)).toEqual(['Funkskizze', 'Lage erkunden', 'Müller anrufen']);

    // Funk verlässt den Einsatz → Rolle unbesetzt → Aufgabe für alle
    await req('POST', '/api/auth/logout', undefined, anna.cookie);
    const tasks = await tasksOf(id);
    expect(tasks.find((t) => t.summary === 'Funkskizze')).toMatchObject({ mine: true, roleVacant: true });
    expect(tasks.find((t) => t.summary === 'Müller anrufen')?.mine).toBe(false);
  });

  it('prüft Kurztext und Vorlage', async () => {
    const { id } = await incident();
    const post = (body: object) => req('POST', `/api/incidents/${id}/tasks`, { summary: 'X', assignee: { kind: 'all' }, schedule: once(), ...body });
    expect((await post({ summary: 'x'.repeat(51) })).status).toBe(400);
    expect((await post({ documentTemplateId: 99 })).status).toBe(400);
    expect((await post({ assignee: { kind: 'role', roleId: 99 } })).status).toBe(400);
    expect((await post({ schedule: { kind: 'interval', intervalMinutes: 0, dueAt: new Date().toISOString() } })).status).toBe(400);
  });
});

describe('Erledigen, Wiederholen, Schieben', () => {
  it('einmalige Aufgabe erledigen und wieder öffnen, mit Tagebucheintrag', async () => {
    const { id } = await incident();
    const t = (await req<Task>('POST', `/api/incidents/${id}/tasks`, { summary: 'Treibstoff bestellen', assignee: { kind: 'all' }, schedule: once(new Date(Date.now() + 15 * 60_000).toISOString()) })).body;
    const done = (await req<Task>('POST', `/api/tasks/${t.id}/done`, {})).body;
    expect(done).toMatchObject({ doneBy: 'Max Müller', snoozedUntil: null });
    expect((await req('POST', `/api/tasks/${t.id}/snooze`, { minutes: 5 })).status).toBe(409);
    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${id}/journal`)).body;
    expect(journal.at(-1)).toMatchObject({ category: 'system', text: 'Aufgabe erledigt: Treibstoff bestellen' });
    expect((await req<Task>('POST', `/api/tasks/${t.id}/reopen`)).body.doneAt).toBeNull();
  });

  it('wiederkehrende rückt im Takt weiter, Schieben verschiebt nur den aktuellen Durchgang', async () => {
    const { id } = await incident();
    const first = new Date(Date.now() - 10 * 60_000).toISOString();
    const t = (await req<Task>('POST', `/api/incidents/${id}/tasks`, { summary: 'Lagebesprechung', assignee: { kind: 'all' }, schedule: { kind: 'interval', intervalMinutes: 90, dueAt: first } })).body;
    expect(taskIsDue(t, Date.now())).toBe(true);

    const snoozed = (await req<Task>('POST', `/api/tasks/${t.id}/snooze`, { minutes: 15 })).body;
    expect(snoozed.dueAt).toBe(first);
    expect(taskIsDue(snoozed, Date.now())).toBe(false);
    expect((await req('POST', `/api/tasks/${t.id}/snooze`, { until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);

    const next = (await req<Task>('POST', `/api/tasks/${t.id}/done`, {})).body;
    expect(next).toMatchObject({ doneAt: null, snoozedUntil: null, lastDoneBy: 'Max Müller', dueAt: new Date(Date.parse(first) + 90 * 60_000).toISOString() });

    const ended = (await req<Task>('POST', `/api/tasks/${t.id}/done`, { final: true })).body;
    expect(ended.doneAt).toBeTruthy();
    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${id}/journal`)).body;
    expect(journal.at(-1)?.text).toBe('Wiederkehrende Aufgabe beendet: Lagebesprechung');
  });

  it('nächster Termin im festen Takt, verpasste Durchgänge werden übersprungen', () => {
    const due = '2026-10-24T10:00:00.000Z';
    expect(nextIntervalDue(due, 90, Date.parse('2026-10-24T10:05:00Z'))).toBe('2026-10-24T11:30:00.000Z');
    expect(nextIntervalDue(due, 90, Date.parse('2026-10-24T14:10:00Z'))).toBe('2026-10-24T14:30:00.000Z');
    expect(nextIntervalDue(due, 90, Date.parse('2026-10-24T14:30:00Z'))).toBe('2026-10-24T16:00:00.000Z');
  });

  it('gekoppelte Bildschirme lesen alle Aufgaben, ändern nichts', async () => {
    const { id } = await incident();
    await req('POST', `/api/incidents/${id}/tasks`, { summary: 'Eigene', assignee: { kind: 'user', userId: 1 }, schedule: once() });
    const url = `/api/incidents/${id}/tasks`;
    expect((await req('GET', url, undefined, '')).status).toBe(401);
    const start = await app.server.inject({ method: 'POST', url: '/api/display/pair' });
    const display = String(start.headers['set-cookie']).split(';')[0]!;
    await req('POST', '/api/system/displays/pair', { code: (start.json() as { code: string }).code, name: 'Lagetisch' });
    expect((await req<Task[]>('GET', url, undefined, display)).body).toMatchObject([{ summary: 'Eigene', assignee: { kind: 'user', userId: 1 } }]);
    expect((await req('POST', url, { summary: 'X', assignee: { kind: 'all' }, schedule: once() }, display)).status).toBe(401);
  });

  it('abgeschlossene Einsätze sind schreibgeschützt', async () => {
    const { id } = await incident();
    const t = (await req<Task>('POST', `/api/incidents/${id}/tasks`, { summary: 'A', assignee: { kind: 'all' }, schedule: once() })).body;
    await req('POST', `/api/incidents/${id}/close`);
    expect((await req('POST', `/api/tasks/${t.id}/done`, {})).status).toBe(409);
    expect((await tasksOf(id)).length).toBe(1);
  });
});

describe('Aufgabenvorlagen', () => {
  it('werden beim Eröffnen eines Einsatzes angelegt, Zeiten ab Einsatzbeginn', async () => {
    const el = await role('Einsatzleiter');
    const { cookie } = await userCookie();
    expect((await req('POST', '/api/system/task-templates', { summary: 'X', schedule: { kind: 'once', offsetMinutes: null } }, cookie)).status).toBe(403);

    const a = (await req<TaskTemplate>('POST', '/api/system/task-templates', { summary: 'Lagebesprechung', roleId: el.id, schedule: { kind: 'interval', intervalMinutes: 90, offsetMinutes: 30 } })).body;
    expect(a).toMatchObject({ roleName: 'Einsatzleiter', schedule: { kind: 'interval', intervalMinutes: 90, offsetMinutes: 30 } });
    const b = (await req<TaskTemplate>('POST', '/api/system/task-templates', { summary: 'Einsatzstelle absichern', schedule: { kind: 'once', offsetMinutes: null } })).body;
    expect((await req<TaskTemplate[]>('PUT', '/api/system/task-templates/order', { ids: [b.id, a.id] })).body.map((t) => t.id)).toEqual([b.id, a.id]);

    const inc = await incident();
    const tasks = await tasksOf(inc.id);
    expect(tasks.map((t) => t.summary)).toEqual(['Lagebesprechung', 'Einsatzstelle absichern']);
    expect(tasks[0]).toMatchObject({ createdBy: 'System', intervalMinutes: 90, assignee: { kind: 'role', roleId: el.id }, dueAt: new Date(Date.parse(inc.startedAt) + 30 * 60_000).toISOString() });
    expect(tasks[1]).toMatchObject({ dueAt: null, assignee: { kind: 'all' } });
  });
});
