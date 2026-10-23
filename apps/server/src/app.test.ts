import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Incident, JournalEntry, Unit } from '@elvis/shared';
import { buildApp, type App } from './app.js';
import { parseConfig } from './config.js';
import { openDb } from './db/index.js';
import { adminCookie } from './test-helpers.js';

let app: App;
let dataDir: string;

let cookie = '';

async function req<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-test-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  await app.devices.start();
  cookie = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Einsatzbezogene Bereiche', () => {
  it('lehnt Schreibzugriffe ohne offenen Einsatz ab', async () => {
    const started = await req<Incident>('POST', '/api/incidents', { title: 'Brand Lagerhalle', keyword: 'B3' });
    expect(started.status).toBe(201);
    expect((await req('POST', '/api/incidents', { title: 'Zweiter' })).status).toBe(409);

    await req('POST', `/api/incidents/${started.body.id}/close`);
    const late = await req('POST', `/api/incidents/${started.body.id}/journal`, { category: 'lage', text: 'zu spät' });
    expect(late.status).toBe(409);
    // Archiv bleibt lesbar
    expect((await req('GET', `/api/incidents/${started.body.id}/journal`)).status).toBe(200);
  });

  it('protokolliert Kräfte-Statuswechsel automatisch im Einsatztagebuch', async () => {
    const { body: incident } = await req<Incident>('POST', '/api/incidents', { title: 'VU' });
    const { body: unit } = await req<Unit>('POST', `/api/incidents/${incident.id}/units`, {
      callsign: 'Florian Musterstadt 1/44-1',
      unitType: 'HLF 20',
      strength: { leaders: 0, subLeaders: 1, crew: 8 },
    });
    await req('PATCH', `/api/units/${unit.id}`, { fmsStatus: 4, section: 'EA Nord' });

    const { body: journal } = await req<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`);
    const texts = journal.map((e) => e.text);
    expect(texts).toContain('Einheit eingetroffen: Florian Musterstadt 1/44-1 (HLF 20, Stärke 0/1/8/9)');
    expect(texts.at(-1)).toBe('Florian Musterstadt 1/44-1: Status 4 (Am Einsatzort), Abschnitt → EA Nord');
    expect(journal.every((e) => e.author === 'Max Müller')).toBe(true);
  });

  it('erlaubt keine manuellen Systemeinträge', async () => {
    const { body: incident } = await req<Incident>('POST', '/api/incidents', { title: 'Test' });
    const res = await req('POST', `/api/incidents/${incident.id}/journal`, { category: 'system', text: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('Einsatztagebuch', () => {
  it('ist auf Datenbankebene unveränderlich', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO incidents (title, started_at) VALUES ('t', 'now')").run();
    db.prepare(
      "INSERT INTO journal (incident_id, timestamp, recorded_at, category, text, author) VALUES (1, 'a', 'a', 'lage', 'x', 'y')",
    ).run();
    expect(() => db.prepare("UPDATE journal SET text = 'manipuliert'").run()).toThrow(/unveränderlich/);
    expect(() => db.prepare('DELETE FROM journal').run()).toThrow(/unveränderlich/);
    db.close();
  });
});

describe('Gerätebefehle', () => {
  it('führt Befehle aus, lehnt unzulässige ab und protokolliert beides', async () => {
    const ok = await req<{ message: string }>('POST', '/api/devices/radio/commands', { action: 'talkgroup.set', params: { deviceId: 'frt-1', talkgroupId: 'tg-el' } });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe('Funkplatz 1 auf EL_MST_1 geschaltet');
    const refused = await req<{ error: string }>('POST', '/api/devices/radio/commands', { action: 'talkgroup.set', params: { deviceId: 'hrt-1', talkgroupId: 'tg-el' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Handfunkgeräte/);

    const { body: audit } = await req<{ action: string; success: boolean }[]>('GET', '/api/audit');
    expect(audit.filter((a) => a.action === 'talkgroup.set').map((a) => a.success)).toEqual([false, true]);
  });

  it('weist unbekannte Aktionen und ungültige Parameter ab', async () => {
    expect((await req('POST', '/api/devices/radio/commands', { action: 'self.destruct' })).status).toBe(400);
    expect((await req('POST', '/api/devices/radio/commands', { action: 'status.set', params: { deviceId: 'mrt-1', status: 99 } })).status).toBe(400);
    expect((await req('POST', '/api/devices/lighting/commands', { action: 'mast.extend' })).status).toBe(404);
  });
});
