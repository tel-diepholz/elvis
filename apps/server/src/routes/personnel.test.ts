import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { EncryptedSheet, Incident, JournalEntry, Person, PersonnelForm, PersonnelInbox, PersonnelSheet, PersonnelSheetInput, RelayFormRequest, RelaySubmission, Unit } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { RelayFetch } from '../services/relay.js';
import { adminCookie } from '../test-helpers.js';

const RELAY = 'https://relay.test';
const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64');

/** So verschlüsselt das Online-Formular im Browser */
async function encrypt(form: RelayFormRequest, formId: string, sheet: PersonnelSheetInput): Promise<EncryptedSheet> {
  const subtle = webcrypto.subtle;
  const pub = await subtle.importKey('jwk', form.publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(formId) }, aes, new TextEncoder().encode(JSON.stringify(sheet)));
  const key = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, await subtle.exportKey('raw', aes));
  return { alg: 'RSA-OAEP-256+A256GCM', key: b64(key), iv: b64(iv), data: b64(data) };
}

/** Relay im Speicher: Formulare und eingereichte Bögen mit fortlaufender seq */
class FakeRelay {
  forms = new Map<string, RelayFormRequest>();
  deleted: string[] = [];
  submissions: RelaySubmission[] = [];

  fetch: RelayFetch = async (url, { method, token, body }) => {
    const path = url.slice(RELAY.length);
    if (method === 'POST' && path === '/v1/elws') return { status: 201, body: { elwId: 'E1', token: 'elw-token' } };
    if (token !== 'elw-token') return { status: 401, body: { error: 'unbekannt' } };
    if (method === 'POST' && path === '/v1/elws/me/forms') {
      const formId = `F${this.forms.size + 1}`;
      this.forms.set(formId, body as RelayFormRequest);
      return { status: 201, body: { formId, url: `${RELAY}/p/${formId}` } };
    }
    const del = /^\/v1\/elws\/me\/forms\/(\w+)$/.exec(path);
    if (method === 'DELETE' && del) {
      this.deleted.push(del[1]!);
      return { status: 204, body: null };
    }
    const sub = /^\/v1\/elws\/me\/submissions\?after=(\d+)$/.exec(path);
    if (method === 'GET' && sub) {
      const items = this.submissions.filter((s) => s.seq > Number(sub[1]));
      return { status: 200, body: { items, next: items.at(-1)?.seq ?? Number(sub[1]) } };
    }
    return { status: 404, body: { error: 'Nicht gefunden' } };
  };

  async submit(formId: string, sheet: PersonnelSheetInput, tamper = false) {
    const payload = await encrypt(this.forms.get(formId)!, tamper ? 'anderes-formular' : formId, sheet);
    this.submissions.push({ seq: this.submissions.length + 1, formId, submittedAt: '2026-10-25T12:00:00.000Z', payload });
  }
}

let app: App;
let dataDir: string;
let admin = '';
let relay: FakeRelay;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie: admin } });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-personnel-'));
  relay = new FakeRelay();
  app = await buildApp(parseConfig({ dataDir, app: { relayUrl: RELAY } }), { logger: false, relayFetch: relay.fetch });
  admin = await adminCookie(app);
  const incident = (await req<Incident>('POST', '/api/incidents', { keyword: 'B3', title: 'Wohnungsbrand' })).body;
  const unit = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'HLF 20/1' })).body;
  return { incident, unit };
}

const journal = async (incidentId: number) => (await req<JournalEntry[]>('GET', `/api/incidents/${incidentId}/journal`)).body.map((e) => e.text);

const crew: PersonnelSheetInput = {
  unitLabel: 'LF 10 Barnstorf',
  persons: [
    { lastName: 'Meyer', firstName: 'Anna', grade: 'subLeader', function: 'Gruppenführerin', qualifications: ['Atemschutz'], phone: '0170 1234567' },
    { lastName: 'Schulz', firstName: 'Ben', function: 'Maschinist' },
  ],
};

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Personal', () => {
  it('erfasst, ändert und entfernt Personal einer Einheit', async () => {
    const { incident, unit } = await setup();
    const added = await req<Person[]>('POST', `/api/units/${unit.id}/personnel`, { persons: crew.persons });
    expect(added.status).toBe(201);
    expect(added.body.map((p) => p.lastName)).toEqual(['Meyer', 'Schulz']);
    expect(added.body[1]).toMatchObject({ grade: 'crew', qualifications: [], sheetId: null, createdBy: 'Max Müller' });

    const meyer = added.body[0]!;
    const changed = await req<Person>('PUT', `/api/personnel/${meyer.id}`, { ...crew.persons[0], qualifications: ['Atemschutz', 'Sprechfunk'] });
    expect(changed.body.qualifications).toEqual(['Atemschutz', 'Sprechfunk']);
    expect((await req('PUT', `/api/personnel/${meyer.id}`, { firstName: 'Anna' })).status).toBe(400);

    expect((await req('DELETE', `/api/personnel/${meyer.id}`)).status).toBe(204);
    expect((await req<Person[]>('GET', `/api/incidents/${incident.id}/personnel`)).body.map((p) => p.lastName)).toEqual(['Schulz']);
    expect(await journal(incident.id)).toEqual(expect.arrayContaining(['HLF 20/1: Personal erfasst (2 Personen)', 'HLF 20/1: Personal: 1 Person entfernt']));
    expect((await req<Unit>('GET', `/api/units/${unit.id}`)).body.name).toBe('HLF 20/1');

    await req('POST', `/api/incidents/${incident.id}/close`);
    expect((await req('POST', `/api/units/${unit.id}/personnel`, { persons: crew.persons })).status).toBe(409);
  });

  it('übergibt Personal an eine andere Einheit', async () => {
    const { incident, unit } = await setup();
    const lf = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'LF 10' })).body;
    const [meyer, schulz] = (await req<Person[]>('POST', `/api/units/${unit.id}/personnel`, { persons: crew.persons })).body;
    const moved = await req<Person[]>('POST', `/api/units/${unit.id}/personnel/transfer`, { personIds: [meyer!.id], unitId: lf.id });
    expect(moved.body.map((p) => p.lastName)).toEqual(['Meyer']);
    expect((await req<Person[]>('GET', `/api/units/${unit.id}/personnel`)).body.map((p) => p.lastName)).toEqual(['Schulz']);
    expect(await journal(incident.id)).toEqual(expect.arrayContaining(['HLF 20/1: Personal an LF 10 übergeben (1 Person)', 'LF 10: Personal von HLF 20/1 übernommen (1 Person)']));

    // Nur eigenes Personal, nicht an sich selbst
    expect((await req('POST', `/api/units/${unit.id}/personnel/transfer`, { personIds: [meyer!.id], unitId: lf.id })).status).toBe(400);
    expect((await req('POST', `/api/units/${unit.id}/personnel/transfer`, { personIds: [schulz!.id], unitId: unit.id })).status).toBe(400);
  });
});

describe('Online-Formular', () => {
  it('holt verschlüsselte Personalbögen ab, meldet sie als neu und ordnet sie zu', async () => {
    const { incident, unit } = await setup();
    const form = await req<PersonnelForm>('POST', '/api/personnel-form', { validHours: 12 });
    expect(form.status).toBe(201);
    expect(form.body).toMatchObject({ id: 'F1', url: `${RELAY}/p/F1`, incidentId: incident.id });
    expect(relay.forms.get('F1')!.title).toContain('B3 Wohnungsbrand');

    await relay.submit('F1', crew);
    await app.personnel.poll();
    expect((await req<{ count: number }>('GET', '/api/personnel-sheets/unread')).body.count).toBe(1);
    const inbox = (await req<PersonnelInbox>('GET', '/api/personnel-sheets')).body;
    expect(inbox.form?.id).toBe('F1');
    expect(inbox.sheets[0]).toMatchObject({ unitLabel: 'LF 10 Barnstorf', readAt: null, unitId: null });
    expect(inbox.sheets[0]!.persons[0]).toMatchObject({ lastName: 'Meyer', grade: 'subLeader', phone: '0170 1234567' });

    await req('POST', '/api/personnel-sheets/read');
    expect((await req<{ count: number }>('GET', '/api/personnel-sheets/unread')).body.count).toBe(0);

    // Zuordnen, dann an eine neue Einheit weitergeben: das Personal zieht mit
    const sheetId = inbox.sheets[0]!.id;
    const assigned = await req<PersonnelSheet>('POST', `/api/personnel-sheets/${sheetId}/assign`, { unitId: unit.id });
    expect(assigned.body).toMatchObject({ unitId: unit.id, unitName: 'HLF 20/1' });
    expect((await req<Person[]>('GET', `/api/units/${unit.id}/personnel`)).body).toHaveLength(2);
    // Zugeordnet: nicht mehr im Eingang, sondern beim Personal der Einheit
    expect((await req<PersonnelInbox>('GET', '/api/personnel-sheets')).body.sheets).toHaveLength(0);

    const moved = await req<PersonnelSheet>('POST', `/api/personnel-sheets/${sheetId}/assign`, { newUnit: { name: 'LF 10 Barnstorf' } });
    const lf = (await req<Unit[]>('GET', `/api/incidents/${incident.id}/units`)).body.find((u) => u.name === 'LF 10 Barnstorf')!;
    expect(moved.body.unitId).toBe(lf.id);
    expect(lf.strength).toEqual({ leaders: 0, subLeaders: 1, crew: 1 });
    expect((await req<Person[]>('GET', `/api/units/${unit.id}/personnel`)).body).toHaveLength(0);
    expect((await req<Person[]>('GET', `/api/units/${lf.id}/personnel`)).body.every((p) => p.sheetId === sheetId)).toBe(true);
    expect(await journal(incident.id)).toEqual(
      expect.arrayContaining(['HLF 20/1: Personalbogen „LF 10 Barnstorf“ zugeordnet (2 Personen)', 'HLF 20/1: Personalbogen „LF 10 Barnstorf“ an LF 10 Barnstorf abgegeben']),
    );

    // Löschen im Eingang lässt das Personal bei der Einheit
    expect((await req('DELETE', `/api/personnel-sheets/${sheetId}`)).status).toBe(204);
    expect((await req<Person[]>('GET', `/api/units/${lf.id}/personnel`)).body).toHaveLength(2);
  });

  it('verwirft manipulierte Bögen und beendet den Link mit dem Einsatz', async () => {
    const { incident } = await setup();
    await req('POST', '/api/personnel-form', {});
    await relay.submit('F1', crew, true);
    await app.personnel.poll();
    const inbox = (await req<PersonnelInbox>('GET', '/api/personnel-sheets')).body;
    expect(inbox.sheets).toHaveLength(0);
    expect(inbox.lastError).toContain('ließ sich nicht lesen');

    // Neuer Link ersetzt den alten
    await req('POST', '/api/personnel-form', {});
    await app.personnel.poll();
    expect(relay.deleted).toEqual(['F1']);

    // Vor dem Beenden eingereicht: wird noch abgeholt, danach ist der Link beim Relay gelöscht
    await relay.submit('F2', crew);
    await req('POST', `/api/incidents/${incident.id}/close`);
    await app.personnel.poll();
    expect(relay.deleted).toEqual(['F1', 'F2']);
    const after = (await req<PersonnelInbox>('GET', '/api/personnel-sheets')).body;
    expect(after.form).toBeNull();
    expect(after.sheets).toHaveLength(1);
    expect((await req('POST', `/api/personnel-sheets/${after.sheets[0]!.id}/assign`, { unitId: 1 })).status).toBe(409);
  });

  it('verlangt einen laufenden Einsatz', async () => {
    const { incident } = await setup();
    await req('POST', `/api/incidents/${incident.id}/close`);
    expect((await req('POST', '/api/personnel-form', {})).status).toBe(409);
    expect((await req('DELETE', '/api/personnel-form')).status).toBe(404);
  });
});
