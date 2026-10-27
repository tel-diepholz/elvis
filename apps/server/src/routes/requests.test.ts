import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REQUEST_TRANSITIONS, requestOpen, requestTransitions, type Incident, type JournalEntry, type MaterialRequest, type Message, type Role, type Task, type Unit, type User } from '@elvis/shared';
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

async function userCookie(firstName: string, roleIds: number[]): Promise<{ cookie: string; user: User }> {
  const user = (await req<User>('POST', '/api/users', { firstName, lastName: 'Test', pin: '1111' })).body;
  const res = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
  const cookie = sessionCookie(res.headers['set-cookie']);
  await req('PUT', '/api/auth/role', { roleIds }, cookie);
  return { cookie, user };
}

const role = async (name: string) => (await req<Role>('POST', '/api/system/roles', { name })).body;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const act = (id: number, action: string, cookie: string, payload: object) => req<MaterialRequest>('POST', `/api/requests/${id}/${action}`, payload, cookie);
const tasks = async (incidentId: number) => (await req<Task[]>('GET', `/api/incidents/${incidentId}/tasks`)).body;

let lage: Role;
let funk: Role;
let s4: Role;
let stab: { cookie: string; user: User };
let fm: { cookie: string; user: User };
let beschaffer: { cookie: string; user: User };
let inc: Incident;
let unit: Unit;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-requests-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
  lage = await role('Lage');
  funk = await role('Fernmelder');
  s4 = await role('S4');
  await req('PUT', '/api/system/messages', { radioRoleIds: [funk.id], dispatcherRoleIds: [] });
  expect((await req('PUT', '/api/system/requests', { procurementRoleId: s4.id })).status).toBe(200);
  stab = await userCookie('Stab', [lage.id]);
  fm = await userCookie('Erna', [funk.id]);
  beschaffer = await userCookie('Bodo', [s4.id]);
  inc = (await req<Incident>('POST', '/api/incidents', { title: 'Hochwasser' })).body;
  unit = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: '1. Zug', callsign: 'Florian 1/1' })).body;
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const create = (payload: object = {}, cookie = stab.cookie) =>
  req<MaterialRequest>('POST', `/api/incidents/${inc.id}/requests`, { unit: { unitId: unit.id, text: '1. Zug' }, material: '200 Sandsäcke', followUpAt: inMinutes(30), ...payload }, cookie);

describe('Statusfolge', () => {
  it('endet mit Geliefert, Abgelehnt oder Storniert', () => {
    expect(requestOpen('planned')).toBe(true);
    expect(requestOpen('ordered')).toBe(true);
    expect(REQUEST_TRANSITIONS.delivered).toEqual([]);
    expect(REQUEST_TRANSITIONS.planned).not.toContain('delivered');
    expect(requestTransitions('approved', 'self')).toContain('ordered');
    expect(requestTransitions('approved', 'staff')).toEqual(['delivered', 'rejected', 'cancelled']);
  });
});

describe('Einstellungen', () => {
  it('nur Admins, Rolle muss existieren', async () => {
    expect((await req('PUT', '/api/system/requests', { procurementRoleId: s4.id }, stab.cookie)).status).toBe(403);
    expect((await req('PUT', '/api/system/requests', { procurementRoleId: 999 })).status).toBe(400);
    expect((await req('GET', '/api/requests/settings', undefined, stab.cookie)).body).toMatchObject({ procurementRoleId: s4.id });
  });
});

describe('Anforderungen', () => {
  it('aus einer Eingangsmeldung: laufende Nummer, Wiedervorlage-Aufgabe für die Beschaffungsrolle, Tagebuch', async () => {
    const m = (await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender: { unitId: unit.id, text: '1. Zug' }, recipientRoleId: lage.id, body: 'Brauchen 200 Sandsäcke' }, fm.cookie)).body;
    const followUpAt = inMinutes(30);
    const created = await create({ sourceMessageId: m.id, material: m.body, followUpAt });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ number: 1, unit: '1. Zug', unitId: unit.id, status: 'planned', neededBy: null, sourceMessageId: m.id, canManage: false, createdBy: 'Stab Test' });
    expect((await create()).body.number).toBe(2);

    const task = (await tasks(inc.id)).find((t) => t.requestId === created.body.id)!;
    expect(task).toMatchObject({ summary: 'Wiedervorlage A-1: 1. Zug', assignee: { kind: 'role', roleId: s4.id }, dueAt: followUpAt, doneAt: null });
    expect(created.body.taskId).toBe(task.id);

    // Zielrolle legt die Anforderung aus der Meldung an: damit zur Kenntnis genommen
    const m2 = (await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender: { text: '2. Zug' }, recipientRoleId: s4.id, body: 'Brauchen Pumpe' }, fm.cookie)).body;
    await create({ sourceMessageId: m2.id, material: m2.body }, beschaffer.cookie);
    const acked = (await req<Message[]>('GET', `/api/incidents/${inc.id}/messages`, undefined, beschaffer.cookie)).body.find((x) => x.id === m2.id);
    expect(acked).toMatchObject({ ackBy: 'Bodo Test', pending: null });

    const journal = (await req<JournalEntry[]>('GET', `/api/requests/${created.body.id}/journal`)).body;
    expect(journal).toHaveLength(1);
    expect(journal[0]!.text).toMatch(/^Anforderung A-1: 1\. Zug fordert an: Brauchen 200 Sandsäcke \(Bedarf sofort\)/);
  });

  it('Wiedervorlage ist Pflicht und muss in der Zukunft liegen; Meldung aus anderem Einsatz zählt nicht', async () => {
    expect((await req('POST', `/api/incidents/${inc.id}/requests`, { unit: { text: 'ELW' }, material: 'Kabeltrommel' }, stab.cookie)).status).toBe(400);
    expect((await create({ followUpAt: inMinutes(-1) })).status).toBe(400);
    expect((await create({ sourceMessageId: 999 })).status).toBe(400);
  });

  it('Status führt nur die Beschaffungsrolle; Übergänge geprüft, neue Wiedervorlage verschiebt die Aufgabe', async () => {
    const r = (await create()).body;
    expect((await act(r.id, 'status', stab.cookie, { status: 'approved', followUpAt: inMinutes(60) })).status).toBe(403);
    expect((await act(r.id, 'status', beschaffer.cookie, { status: 'delivered' })).status).toBe(400);
    expect((await act(r.id, 'status', beschaffer.cookie, { status: 'approved' })).body).toMatchObject({ error: 'Wiedervorlage fehlt' });

    const next = inMinutes(60);
    const approved = await act(r.id, 'status', beschaffer.cookie, { status: 'approved', followUpAt: next, note: 'Lager Nord liefert' });
    expect(approved.body).toMatchObject({ status: 'approved', followUpAt: next, statusBy: 'Bodo Test', canManage: true });
    expect((await tasks(inc.id)).find((t) => t.requestId === r.id)).toMatchObject({ dueAt: next, doneAt: null });

    await act(r.id, 'status', beschaffer.cookie, { status: 'ordered', followUpAt: inMinutes(90) });
    expect((await act(r.id, 'status', beschaffer.cookie, { status: 'delivered' })).body.status).toBe('delivered');
    expect((await tasks(inc.id)).find((t) => t.requestId === r.id)?.doneAt).not.toBeNull();
    expect((await act(r.id, 'follow-up', beschaffer.cookie, { followUpAt: inMinutes(10) })).status).toBe(409);

    const texts = (await req<JournalEntry[]>('GET', `/api/requests/${r.id}/journal`)).body.map((e) => e.text);
    expect(texts.some((t) => t.includes('Genehmigt') && t.includes('Lager Nord liefert'))).toBe(true);
    expect(texts.at(-1)).toBe('Anforderung A-1: Geliefert');
  });

  it('ist die Beschaffungsrolle unbesetzt, dürfen alle', async () => {
    const r = (await create()).body;
    await req('POST', '/api/auth/logout', undefined, beschaffer.cookie);
    expect((await act(r.id, 'status', stab.cookie, { status: 'rejected' })).body).toMatchObject({ status: 'rejected' });
  });

  it('Notizen landen im Einsatztagebuch mit Verweis', async () => {
    const r = (await create()).body;
    const note = await req<JournalEntry>('POST', `/api/requests/${r.id}/notes`, { text: 'Rückfrage beim Bauhof', category: 'telefon' }, stab.cookie);
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({ category: 'telefon', text: 'Anforderung A-1: Rückfrage beim Bauhof', requestId: r.id, author: 'Stab Test' });
    expect((await req('POST', `/api/requests/${r.id}/notes`, { text: 'x', category: 'system' }, stab.cookie)).status).toBe(400);
  });

  it('Ausgangsmeldung zur Anforderung wird verknüpft', async () => {
    const r = (await create()).body;
    const m = await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'out', senderRoleId: lage.id, recipient: { text: '1. Zug' }, body: 'Sandsäcke kommen', requestId: r.id }, stab.cookie);
    expect(m.body.requestId).toBe(r.id);
    expect((await req<MaterialRequest>('GET', `/api/requests/${r.id}`, undefined, stab.cookie)).body.messageIds).toEqual([m.body.id]);
    expect((await req('POST', `/api/incidents/${inc.id}/messages`, { direction: 'out', senderRoleId: lage.id, recipient: { text: 'x' }, body: 'y', requestId: 999 }, stab.cookie)).status).toBe(400);
  });
});

describe('Eingangsmeldung anhängen', () => {
  it('nur Eingangsmeldungen aus dem Einsatz; Verweis und Tagebuch', async () => {
    const r = (await create()).body;
    const m = (await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender: { text: 'Stab HVB' }, recipientRoleId: s4.id, body: 'Sandsäcke genehmigt' }, fm.cookie)).body;
    const out = (await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'out', senderRoleId: lage.id, recipient: { text: 'x' }, body: 'y' }, stab.cookie)).body;
    expect((await act(r.id, 'messages', stab.cookie, { messageId: out.id })).status).toBe(400);
    expect((await act(r.id, 'messages', stab.cookie, { messageId: 999 })).status).toBe(400);
    expect((await act(r.id, 'messages', stab.cookie, { messageId: m.id })).body.messageIds).toEqual([m.id]);
    const msgs = (await req<Message[]>('GET', `/api/incidents/${inc.id}/messages`, undefined, stab.cookie)).body;
    expect(msgs.find((x) => x.id === m.id)?.requestId).toBe(r.id);
    // Zielrolle hängt an: damit zur Kenntnis genommen
    const r2 = (await create()).body;
    const m2 = (await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender: { text: 'Stab HVB' }, recipientRoleId: s4.id, body: 'A-2 abgelehnt' }, fm.cookie)).body;
    expect(m2.pending).toBeNull();
    await act(r2.id, 'messages', beschaffer.cookie, { messageId: m2.id });
    const acked = (await req<Message[]>('GET', `/api/incidents/${inc.id}/messages`, undefined, beschaffer.cookie)).body.find((x) => x.id === m2.id);
    expect(acked).toMatchObject({ requestId: r2.id, ackBy: 'Bodo Test', pending: null });
    const texts = (await req<JournalEntry[]>('GET', `/api/requests/${r.id}/journal`)).body.map((e) => e.text);
    expect(texts).toContain(`Anforderung A-1: Eingangsmeldung #${m.id} von Stab HVB angehängt`);
  });
});

describe('Beschaffung über den Stab', () => {
  const forward = (id: number, cookie = beschaffer.cookie) =>
    act(id, 'forward', cookie, { senderRoleId: s4.id, recipient: { text: 'Stab HVB' }, body: 'Anforderung A-1: 200 Sandsäcke für 1. Zug', followUpAt: inMinutes(45) });

  it('im Modus „selbst“ keine Weiterleitung', async () => {
    const r = (await create()).body;
    expect((await forward(r.id)).status).toBe(409);
  });

  it('erzeugt eine Ausgangsmeldung und verschiebt die Wiedervorlage', async () => {
    expect((await req<Incident>('PATCH', `/api/incidents/${inc.id}`, { procurementMode: 'staff', procurementStaff: 'Stab HVB' })).body).toMatchObject({ procurementMode: 'staff', procurementStaff: 'Stab HVB' });
    const r = (await create()).body;
    expect((await forward(r.id, stab.cookie)).status).toBe(403);
    const sent = await forward(r.id);
    expect(sent.body).toMatchObject({ forwardedBy: 'Bodo Test', status: 'planned' });
    expect(sent.body.messageIds).toHaveLength(1);
    const msg = (await req<Message>('GET', `/api/incidents/${inc.id}/messages`, undefined, fm.cookie)).body as unknown as Message[];
    expect(msg.find((m) => m.id === sent.body.messageIds[0])).toMatchObject({ direction: 'out', sender: 'S4', recipient: 'Stab HVB', requestId: r.id, pending: 'radio' });
    expect((await tasks(inc.id)).find((t) => t.requestId === r.id)?.dueAt).toBe(sent.body.followUpAt);
    // Bestellt entfällt: der Stab bestellt, auf Genehmigt folgt Geliefert
    await act(r.id, 'status', beschaffer.cookie, { status: 'approved', followUpAt: inMinutes(60), note: 'genehmigt durch Stab' });
    expect((await act(r.id, 'status', beschaffer.cookie, { status: 'ordered', followUpAt: inMinutes(90) })).status).toBe(400);
    expect((await act(r.id, 'status', beschaffer.cookie, { status: 'delivered' })).body.status).toBe('delivered');
  });
});

describe('Abgeschlossener Einsatz', () => {
  it('nimmt keine Anforderungen mehr an', async () => {
    const r = (await create()).body;
    await req('POST', `/api/incidents/${inc.id}/close`);
    expect((await create()).status).toBe(409);
    expect((await act(r.id, 'status', beschaffer.cookie, { status: 'cancelled' })).status).toBe(409);
  });
});
