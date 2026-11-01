import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dialableNumber, type Contact, type ContactCategory, type ContactInput, type PhonebookStatus } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

const inject = (method: 'GET' | 'POST', url: string, payload?: unknown, cookie = admin) => app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
const contact = async (input: ContactInput) => (await inject('POST', '/api/contacts', input)).json<Contact>();
const category = async (name: string, parentId: number | null = null) => (await inject('POST', '/api/contact-categories', { name, parentId })).json<ContactCategory>();
const status = async () => (await inject('GET', '/api/system/phonebook')).json<PhonebookStatus>();

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-phonebook-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Wählbare Nummern', () => {
  it('entfernt Formatierung und (0)', () => {
    expect(dialableNumber('+49 (0)5441 / 123-45')).toBe('+49544112345');
    expect(dialableNumber('0049 171 123')).toBe('+49171123');
    expect(dialableNumber('05441 9760-0')).toBe('0544197600');
    expect(dialableNumber('*31# 112')).toBe('*31#112');
    expect(dialableNumber('k. A.')).toBe('');
  });
});

describe('Telefonbuch für DECT-Basen', () => {
  it('liefert die Kontakte als Yealink-XML, je Nummer ein Eintrag', async () => {
    await contact({ kind: 'person', lastName: 'Meyer', firstName: 'Hans', organization: 'THW & Co', phones: [{ label: 'Mobil', number: '0171 123' }, { label: '', number: '05441 1' }] });
    await contact({ kind: 'organization', organization: 'Bauhof', phones: [{ label: '', number: '+49 (0)5441 99' }] });
    await contact({ kind: 'organization', organization: 'Ohne Telefon' });
    const s = await status();
    expect(s.token.length).toBeGreaterThan(20);
    expect(s).toMatchObject({ contacts: 2, entries: 3 });

    const res = await inject('GET', `/api/phonebook/${s.token}/yealink.xml`, undefined, '');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<YealinkIPPhoneDirectory>\n' +
        '  <DirectoryEntry>\n    <Name>Bauhof</Name>\n    <Telephone>+49544199</Telephone>\n  </DirectoryEntry>\n' +
        '  <DirectoryEntry>\n    <Name>Meyer, Hans (THW &amp; Co) - 054411</Name>\n    <Telephone>054411</Telephone>\n  </DirectoryEntry>\n' +
        '  <DirectoryEntry>\n    <Name>Meyer, Hans (THW &amp; Co) - Mobil</Name>\n    <Telephone>0171123</Telephone>\n  </DirectoryEntry>\n' +
        '</YealinkIPPhoneDirectory>\n',
    );
  });

  it('filtert nach Kategorie samt Unterkategorien', async () => {
    const firmen = await category('Unternehmen');
    const getraenke = await category('Getränke', firmen.id);
    await contact({ kind: 'organization', organization: 'Getränke Meyer', phones: [{ label: '', number: '1' }], categoryIds: [getraenke.id] });
    await contact({ kind: 'organization', organization: 'Bauhof', phones: [{ label: '', number: '2' }] });
    const { token } = await status();
    const body = (await inject('GET', `/api/phonebook/${token}/kategorie/${firmen.id}/yealink.xml`, undefined, '')).body;
    expect(body).toContain('Getränke Meyer');
    expect(body).not.toContain('Bauhof');
    expect((await inject('GET', `/api/phonebook/${token}/kategorie/999/yealink.xml`, undefined, '')).statusCode).toBe(404);
  });

  it('verlangt das gültige Token; neu erzeugen nur Admins', async () => {
    const { token } = await status();
    expect((await inject('GET', '/api/phonebook/falsch/yealink.xml', undefined, '')).statusCode).toBe(404);
    expect((await inject('GET', '/api/system/phonebook', undefined, '')).statusCode).toBe(401);
    expect((await inject('POST', '/api/system/phonebook/token', undefined, '')).statusCode).toBe(401);
    const next = (await inject('POST', '/api/system/phonebook/token')).json<PhonebookStatus>();
    expect(next.token).not.toBe(token);
    expect((await inject('GET', `/api/phonebook/${token}/yealink.xml`, undefined, '')).statusCode).toBe(404);
    expect((await inject('GET', `/api/phonebook/${next.token}/yealink.xml`, undefined, '')).statusCode).toBe(200);
  });
});
