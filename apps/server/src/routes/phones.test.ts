import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Contact, Incident, Phone, PhoneKeySlot, PhonebookStatus, PhoneSystemStatus, User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';
let pushed: { url: string; auth: string }[];
let phoneStatus = 200;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const req = async <T = unknown>(method: Method, url: string, payload?: unknown, cookie = admin, headers: Record<string, string> = {}) => {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  return { status: res.statusCode, body: (res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : undefined) as T, raw: res.body };
};

const PHONE = { name: 'Lagetisch', mac: '00:04:13:AA:BB:01', extension: '101', displayName: 'ELW Lage', sipPassword: 'geh eim<&>' };

const userCookie = async () => {
  const user = (await req<User>('POST', '/api/users', { firstName: 'Anna', lastName: 'Test', pin: '1111' })).body;
  const res = await app.server.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: user.id, pin: '1111' } });
  return sessionCookie(res.headers['set-cookie']);
};

const status = async () => (await req<PhoneSystemStatus>('GET', '/api/system/phones/config')).body;
const provision = async (token: string, mac = '000413AABB01', ip = '10.0.0.21') =>
  app.server.inject({ method: 'GET', url: `/api/provisioning/${token}/snom/${mac}.xml`, headers: { 'user-agent': 'Mozilla/4.0 (compatible; snom D385 10.1.141.13)' }, remoteAddress: ip });
const fkey = (xml: string, idx: number) => new RegExp(`<fkey idx="${idx}" context="active" label="([^"]*)" perm="R">([^<]*)</fkey>`).exec(xml)?.slice(1);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-phones-'));
  pushed = [];
  phoneStatus = 200;
  app = await buildApp(parseConfig({ dataDir }), {
    logger: false,
    phonePushDelayMs: 0,
    phoneFetch: async (url, init) => {
      pushed.push({ url, auth: init.headers.authorization! });
      return { ok: phoneStatus < 400, status: phoneStatus };
    },
  });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Tischtelefone (Snom)', () => {
  it('legt Telefone an, prüft MAC und Nebenstelle und verbirgt das SIP-Passwort', async () => {
    const created = await req<Phone>('POST', '/api/system/phones', PHONE);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ mac: '00:04:13:aa:bb:01', model: 'd385', extension: '101', hasPassword: true });
    expect(JSON.stringify(created.body)).not.toContain('geh eim');

    expect((await req('POST', '/api/system/phones', { ...PHONE, extension: '102' })).status).toBe(409);
    expect((await req('POST', '/api/system/phones', { ...PHONE, mac: '000413aabb02' })).status).toBe(409);
    expect((await req('POST', '/api/system/phones', { ...PHONE, mac: 'xx', extension: '103' })).status).toBe(400);

    // Leeres Passwort beim Ändern = unverändert
    const updated = await req<Phone>('PUT', `/api/system/phones/${created.body.id}`, { ...PHONE, name: 'Funktisch', sipPassword: '' });
    expect(updated.body).toMatchObject({ name: 'Funktisch', hasPassword: true });
  });

  it('Verwaltung nur für Admins, Abruf der Konfiguration nur mit gültigem Token', async () => {
    const user = await userCookie();
    expect((await req('GET', '/api/system/phones/config', undefined, '')).status).toBe(401);
    expect((await req('GET', '/api/system/phones/config', undefined, user)).status).toBe(403);
    expect((await req('POST', '/api/system/phones', PHONE, user)).status).toBe(403);
    expect((await req('GET', '/api/phones', undefined, user)).status).toBe(200);

    await req('POST', '/api/system/phones', PHONE);
    const { token } = await status();
    expect((await provision('falsch')).statusCode).toBe(404);
    expect((await provision(token, '000413FFFFFF')).statusCode).toBe(404);
    expect((await provision(token)).statusCode).toBe(200);

    const fresh = (await req<PhoneSystemStatus>('POST', '/api/system/phones/token')).body;
    expect(fresh.token).not.toBe(token);
    expect((await provision(token)).statusCode).toBe(404);
    expect((await provision(fresh.token)).statusCode).toBe(200);
  });

  it('liefert SIP-Konto, Telefonbuch und Tasten im Snom-Format und merkt sich das Telefon', async () => {
    await req('PUT', '/api/system/phones/config', { registrar: 'pbx.elw', pickupPrefix: '*8', ntpServer: '10.0.0.1' });
    const phone = (await req<Phone>('POST', '/api/system/phones', PHONE)).body;
    const s = await status();
    const pb = (await req<PhonebookStatus>('GET', '/api/system/phonebook')).body;

    await req('PUT', `/api/phones/${phone.id}/keys/0`, { scope: 'phone', key: { type: 'number', number: '+49 (0)5441 / 123', label: 'Leitstelle' } });
    await req('PUT', `/api/phones/${phone.id}/keys/1`, { scope: 'phone', key: { type: 'blf', extension: '102', label: 'Funk' } });

    const res = await provision(s.token);
    expect(res.headers['content-type']).toContain('application/xml');
    const xml = res.body;
    expect(xml).toContain(`<setting_server perm="R">http://localhost:80/api/provisioning/${s.token}/snom/{mac}.xml</setting_server>`);
    expect(xml).toContain('<user_name idx="1" perm="R">101</user_name>');
    expect(xml).toContain('<user_pname idx="1" perm="R">101</user_pname>');
    expect(xml).toContain('<user_pass idx="1" perm="R">geh eim&lt;&amp;&gt;</user_pass>');
    expect(xml).toContain('<user_host idx="1" perm="R">pbx.elw</user_host>');
    expect(xml).toContain('<user_realname idx="1" perm="R">ELW Lage</user_realname>');
    expect(xml).toContain('<ntp_server perm="R">10.0.0.1</ntp_server>');
    expect(xml).toContain(`<http_pass perm="R">${s.adminPassword}</http_pass>`);
    expect(xml).toContain(`<dkey_directory perm="R">url http://localhost:80/api/phonebook/${pb.token}/snom.xml</dkey_directory>`);
    expect(fkey(xml, 0)).toEqual(['Leitstelle', 'speed +495441123']);
    expect(fkey(xml, 1)).toEqual(['Funk', 'blf &lt;sip:102@pbx.elw&gt;|*8']);
    expect(fkey(xml, 47)).toEqual(['', 'none']);
    expect(fkey(xml, 48)).toBeUndefined();

    const seen = (await req<Phone[]>('GET', '/api/phones')).body[0]!;
    expect(seen).toMatchObject({ lastIp: '10.0.0.21', firmware: '10.1.141.13' });
    expect(seen.lastSeenAt).not.toBeNull();
  });

  it('Ebenen: Einsatz vor Telefon vor Vorlage; Überschreibung nur im Einsatz, mit dem Einsatzende weg', async () => {
    const phone = (await req<Phone>('POST', '/api/system/phones', PHONE)).body;
    const user = await userCookie();
    await req('PUT', '/api/system/phones/template/0', { key: { type: 'number', number: '112', label: 'Vorlage' } });
    await req('PUT', '/api/system/phones/template/1', { key: { type: 'number', number: '113' } });
    await req('PUT', `/api/phones/${phone.id}/keys/1`, { scope: 'phone', key: { type: 'number', number: '114', label: 'Telefon' } });

    // Ohne Einsatz: nichts zu überschreiben, Grundbelegung nur Admins
    const k = { type: 'number', number: '115', label: 'Einsatz' };
    expect((await req('PUT', `/api/phones/${phone.id}/keys/1`, { key: k }, user)).status).toBe(409);
    expect((await req('PUT', `/api/phones/${phone.id}/keys/1`, { key: k, scope: 'phone' }, user)).status).toBe(403);

    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const slots = (await req<PhoneKeySlot[]>('PUT', `/api/phones/${phone.id}/keys/1`, { key: k }, user)).body;
    expect(slots[0]).toMatchObject({ source: 'template', label: 'Vorlage', target: '112' });
    expect(slots[1]).toMatchObject({ source: 'incident', label: 'Einsatz', target: '115', phone: { number: '114' }, template: { number: '113' } });
    // Freigeben überdeckt die Vorlage
    const freed = (await req<PhoneKeySlot[]>('PUT', `/api/phones/${phone.id}/keys/0`, { key: { type: 'empty' } }, user)).body;
    expect(freed[0]).toMatchObject({ source: 'incident', label: '', target: '' });

    await req('POST', `/api/incidents/${incident.id}/close`);
    const after = (await req<PhoneKeySlot[]>('GET', `/api/phones/${phone.id}/keys`)).body;
    expect(after[0]).toMatchObject({ source: 'template', target: '112', incident: null });
    expect(after[1]).toMatchObject({ source: 'phone', target: '114', incident: null });

    // Ein neuer Einsatz beginnt wieder mit der Grundbelegung
    await req('POST', '/api/incidents', { title: 'TH' });
    expect((await req<PhoneKeySlot[]>('GET', `/api/phones/${phone.id}/keys`)).body[1]).toMatchObject({ source: 'phone' });
  });

  it('Kontakt-Tasten folgen dem Kontakt', async () => {
    const phone = (await req<Phone>('POST', '/api/system/phones', PHONE)).body;
    const c = (await req<Contact>('POST', '/api/contacts', { kind: 'person', lastName: 'Meyer', firstName: 'Hans', phones: [{ label: 'Büro', number: '05441 1' }, { label: 'Mobil', number: '0171 2' }] })).body;
    await req('PUT', `/api/phones/${phone.id}/keys/2`, { scope: 'phone', key: { type: 'contact', contactId: c.id, phone: 1 } });
    expect((await req<PhoneKeySlot[]>('GET', `/api/phones/${phone.id}/keys`)).body[2]).toMatchObject({ label: 'Meyer, Hans', target: '01712', error: null });

    await req('PUT', `/api/contacts/${c.id}`, { kind: 'person', lastName: 'Meyer', firstName: 'Hans', phones: [{ label: 'Büro', number: '05441 1' }, { label: 'Mobil', number: '0171 9' }] });
    expect((await req<PhoneKeySlot[]>('GET', `/api/phones/${phone.id}/keys`)).body[2]).toMatchObject({ target: '01719' });

    await req('DELETE', `/api/contacts/${c.id}`);
    const gone = (await req<PhoneKeySlot[]>('GET', `/api/phones/${phone.id}/keys`)).body[2]!;
    expect(gone).toMatchObject({ target: '', error: 'Kontakt gelöscht' });
    const { token } = await status();
    expect(fkey((await provision(token)).body, 2)?.[1]).toBe('none');
  });

  it('überträgt geänderte Tasten an das Telefon, sobald seine Adresse bekannt ist', async () => {
    const phone = (await req<Phone>('POST', '/api/system/phones', PHONE)).body;
    const s = await status();
    // Adresse unbekannt: keine Übertragung
    expect((await req('POST', `/api/system/phones/${phone.id}/push`)).status).toBe(409);
    expect(pushed).toHaveLength(0);

    await provision(s.token);
    await req('PUT', `/api/phones/${phone.id}/keys/13`, { scope: 'phone', key: { type: 'number', number: '112', label: 'Notruf' } });
    const done = (await req<Phone>('POST', `/api/system/phones/${phone.id}/push`)).body;
    expect(done.push).toMatchObject({ state: 'ok', error: null });

    const last = pushed.slice(-4);
    expect(last).toHaveLength(4); // 48 Tasten in Blöcken zu 12
    const url = new URL(last[1]!.url);
    expect(url.host).toBe('10.0.0.21');
    expect(url.pathname).toBe('/dummy.htm');
    expect(url.searchParams.get('settings')).toBe('save');
    expect(url.searchParams.get('store_settings')).toBe('save');
    expect(url.searchParams.get('fkey13')).toBe('speed 112');
    expect(url.searchParams.get('fkey_label13')).toBe('Notruf');
    expect(last[0]!.auth).toBe(`Basic ${Buffer.from(`admin:${s.adminPassword}`).toString('base64')}`);

    phoneStatus = 401;
    const failed = (await req<Phone>('POST', `/api/system/phones/${phone.id}/push`)).body;
    expect(failed.push).toMatchObject({ state: 'failed' });
    expect(failed.push?.error).toContain('Zugang abgelehnt');
  });

  it('liefert die Kontakte als Snom-Telefonbuch', async () => {
    await req('POST', '/api/contacts', { kind: 'organization', organization: 'Bauhof & Co', phones: [{ label: '', number: '+49 (0)5441 99' }] });
    const pb = (await req<PhonebookStatus>('GET', '/api/system/phonebook')).body;
    const res = await req<string>('GET', `/api/phonebook/${pb.token}/snom.xml`, undefined, '');
    expect(res.status).toBe(200);
    expect(res.raw).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<SnomIPPhoneDirectory>\n  <Title>Kontakte</Title>\n' +
        '  <DirectoryEntry>\n    <Name>Bauhof &amp; Co</Name>\n    <Telephone>+49544199</Telephone>\n  </DirectoryEntry>\n' +
        '</SnomIPPhoneDirectory>\n',
    );
    expect((await req('GET', '/api/phonebook/falsch/snom.xml', undefined, '')).status).toBe(404);
  });
});
