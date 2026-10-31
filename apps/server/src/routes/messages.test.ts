import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messageNeedsAttention, type Incident, type Message, type MessageContext, type Role, type Unit, type User } from '@elvis/shared';
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

async function userCookie(firstName: string, roleIds: number[]): Promise<{ cookie: string; user: User }> {
  const user = (await req<User>('POST', '/api/users', { firstName, lastName: 'Test', pin: '1111' })).body;
  const res = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
  const cookie = sessionCookie(res.headers['set-cookie']);
  await req('PUT', '/api/auth/role', { roleIds }, cookie);
  return { cookie, user };
}

const role = async (name: string) => (await req<Role>('POST', '/api/system/roles', { name })).body;
const incident = async () => (await req<Incident>('POST', '/api/incidents', { title: 'Übung' })).body;
const list = async (incidentId: number, cookie: string) => (await req<Message[]>('GET', `/api/incidents/${incidentId}/messages`, undefined, cookie)).body;
const act = <T = Message>(id: number, action: string, cookie: string, payload: object = {}) => req<T>('POST', `/api/messages/${id}/${action}`, payload, cookie);

let lage: Role;
let funk: Role;
let dispatch: Role;
let stab: { cookie: string; user: User };
let fm1: { cookie: string; user: User };
let fm2: { cookie: string; user: User };
let inc: Incident;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-messages-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
  lage = await role('Lage');
  funk = await role('Fernmelder');
  dispatch = await role('Dispatcher');
  expect((await req('PUT', '/api/system/messages', { radioRoleIds: [funk.id], dispatcherRoleIds: [dispatch.id] })).status).toBe(200);
  stab = await userCookie('Stab', [lage.id]);
  fm1 = await userCookie('Erna', [funk.id]);
  fm2 = await userCookie('Fritz', [funk.id]);
  inc = await incident();
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const outgoing = (recipient: object, cookie = stab.cookie, senderRoleId = lage.id) =>
  req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'out', senderRoleId, recipient, body: '- Wasser\n- Sandsäcke' }, cookie);

describe('Einstellungen', () => {
  it('nur Admins, Rollen müssen existieren und dürfen nicht doppelt belegt sein', async () => {
    expect((await req('GET', '/api/system/messages', undefined, stab.cookie)).status).toBe(403);
    expect((await req('PUT', '/api/system/messages', { radioRoleIds: [99], dispatcherRoleIds: [] })).status).toBe(400);
    expect((await req('PUT', '/api/system/messages', { radioRoleIds: [funk.id], dispatcherRoleIds: [funk.id] })).status).toBe(400);
    expect((await req('GET', '/api/system/messages')).body).toMatchObject({ radioRoleIds: [funk.id], dispatcherRoleIds: [dispatch.id] });
  });
});

describe('Ausgangsmeldungen', () => {
  it('nur im Namen eigener Rollen; Kraft aus dem Einsatz oder Freitext', async () => {
    expect((await outgoing({ text: 'ELW 1' }, stab.cookie, funk.id)).status).toBe(403);
    // Fernmelder schreiben keine Ausgangsmeldungen – auch nicht im Namen einer weiteren Rolle
    const both = await userCookie('Berta', [lage.id, funk.id]);
    expect((await outgoing({ text: 'ELW 1' }, both.cookie)).body).toMatchObject({ error: 'Fernmelder erfassen nur Eingangsmeldungen' });
    const unit = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'ELW 1', callsign: 'Florian 1/11' })).body;
    const linked = await outgoing({ unitId: unit.id, text: 'ELW 1' });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({ direction: 'out', sender: 'Lage', recipient: 'ELW 1', recipientUnitId: unit.id, pending: null, createdBy: 'Stab Test' });
    // Kraft aus anderem Einsatz bzw. unbekannt → nur Freitext
    expect((await outgoing({ unitId: 9999, text: 'Polizei' })).body).toMatchObject({ recipient: 'Polizei', recipientUnitId: null });
  });

  it('Fernmelder werden benachrichtigt; Übernahme zeigt allen, wer bearbeitet', async () => {
    const m = (await outgoing({ text: 'ELW 1' })).body;
    expect((await list(inc.id, fm1.cookie))[0]?.pending).toBe('radio');
    expect((await list(inc.id, fm2.cookie))[0]?.pending).toBe('radio');
    expect((await act(m.id, 'claim', stab.cookie)).status).toBe(403);

    expect((await act(m.id, 'claim', fm1.cookie)).body).toMatchObject({ claimedBy: 'Erna Test', pending: 'radio' });
    expect((await list(inc.id, fm2.cookie))[0]).toMatchObject({ claimedBy: 'Erna Test', pending: null });
    expect((await list(inc.id, stab.cookie))[0]?.claimedBy).toBe('Erna Test');

    // zweiter Fernmelder nur mit ausdrücklichem Übernehmen
    expect((await act(m.id, 'claim', fm2.cookie)).status).toBe(409);
    expect((await act(m.id, 'claim', fm2.cookie, { force: true })).body.claimedBy).toBe('Fritz Test');

    // Zurücklegen: wieder für alle offen
    expect((await act(m.id, 'release', fm2.cookie)).body).toMatchObject({ claimedBy: null });
    expect((await list(inc.id, fm1.cookie))[0]?.pending).toBe('radio');
  });

  it('Übernahme verfällt, wenn der Fernmelder die Rolle abgibt', async () => {
    const m = (await outgoing({ text: 'ELW 1' })).body;
    await act(m.id, 'claim', fm1.cookie);
    await req('POST', '/api/auth/logout', undefined, fm1.cookie);
    expect((await list(inc.id, fm2.cookie))[0]?.pending).toBe('radio');
    expect((await act(m.id, 'claim', fm2.cookie)).status).toBe(200);
  });

  it('Erneut versuchen behält die Übernahme und setzt den Zeitpunkt', async () => {
    const m = (await outgoing({ text: 'ELW 1' })).body;
    const before = Date.now();
    const snoozed = (await act(m.id, 'snooze', fm1.cookie)).body;
    expect(snoozed).toMatchObject({ claimedBy: 'Erna Test', snoozeCount: 1, snoozedBy: 'Erna Test', snoozeMinutes: 2 });
    expect(Date.parse(snoozed.remindAt!) - before).toBeGreaterThanOrEqual(2 * 60_000 - 1000);
    expect((await list(inc.id, fm2.cookie))[0]?.pending).toBeNull();
    // Vermerk bleibt auch nach Zurücklegen und Erledigen
    await act(m.id, 'snooze', fm1.cookie);
    await act(m.id, 'release', fm1.cookie);
    expect((await act(m.id, 'done', fm2.cookie)).body).toMatchObject({ remindAt: null, snoozeCount: 2, snoozedBy: 'Erna Test' });
  });

  it('Antwort schließt ab und benachrichtigt die Absenderrolle bis zur Kenntnisnahme', async () => {
    const m = (await outgoing({ text: 'ELW 1' })).body;
    await act(m.id, 'claim', fm1.cookie);
    const replied = (await act(m.id, 'reply', fm1.cookie, { body: 'Verstanden, kommt in 10 min' })).body;
    expect(replied).toMatchObject({ reply: 'Verstanden, kommt in 10 min', repliedBy: 'Erna Test', doneBy: 'Erna Test', pending: null });
    expect((await list(inc.id, stab.cookie))[0]?.pending).toBe('reply');
    expect((await act(m.id, 'reply', fm1.cookie, { body: 'nochmal' })).status).toBe(409);
    expect((await act(m.id, 'ack', fm1.cookie)).status).toBe(409);
    expect((await act(m.id, 'ack', stab.cookie)).body).toMatchObject({ ackBy: 'Stab Test', pending: null });
    // erledigt und gelesen – bleibt trotzdem bei den eigenen Meldungen
    expect((await list(inc.id, stab.cookie))[0]).toMatchObject({ pending: null, mine: true });
    expect((await list(inc.id, fm2.cookie))[0]?.mine).toBe(false);
    expect((await list(inc.id, fm1.cookie))[0]?.mine).toBe(true); // hat sie bearbeitet
  });

  it('erledigt ohne Antwort', async () => {
    const m = (await outgoing({ text: 'ELW 1' })).body;
    expect((await act(m.id, 'done', fm1.cookie)).body).toMatchObject({ doneBy: 'Erna Test', reply: null });
    expect((await list(inc.id, stab.cookie))[0]?.pending).toBeNull();
  });

  it('abgeschlossener Einsatz nimmt keine Meldungen mehr an', async () => {
    const m = (await outgoing({ text: 'ELW 1' })).body;
    await req('POST', `/api/incidents/${inc.id}/close`);
    expect((await outgoing({ text: 'ELW 1' })).status).toBe(409);
    expect((await act(m.id, 'claim', fm1.cookie)).status).toBe(409);
  });
});

describe('Kopien', () => {
  it('gehen je nach Richtung an die eingestellten Rollen und gelten beim Öffnen als gelesen', async () => {
    const s2 = await role('S2');
    expect((await req('PUT', '/api/system/messages', { radioRoleIds: [funk.id], dispatcherRoleIds: [], copyInRoleIds: [s2.id], copyOutRoleIds: [s2.id, lage.id] })).status).toBe(200);
    const s2User = await userCookie('Sven', [s2.id]);

    // Ausgang: Kopie an S2, nicht an die Absenderrolle selbst
    const out = (await outgoing({ text: 'ELW 1' })).body;
    expect(out.copies).toEqual([{ roleId: s2.id, role: 'S2', ackAt: null, ackBy: null }]);
    expect((await list(inc.id, s2User.cookie))[0]?.pending).toBe('copy');
    expect((await list(inc.id, stab.cookie))[0]?.pending).toBeNull();
    // Fernmelder bleibt zuständig, die Kopie ändert daran nichts
    expect((await list(inc.id, fm1.cookie))[0]?.pending).toBe('radio');

    expect((await act(out.id, 'ack', s2User.cookie)).body).toMatchObject({ pending: null, mine: true, copies: [{ role: 'S2', ackBy: 'Sven Test' }] });
    expect((await act(out.id, 'ack', s2User.cookie)).status).toBe(409);

    // Eingang an Lage: Kopie an S2
    const inc2 = (await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender: { text: 'ELW 1' }, recipientRoleId: lage.id, body: 'Lage' }, fm1.cookie)).body;
    expect(inc2.copies.map((k) => k.role)).toEqual(['S2']);
    expect((await list(inc.id, s2User.cookie)).find((m) => m.id === inc2.id)?.pending).toBe('copy');

    // Lesen der Kopie durch S2 lässt die Meldung bei der Zielrolle ungelesen
    await act(inc2.id, 'ack', s2User.cookie);
    expect((await list(inc.id, stab.cookie)).find((m) => m.id === inc2.id)).toMatchObject({ pending: 'recipient', ackAt: null, doneAt: null });
    expect((await list(inc.id, s2User.cookie)).find((m) => m.id === inc2.id)?.pending).toBeNull();
    // und umgekehrt: Kenntnisnahme durch die Zielrolle liest nicht die Kopie
    const inc3 = (await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender: { text: 'ELW 1' }, recipientRoleId: lage.id, body: 'Nachtrag' }, fm1.cookie)).body;
    await act(inc3.id, 'ack', stab.cookie);
    expect((await list(inc.id, s2User.cookie)).find((m) => m.id === inc3.id)?.pending).toBe('copy');
  });

  it('„Erneut versuchen“ des Fernmelders hält Kopien nicht zurück', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(messageNeedsAttention({ pending: 'copy', remindAt: future }, Date.now())).toBe(true);
    expect(messageNeedsAttention({ pending: 'radio', remindAt: future }, Date.now())).toBe(false);
  });
});

describe('Eingangsmeldungen', () => {
  const incoming = (payload: object, cookie = fm1.cookie) =>
    req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender: { text: 'ELW 1' }, body: 'Lage unverändert', ...payload }, cookie);

  it('ohne Dispatcher wählt der Fernmelder die Zielrolle', async () => {
    expect((await req<MessageContext>('GET', '/api/messages/context', undefined, fm1.cookie)).body).toMatchObject({ radio: true, dispatcherPresent: false });
    expect((await incoming({ recipientRoleId: lage.id }, stab.cookie)).status).toBe(403);
    expect((await incoming({})).status).toBe(400);
    const m = (await incoming({ recipientRoleId: lage.id })).body;
    expect(m).toMatchObject({ sender: 'ELW 1', recipient: 'Lage', pending: null });
    expect((await list(inc.id, stab.cookie))[0]?.pending).toBe('recipient');
    expect((await act(m.id, 'ack', stab.cookie)).body).toMatchObject({ ackBy: 'Stab Test', doneBy: 'Stab Test', pending: null });
  });

  it('mit Dispatcher verteilt dieser – die Auswahl des Fernmelders zählt nicht', async () => {
    const disp = await userCookie('Doris', [dispatch.id]);
    expect((await req<MessageContext>('GET', '/api/messages/context', undefined, fm1.cookie)).body.dispatcherPresent).toBe(true);
    const m = (await incoming({ recipientRoleId: lage.id })).body;
    expect(m).toMatchObject({ recipient: null, recipientRoleId: null });
    expect((await list(inc.id, disp.cookie))[0]?.pending).toBe('dispatch');
    expect((await list(inc.id, fm1.cookie))[0]?.pending).toBeNull();
    expect((await act(m.id, 'route', fm1.cookie, { roleId: lage.id })).status).toBe(403);

    await act(m.id, 'claim', disp.cookie);
    expect((await act(m.id, 'route', disp.cookie, { roleId: lage.id })).body).toMatchObject({ recipient: 'Lage', pending: null });
    expect((await list(inc.id, stab.cookie))[0]?.pending).toBe('recipient');

    // Antwort der Zielrolle wird zur Ausgangsmeldung und gilt als Kenntnisnahme
    const answer = (
      await req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'out', senderRoleId: lage.id, recipient: { text: 'ELW 1' }, body: 'Danke', replyToId: m.id }, stab.cookie)
    ).body;
    expect(answer).toMatchObject({ replyToId: m.id, recipient: 'ELW 1' });
    const after = await list(inc.id, stab.cookie);
    expect(after.find((x) => x.id === m.id)).toMatchObject({ ackBy: 'Stab Test', pending: null });
  });

  it('meldet sich der Dispatcher ab, verteilen die Fernmelder', async () => {
    const disp = await userCookie('Doris', [dispatch.id]);
    const m = (await incoming({})).body;
    await req('POST', '/api/auth/logout', undefined, disp.cookie);
    expect((await list(inc.id, fm1.cookie))[0]?.pending).toBe('dispatch');
    expect((await act(m.id, 'route', fm1.cookie, { roleId: lage.id })).body.recipient).toBe('Lage');
  });
});

describe('Eingangsmeldung aus einem Funkspruch', () => {
  const incoming = (sender: object, issi: string | null) =>
    req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender, recipientRoleId: lage.id, body: 'Lage unverändert', issi }, fm1.cookie);
  const radioIds = () => req<{ issi: string; unitId: number | null; forceUnitId: number | null; name: string }[]>('GET', `/api/incidents/${inc.id}/radio-ids`);

  it('merkt sich die ISSI zur gewählten Kraft im Einsatz, nicht bei Freitext', async () => {
    expect((await radioIds()).body).toEqual([]);
    expect((await incoming({ text: 'Unbekannt' }, '6122101')).status).toBe(201);
    expect((await radioIds()).body).toEqual([]);

    const hlf = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'HLF 1', callsign: 'Florian 1/46-1' })).body;
    expect((await incoming({ unitId: hlf.id, text: 'HLF 1' }, '6122101')).status).toBe(201);
    expect((await radioIds()).body).toMatchObject([{ issi: '6122101', unitId: hlf.id, forceUnitId: null, name: 'HLF 1', callsign: 'Florian 1/46-1' }]);

    // Eine Kraft kann mehrere Funkgeräte haben; eine ISSI gehört zu genau einer Kraft (neue Zuordnung ersetzt die alte)
    const elw = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'ELW 1' })).body;
    await incoming({ unitId: hlf.id, text: 'HLF 1' }, '6122102');
    await incoming({ unitId: elw.id, text: 'ELW 1' }, '6122101');
    expect((await radioIds()).body.map((r) => [r.issi, r.name])).toEqual([
      ['6122101', 'ELW 1'],
      ['6122102', 'HLF 1'],
    ]);
  });

  it('gilt nur im Einsatz und prüft die ISSI', async () => {
    const hlf = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'HLF 1' })).body;
    expect((await incoming({ unitId: hlf.id, text: 'HLF 1' }, 'abc')).status).toBe(400);
    await incoming({ unitId: hlf.id, text: 'HLF 1' }, '6122101');
    expect((await req('POST', `/api/incidents/${inc.id}/close`, {})).status).toBe(200);
    const next = (await req<Incident>('POST', '/api/incidents', { title: 'Zweiter Einsatz' })).body;
    expect((await req('GET', `/api/incidents/${next.id}/radio-ids`)).body).toEqual([]);
    expect((await radioIds()).body).toHaveLength(1);
  });
});
