import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { phoneKey, smsParts, type AuditEntry, type CallRecord, type ChatAttachment, type ChatAvailability, type ChatList, type ChatMessage, type ChatReachability, type ChatThread, type ForceUnit, type Incident, type JournalEntry, type Message, type Role, type Unit } from '@elvis/shared';
import { simImage, simPeer } from '../devices/sim/messenger.js';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { callJournalText, fmtDuration } from '../services/telephony.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const until = async (cond: () => Promise<boolean>, ms = 6000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-chat-'));
  // Telefonie- und Messenger-Module mit Simulator (Standard)
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  await app.devices.start();
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const received = (number: string, text: string) => app.chat.ingestSms({ port: 1, number, text, receivedAt: new Date().toISOString() });
const sentList = async () => (await req<ChatList>('GET', '/api/chat/messages?folder=sent')).body.items;
const settled = () => until(async () => (await sentList()).every((m) => m.status !== 'sending'));

function multipart(file: { name: string; type: string; data: Buffer }) {
  const boundary = '----elvis' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: admin } };
}


describe('Rufnummern und SMS-Länge', () => {
  it('vergleicht Rufnummern im internationalen Format', () => {
    expect(phoneKey('0171 1234567')).toBe('+491711234567');
    expect(phoneKey('+49 (0)171 / 123-4567')).toBe('+491711234567');
    expect(phoneKey('0049 171 1234567')).toBe('+491711234567');
    expect(phoneKey('112')).toBe('112');
  });

  it('zählt Teile im GSM-Zeichensatz und in Unicode', () => {
    expect(smsParts('Hallo')).toEqual({ length: 5, parts: 1, unicode: false });
    expect(smsParts('Grüße €')).toMatchObject({ length: 8, parts: 1, unicode: false });
    expect(smsParts('x'.repeat(161))).toMatchObject({ parts: 2 });
    expect(smsParts('Ok 👍')).toMatchObject({ unicode: true, parts: 1 });
  });
});

describe('Nachrichten: SMS', () => {
  it('ist mit dem Telefonie-Modul verfügbar und ohne nicht', async () => {
    const avail = (await req<ChatAvailability>('GET', '/api/chat/available')).body;
    expect(avail.order).toEqual(['signal', 'threema', 'whatsapp', 'telegram', 'sms']);
    expect(avail.channels.map((c) => [c.channel, c.available])).toEqual([
      ['signal', true],
      ['threema', true],
      ['whatsapp', true],
      ['telegram', true],
      ['sms', true],
    ]);
    expect(avail.ports).toEqual([
      { port: 1, name: 'Telekom 1', status: 'up' },
      { port: 2, name: 'Telekom 2', status: 'up' },
    ]);
    expect(avail.defaultPort).toBe(1);
    expect((await req('PUT', '/api/system/devices/telephony', { enabled: false, driver: 'sim', options: {} })).status).toBe(200);
    expect((await req<ChatAvailability>('GET', '/api/chat/available')).body.channels.find((c) => c.channel === 'sms')?.available).toBe(false);
    expect((await req('POST', '/api/chat/send', { to: [{ channel: 'sms', to: '0171 1234567' }], text: 'Hallo' })).status).toBe(409);
  });

  it('empfängt SMS mit Kontaktnamen, markiert gelesen und löscht', async () => {
    await req('POST', '/api/contacts', { kind: 'person', lastName: 'Muster', firstName: 'Max', phones: [{ label: 'Mobil', number: '0171 / 123 45 67' }] });
    received('+491711234567', 'Bin unterwegs');
    received('+491609999999', 'Wer bin ich?');
    const list = (await req<ChatList>('GET', '/api/chat/messages')).body;
    expect(list.unread).toBe(2);
    expect(list.items.map((m) => [m.channel, m.number, m.name, m.text, m.status])).toEqual([
      ['sms', '+491609999999', null, 'Wer bin ich?', 'received'],
      ['sms', '+491711234567', 'Muster, Max', 'Bin unterwegs', 'received'],
    ]);
    const id = list.items[0]!.id;
    expect((await req('POST', `/api/chat/messages/${id}/seen`, { seen: true })).status).toBe(204);
    expect((await req<{ count: number }>('GET', '/api/chat/unread')).body.count).toBe(1);
    expect((await req('DELETE', `/api/chat/messages/${id}`)).status).toBe(204);
    expect((await req('GET', `/api/chat/messages/${id}`)).status).toBe(404);
    // Nur Angemeldete
    expect((await req('GET', '/api/chat/messages', undefined, '')).status).toBe(401);
  });

  it('sendet über das Gateway, Ergebnis im Ordner „Gesendet“ und im Bedienprotokoll', async () => {
    const res = await req<ChatMessage[]>('POST', '/api/chat/send', { to: [{ channel: 'sms', to: '0171 1234567' }], text: 'Bitte Rückruf' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject([{ channel: 'sms', folder: 'sent', number: '+491711234567', status: 'sending', port: 1 }]);
    await settled();
    const [sent] = await sentList();
    expect(sent).toMatchObject({ status: 'sent', error: null, createdBy: 'Max Müller' });
    const audit = (await req<AuditEntry[]>('GET', '/api/audit')).body;
    expect(audit.find((a) => a.target === 'chat')).toMatchObject({ action: 'send', params: '+491711234567', success: true });

    // Fehler des Gateways
    await req('POST', '/api/chat/send', { to: [{ channel: 'sms', to: '0171 1234567' }], text: 'Test #fehler', port: 2 });
    await settled();
    expect((await sentList())[0]).toMatchObject({ status: 'failed', port: 2, error: expect.stringMatching(/lehnt ab/) });

    expect((await req('POST', '/api/chat/send', { to: [{ channel: 'sms', to: 'abc' }], text: 'x' })).status).toBe(400);
    expect((await req('POST', '/api/chat/send', { to: [{ channel: 'sms', to: '0171 1' }], text: 'x', port: 9 })).status).toBe(400);
    expect((await req('POST', '/api/chat/send', { to: [{ channel: 'sms', to: '0171 1' }], text: 'x'.repeat(641) })).status).toBe(400);
  }, 15_000);

  it('schlägt Empfänger aus Kontakten (Mobilnummern zuerst) und bisherigen Nachrichten vor', async () => {
    await req('POST', '/api/contacts', {
      kind: 'organization',
      organization: 'Muster GmbH',
      phones: [
        { label: 'Büro', number: '05441 1234' },
        { label: 'Bereitschaft', number: '0160 1112223' },
      ],
    });
    received('+491709998887', 'Hallo');
    expect((await req('GET', '/api/chat/suggest?q=muster')).body).toEqual([
      { number: '+491601112223', name: 'Muster GmbH', label: 'Bereitschaft', source: 'contact' },
      { number: '+4954411234', name: 'Muster GmbH', label: 'Büro', source: 'contact' },
    ]);
    expect((await req('GET', '/api/chat/suggest?q=0170999')).body).toEqual([{ number: '+491709998887', name: '', label: '', source: 'chat' }]);
  });
});

describe('Nachrichten: Messenger', () => {
  const incoming = (o: Partial<Parameters<App['chat']['ingest']>[0]> = {}) =>
    app.chat.ingest({
      channel: 'signal',
      peer: '+491711234567',
      number: '+491711234567',
      peerName: 'Max (Signal)',
      text: 'Bin da',
      attachment: null,
      location: null,
      externalId: 'ext-1',
      receivedAt: new Date().toISOString(),
      ...o,
    });

  it('empfängt Text, Standort und Bild, verwirft doppelte Zustellungen', async () => {
    expect(await incoming()).toMatchObject({ channel: 'signal', name: 'Max (Signal)', text: 'Bin da', status: 'received' });
    expect(await incoming()).toBeNull();
    await incoming({ channel: 'whatsapp', externalId: 'w1', text: '', location: { lat: 52.6, lon: 8.37, label: 'Marktplatz' } });
    const img = await incoming({ channel: 'telegram', peer: '123456789', number: null, peerName: 'Erika', externalId: 't1', text: 'Foto', attachment: { name: 'lage.png', mimeType: 'image/png', data: simImage() } });
    expect(img).toMatchObject({ peer: '123456789', number: null, name: 'Erika', attachment: { name: 'lage.png', mimeType: 'image/png' } });
    const file = await app.server.inject({ method: 'GET', url: `/api/chat/files/${img!.attachment!.id}`, headers: { cookie: admin } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.subarray(1, 4).toString()).toBe('PNG');

    // Ein Kontakt zur Rufnummer gewinnt gegen den Profilnamen; der Verlauf mischt die Kanäle
    await req('POST', '/api/contacts', { kind: 'person', lastName: 'Muster', firstName: 'Max', phones: [{ label: 'Mobil', number: '0171 1234567' }] });
    const thread = (await req<ChatMessage[]>('GET', '/api/chat/thread?key=%2B491711234567')).body;
    expect(thread.map((m) => [m.channel, m.name, m.location?.label ?? null])).toEqual([
      ['signal', 'Muster, Max', null],
      ['whatsapp', 'Muster, Max', 'Marktplatz'],
    ]);
    expect((await req<ChatMessage[]>('GET', '/api/chat/thread?key=telegram%3A123456789')).body).toHaveLength(1);
    // WhatsApp: wer in den letzten 24 h geschrieben hat, bekommt freie Antworten
    expect(Object.keys((await req<Record<string, string>>('GET', '/api/chat/whatsapp-window')).body)).toEqual(['+491711234567']);
    // Wer schreibt, ist über den Messenger erreichbar
    expect((await req<ChatReachability>('GET', '/api/chat/reachability')).body['+491711234567']).toEqual(['signal', 'whatsapp', 'sms']);
  });

  it('sendet über mehrere Kanäle mit Bild, Zustellbestätigung und Fehlern', async () => {
    const up = await app.server.inject({ method: 'POST', url: '/api/chat/files', ...multipart({ name: 'karte.png', type: 'image/png', data: simImage() }) });
    expect(up.statusCode).toBe(201);
    const attachment = up.json<ChatAttachment>();
    const res = await req<ChatMessage[]>('POST', '/api/chat/send', {
      to: [
        { channel: 'signal', to: '0171 1234567' },
        { channel: 'threema', to: 'abcd1234' },
        { channel: 'signal', to: '+49 171 1234567' },
      ],
      text: 'Lagebild',
      attachmentId: attachment.id,
    });
    expect(res.status).toBe(202);
    expect(res.body.map((m) => [m.channel, m.peer, m.number])).toEqual([
      ['signal', '+491711234567', '+491711234567'],
      ['threema', 'ABCD1234', null],
    ]);
    await settled();
    expect((await sentList()).map((m) => m.status)).toEqual(['sent', 'sent']);
    await until(async () => (await sentList()).every((m) => m.status === 'delivered' || m.status === 'read'));

    // SMS kann keine Bilder, WhatsApp braucht eine Rufnummer
    expect((await req('POST', '/api/chat/send', { to: [{ channel: 'sms', to: '0171 1234567' }], attachmentId: attachment.id })).status).toBe(400);
    expect((await req('POST', '/api/chat/send', { to: [{ channel: 'whatsapp', to: 'max' }], text: 'x' })).status).toBe(400);
    expect((await req('POST', '/api/chat/send', { to: [{ channel: 'signal', to: '0171 1234567' }] })).status).toBe(400);
    // Nur Bilder
    const pdf = await app.server.inject({ method: 'POST', url: '/api/chat/files', ...multipart({ name: 'x.pdf', type: 'application/pdf', data: Buffer.from('%PDF') }) });
    expect(pdf.statusCode).toBe(415);

    await req('POST', '/api/chat/send', { to: [{ channel: 'telegram', to: '0171 1234567' }], text: 'Test #fehler' });
    await settled();
    expect((await sentList())[0]).toMatchObject({ channel: 'telegram', status: 'failed', error: expect.stringMatching(/Telegram lehnt ab/) });
    // Abgeschaltetes Modul
    expect((await req('PUT', '/api/system/devices/threema', { enabled: false, driver: 'sim', options: {} })).status).toBe(200);
    expect((await req('POST', '/api/chat/send', { to: [{ channel: 'threema', to: 'ABCD1234' }], text: 'x' })).status).toBe(409);
  }, 20_000);

  it('sendet Standorte per SMS als Kartenlink', async () => {
    await req('POST', '/api/chat/send', { to: [{ channel: 'sms', to: '0171 1234567' }], text: 'Treffpunkt', location: { lat: 52.6087, lon: 8.3712, label: 'Marktplatz' } });
    await settled();
    expect((await sentList())[0]).toMatchObject({ status: 'sent', text: 'Treffpunkt', location: { lat: 52.6087, lon: 8.3712, label: 'Marktplatz' } });
  }, 10_000);

  it('prüft die Erreichbarkeit der Kontakte und ordnet Antworten über die Kennung zu', async () => {
    await req('POST', '/api/contacts', { kind: 'person', lastName: 'Muster', firstName: 'Max', phones: [{ label: 'Mobil', number: '0170 1234567' }, { label: 'Büro', number: '05441 1234' }] });
    await app.reachability.refresh();
    const map = (await req<ChatReachability>('GET', '/api/chat/reachability')).body;
    // Simulation: die Beispielnummer nutzt alle prüfbaren Messenger; WhatsApp lässt sich nicht prüfen
    expect(map['+491701234567']).toEqual(['signal', 'threema', 'telegram', 'sms']);
    expect(map['+4954411234']).toBeUndefined();

    // Antwort über Threema (nur mit Threema-ID) landet beim Kontakt
    const msg = await incoming({ channel: 'threema', peer: simPeer('threema', '+491701234567'), number: null, peerName: null, externalId: 'th1' });
    expect(msg).toMatchObject({ number: '+491701234567', name: 'Muster, Max' });

    // Reihenfolge einstellen
    expect((await req('PUT', '/api/system/chat', { order: ['sms', 'telegram', 'signal', 'threema', 'whatsapp'] })).status).toBe(200);
    expect((await req<ChatReachability>('GET', '/api/chat/reachability')).body['+491701234567']).toEqual(['sms', 'telegram', 'signal', 'threema']);
    expect((await req('PUT', '/api/system/chat', { order: ['sms', 'sms'] })).status).toBe(400);

    // Frei eingegebene Rufnummer sofort prüfen
    const checked = (await req<ChatReachability>('POST', '/api/chat/reachability/check', { numbers: ['0160 9876543'] })).body;
    expect(checked['+491609876543']).toEqual(expect.arrayContaining(['signal', 'sms']));
  });
});

describe('Nachrichten: Gespräche', () => {
  it('fasst je Kontakt alle Rufnummern und Kanäle zu einem Gespräch zusammen', async () => {
    const contact = (await req<{ id: number }>('POST', '/api/contacts', { kind: 'person', lastName: 'Muster', firstName: 'Max', phones: [{ label: 'Mobil', number: '0171 1234567' }, { label: 'Dienst', number: '0160 7654321' }] })).body;
    received('+491711234567', 'Per SMS');
    await app.chat.ingest({ channel: 'signal', peer: '+491607654321', number: '+491607654321', peerName: null, text: 'Per Signal', attachment: null, location: null, externalId: 's1', receivedAt: new Date(Date.now() + 1000).toISOString() });
    await app.chat.ingest({ channel: 'threema', peer: 'ECHOECHO', number: null, peerName: 'Unbekannt', text: 'Hallo', attachment: null, location: null, externalId: 't1', receivedAt: new Date(Date.now() - 60_000).toISOString() });

    const threads = (await req<ChatThread[]>('GET', '/api/chat/threads')).body;
    expect(threads.map((t) => [t.key, t.name, t.numbers, t.channels, t.unread, t.count, t.last.text])).toEqual([
      [`contact:${contact.id}`, 'Muster, Max', ['+491607654321', '+491711234567'], ['signal', 'sms'], 2, 2, 'Per Signal'],
      ['threema:ECHOECHO', 'Unbekannt', [], ['threema'], 1, 1, 'Hallo'],
    ]);
    const messages = (await req<ChatMessage[]>('GET', `/api/chat/thread?key=contact:${contact.id}`)).body;
    expect(messages.map((m) => [m.channel, m.text, m.thread])).toEqual([
      ['sms', 'Per SMS', `contact:${contact.id}`],
      ['signal', 'Per Signal', `contact:${contact.id}`],
    ]);
    expect((await req<{ marked: number }>('POST', '/api/chat/thread/seen', { key: `contact:${contact.id}` })).body.marked).toBe(2);
    expect((await req<ChatThread[]>('GET', '/api/chat/threads')).body.map((t) => t.unread)).toEqual([0, 1]);
    expect((await req<{ count: number }>('GET', '/api/chat/unread')).body.count).toBe(1);
  });

  it('löscht ein ganzes Gespräch über alle Rufnummern und Kanäle', async () => {
    const contact = (await req<{ id: number }>('POST', '/api/contacts', { kind: 'person', lastName: 'Muster', firstName: 'Max', phones: [{ label: 'Mobil', number: '0171 1234567' }, { label: 'Dienst', number: '0160 7654321' }] })).body;
    received('+491711234567', 'Per SMS');
    await app.chat.ingest({ channel: 'signal', peer: '+491607654321', number: '+491607654321', peerName: null, text: 'Per Signal', attachment: null, location: null, externalId: 's1', receivedAt: new Date().toISOString() });
    await app.chat.ingest({ channel: 'threema', peer: 'ECHOECHO', number: null, peerName: 'Unbekannt', text: 'Bleibt', attachment: null, location: null, externalId: 't1', receivedAt: new Date().toISOString() });

    const res = await req<{ removed: number }>('DELETE', `/api/chat/thread?key=contact:${contact.id}`);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);
    expect((await req<ChatThread[]>('GET', '/api/chat/threads')).body.map((t) => t.key)).toEqual(['threema:ECHOECHO']);
    expect((await req('DELETE', `/api/chat/thread?key=contact:${contact.id}`)).status).toBe(404);
    expect((await req<{ removed: number }>('DELETE', '/api/chat/thread?key=threema:ECHOECHO')).body.removed).toBe(1);
  });
});

describe('Einrichtung der Messenger', () => {
  it('liefert den Stand nur Admins, der Simulator braucht keine Einrichtung', async () => {
    expect((await req('GET', '/api/system/messengers/signal/setup')).body).toEqual({ channel: 'signal', driver: 'sim', setup: null, qr: null, webhook: null });
    expect((await req('POST', '/api/system/messengers/signal/setup', { action: 'link' })).status).toBe(400);
    expect((await req('POST', '/api/system/messengers/signal/setup', { action: 'hack' })).status).toBe(400);
    expect((await req('GET', '/api/system/messengers/sms/setup')).status).toBe(400);
    expect((await req('GET', '/api/system/messengers/signal/setup', undefined, '')).status).toBe(401);
    // signal-cli ohne Addon: Modul läuft, meldet die Störung
    expect((await req('PUT', '/api/system/devices/signal', { enabled: true, driver: 'signal-cli', options: {} })).status).toBe(200);
    await until(async () => (await req<{ setup: unknown; driver: string }>('GET', '/api/system/messengers/signal/setup')).body.driver === 'signal-cli');
    expect((await req('POST', '/api/system/messengers/signal/setup', { action: 'link' })).status).toBe(503);
    const audit = (await req<AuditEntry[]>('GET', '/api/audit')).body;
    expect(audit.find((a) => a.target === 'signal')).toMatchObject({ action: 'setup.link', params: '', success: false });
  });
});

describe('Anrufliste', () => {
  const call = (o: Partial<Parameters<App['calls']['record']>[0]> = {}) =>
    app.calls.record({
      direction: 'in',
      port: 1,
      number: '+491711234567',
      startedAt: '2026-10-31T10:00:00.000Z',
      answeredAt: '2026-10-31T10:00:05.000Z',
      endedAt: '2026-10-31T10:02:10.000Z',
      ...o,
    });

  it('formuliert Tagebucheinträge', () => {
    const c = { direction: 'in' as const, port: 1, number: '+491711234567', startedAt: 'a', answeredAt: '2026-10-31T10:00:00Z', endedAt: '2026-10-31T10:02:05Z' };
    expect(callJournalText(c, 'Muster, Max (Mobil), +49 171 1234567', 'Telekom 1')).toBe('Anruf von Muster, Max (Mobil), +49 171 1234567 über Telekom 1, Dauer 2:05 min');
    expect(callJournalText({ ...c, answeredAt: null }, 'X', null)).toBe('Verpasster Anruf von X');
    expect(callJournalText({ ...c, direction: 'out', answeredAt: null }, 'X', 'GSM 2')).toBe('Anruf an X über GSM 2 – nicht erreicht');
    expect(fmtDuration(3725)).toBe('1:02:05 h');
  });

  it('schreibt Anrufe nur bei laufendem Einsatz ins Tagebuch', async () => {
    call({ startedAt: new Date(Date.now() - 300_000).toISOString(), answeredAt: null, endedAt: new Date(Date.now() - 280_000).toISOString() });
    const inc = (await req<Incident>('POST', '/api/incidents', { title: 'Sturm' })).body;
    await req('POST', '/api/contacts', { kind: 'person', lastName: 'Muster', firstName: 'Max', phones: [{ label: 'Mobil', number: '0171 1234567' }] });
    const now = Date.now();
    call({ startedAt: new Date(now - 130_000).toISOString(), answeredAt: new Date(now - 125_000).toISOString(), endedAt: new Date(now).toISOString() });
    call({ direction: 'out', port: 2, number: '+4954411234', startedAt: new Date(now - 30_000).toISOString(), answeredAt: null, endedAt: new Date(now).toISOString() });

    const journal = (await req<JournalEntry[]>('GET', `/api/incidents/${inc.id}/journal`)).body.filter((e) => e.category === 'telefon');
    expect(journal.map((e) => [e.text, e.sender, e.recipient, e.author])).toEqual([
      ['Anruf von Muster, Max (Mobil), +49 171 1234567 über Telekom 1, Dauer 2:05 min', 'Muster, Max (Mobil), +49 171 1234567', 'ELW 2', 'Telefonie'],
      ['Anruf an +4954411234 über Telekom 2 – nicht erreicht', 'ELW 2', '+4954411234', 'Telefonie'],
    ]);
    const calls = (await req<CallRecord[]>('GET', '/api/telephony/calls')).body;
    expect(calls.map((c) => [c.direction, c.name, c.trunk, c.incidentId])).toEqual([
      ['out', null, 'Telekom 2', inc.id],
      ['in', 'Muster, Max', 'Telekom 1', inc.id],
      ['in', 'Muster, Max', 'Telekom 1', null],
    ]);
    expect(calls[1]!.durationS).toBe(125);
  });
});

describe('Eingangsmeldung aus einer Nachricht', () => {
  it('merkt sich die Rufnummer an Kraft und Systemeinheit, auch bei der Übernahme', async () => {
    const funk = (await req<Role>('POST', '/api/system/roles', { name: 'Fernmelder' })).body;
    const lage = (await req<Role>('POST', '/api/system/roles', { name: 'Lage' })).body;
    await req('PUT', '/api/system/messages', { radioRoleIds: [funk.id], dispatcherRoleIds: [] });
    await req('PUT', '/api/auth/role', { roleIds: [funk.id] });
    const inc = (await req<Incident>('POST', '/api/incidents', { title: 'Hochwasser' })).body;
    const sms = received('+491711234567', 'Pumpe läuft');
    const incoming = (sender: object) =>
      req<Message>('POST', `/api/incidents/${inc.id}/messages`, { direction: 'in', sender, recipientRoleId: lage.id, body: sms.text, chatId: sms.id });

    const hlf = (await req<Unit>('POST', `/api/incidents/${inc.id}/units`, { name: 'HLF 1' })).body;
    expect((await incoming({ unitId: hlf.id, text: 'HLF 1' })).status).toBe(201);
    expect((await req<Unit>('GET', `/api/units/${hlf.id}`)).body.mobile).toBe('+491711234567');

    const leitstelle = (await req<ForceUnit>('POST', '/api/system/forces', { name: 'Leitstelle' })).body;
    expect((await incoming({ forceUnitId: leitstelle.id, text: 'Leitstelle' })).status).toBe(201);
    expect((await req<ForceUnit[]>('GET', '/api/forces')).body.find((f) => f.id === leitstelle.id)?.mobile).toBe('+491711234567');
    const unit = (await req<Unit>('POST', `/api/incidents/${inc.id}/units/deploy`, { tree: { forceUnitId: leitstelle.id, children: [] } })).body;
    expect(unit.mobile).toBe('+491711234567');

    // Rufnummer von Hand pflegen
    expect((await req<Unit>('PATCH', `/api/units/${hlf.id}`, { mobile: '0160 1234567' })).body.mobile).toBe('+491601234567');
    expect((await req('PATCH', `/api/units/${hlf.id}`, { mobile: 'abc' })).status).toBe(400);
  });
});
