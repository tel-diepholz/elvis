import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry, Contact, ContactCategory, ContactInput, Incident, MailAddressSuggestion, Person, Unit } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const category = async (name: string, parentId: number | null = null) => (await req<ContactCategory>('POST', '/api/contact-categories', { name, parentId })).body;
const contact = async (input: ContactInput) => (await req<Contact>('POST', '/api/contacts', input)).body;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-contacts-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Kontaktkategorien', () => {
  it('bilden einen Baum ohne Zyklen und doppelte Namen', async () => {
    const firmen = await category('Unternehmen');
    const getraenke = await category('Getränkelieferanten', firmen.id);
    expect(getraenke.parentId).toBe(firmen.id);
    expect((await req('POST', '/api/contact-categories', { name: 'getränkelieferanten', parentId: firmen.id })).status).toBe(409);
    expect((await req('PUT', `/api/contact-categories/${firmen.id}`, { name: 'Unternehmen', parentId: getraenke.id })).status).toBe(400);
    expect((await req('POST', '/api/contact-categories', { name: 'A/B', parentId: null })).status).toBe(400);
    expect((await req('GET', '/api/contact-categories', undefined, '')).status).toBe(401);
  });

  it('löscht nur Kategorien ohne Unterkategorien, Kontakte bleiben', async () => {
    const firmen = await category('Unternehmen');
    const getraenke = await category('Getränkelieferanten', firmen.id);
    const meyer = await contact({ kind: 'organization', organization: 'Getränke Meyer', categoryIds: [getraenke.id, firmen.id] });
    expect(meyer.categoryIds.sort()).toEqual([firmen.id, getraenke.id].sort());
    expect((await req('DELETE', `/api/contact-categories/${firmen.id}`)).status).toBe(409);
    expect((await req('DELETE', `/api/contact-categories/${getraenke.id}`)).status).toBe(204);
    const list = (await req<Contact[]>('GET', '/api/contacts')).body;
    expect(list.map((c) => [c.organization, c.categoryIds])).toEqual([['Getränke Meyer', [firmen.id]]]);
  });
});

describe('Kontakte', () => {
  it('legt an, ändert und löscht mit Bedienprotokoll', async () => {
    const c = await contact({ kind: 'person', lastName: 'Meyer', firstName: 'Hans', phones: [{ label: 'Mobil', number: '0171 123' }], email: 'Hans@Meyer.de' });
    expect(c.email).toBe('hans@meyer.de');
    expect((await req('POST', '/api/contacts', { kind: 'organization', organization: '' })).status).toBe(400);
    expect((await req('POST', '/api/contacts', { kind: 'person', lastName: 'X', email: 'keine-adresse' })).status).toBe(400);
    expect((await req('POST', '/api/contacts', { kind: 'person', lastName: 'X', categoryIds: [999] })).status).toBe(404);
    const updated = (await req<Contact>('PUT', `/api/contacts/${c.id}`, { ...c, function: 'Inhaber' })).body;
    expect(updated.function).toBe('Inhaber');
    expect(updated.phones).toEqual([{ label: 'Mobil', number: '0171 123' }]);
    expect((await req('DELETE', `/api/contacts/${c.id}`)).status).toBe(204);
    expect((await req('PUT', `/api/contacts/${c.id}`, c)).status).toBe(404);
    const audit = (await req<AuditEntry[]>('GET', '/api/audit')).body.filter((a) => a.target === 'kontakte');
    expect(audit.map((a) => a.action).sort()).toEqual(['create', 'delete', 'update']);
  });

  it('übernimmt Personal einer Einheit, aber nur einmal', async () => {
    const incident = (await req<Incident>('POST', '/api/incidents', { keyword: 'B3', title: 'Wohnungsbrand' })).body;
    const unit = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'HLF 20/1' })).body;
    const [p] = (
      await req<Person[]>('POST', `/api/units/${unit.id}/personnel`, {
        persons: [{ lastName: 'Schulz', firstName: 'Eva', organization: 'FF Diepholz', phone: '0151 9', email: 'eva@ff.de', employer: 'Stadtwerke' }],
      })
    ).body;
    expect(p!.email).toBe('eva@ff.de');
    const res = await req<Contact>('POST', `/api/personnel/${p!.id}/contact`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'person', lastName: 'Schulz', organization: 'FF Diepholz', email: 'eva@ff.de', phones: [{ label: 'Telefon', number: '0151 9' }], notes: 'Arbeitgeber: Stadtwerke' });
    expect((await req('POST', `/api/personnel/${p!.id}/contact`)).status).toBe(409);
    expect((await req('POST', '/api/personnel/999/contact')).status).toBe(404);
  });

  it('schlägt Mailadressen aus den Kontakten vor', async () => {
    await contact({ kind: 'organization', organization: 'Getränke Meyer', email: 'bestellung@meyer.de' });
    await contact({ kind: 'person', lastName: 'Meyerhoff', firstName: 'Jan', email: 'jan@example.org' });
    await contact({ kind: 'person', lastName: 'Ohne', firstName: 'Mail' });
    const hits = (await req<MailAddressSuggestion[]>('GET', '/api/mail/suggest?q=mey')).body;
    expect(hits.map((h) => h.address).sort()).toEqual(['bestellung@meyer.de', 'jan@example.org']);
    expect(hits.find((h) => h.address === 'bestellung@meyer.de')).toMatchObject({ name: 'Getränke Meyer', source: 'contact' });
    expect((await req<MailAddressSuggestion[]>('GET', '/api/mail/suggest?q=')).body).toEqual([]);
    expect((await req<MailAddressSuggestion[]>('GET', '/api/mail/suggest?q=%25')).body).toEqual([]);
  });
});
