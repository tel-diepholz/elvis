import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppLink, AppRelayStatus, Incident, JournalEntry, RelayPositionItem, Unit } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { RelayFetch } from '../services/applinks.js';
import { adminCookie } from '../test-helpers.js';

const RELAY = 'https://relay.test';

/** Relay im Speicher: ein Gerät „K7M2QX9P“ mit Code 123456, Positionen mit fortlaufender seq */
class FakeRelay {
  online = true;
  elws = 0;
  pairings = new Map<string, { label: string }>();
  deleted: string[] = [];
  positions: RelayPositionItem[] = [];
  code = '123456';

  fetch: RelayFetch = async (url, { method, token, body }) => {
    if (!this.online) throw new Error('fetch failed');
    const path = url.slice(RELAY.length);
    if (method === 'POST' && path === '/v1/elws') return { status: 201, body: { elwId: `E${++this.elws}`, token: 'elw-token' } };
    if (token !== 'elw-token') return { status: 401, body: { error: 'unbekannt' } };
    if (method === 'POST' && path === '/v1/elws/me/pairings') {
      const b = body as { deviceId: string; code: string; label: string };
      if (b.deviceId !== 'K7M2QX9P') return { status: 404, body: { error: 'Gerät unbekannt' } };
      if (b.code !== this.code) return { status: 403, body: { error: 'Code falsch' } };
      this.pairings.set(b.deviceId, { label: b.label });
      return { status: 201, body: { ok: true } };
    }
    const del = /^\/v1\/elws\/me\/pairings\/(\w+)$/.exec(path);
    if (method === 'DELETE' && del) {
      this.deleted.push(del[1]!);
      this.pairings.delete(del[1]!);
      return { status: 204, body: null };
    }
    const pos = /^\/v1\/elws\/me\/positions\?after=(\d+)$/.exec(path);
    if (method === 'GET' && pos) {
      const items = this.positions.filter((p) => p.seq > Number(pos[1]));
      return { status: 200, body: { items, next: items.at(-1)?.seq ?? Number(pos[1]) } };
    }
    return { status: 404, body: { error: 'Nicht gefunden' } };
  };

  send(lat: number, lon: number, ts: string, accuracyM = 8) {
    this.positions.push({ seq: this.positions.length + 1, deviceId: 'K7M2QX9P', lat, lon, accuracyM, ts, battery: 0.8 });
  }
}

let app: App;
let dataDir: string;
let admin = '';
let relay: FakeRelay;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function req<T = unknown>(method: Method, url: string, payload?: unknown) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: { cookie: admin } });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

async function setup(relayUrl: string | null = RELAY) {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-applinks-'));
  relay = new FakeRelay();
  app = await buildApp(parseConfig({ dataDir, app: { relayUrl } }), { logger: false, relayFetch: relay.fetch });
  admin = await adminCookie(app);
  const incident = (await req<Incident>('POST', '/api/incidents', { keyword: 'B3', title: 'Wohnungsbrand' })).body;
  const unit = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'HLF 20/1' })).body;
  return { incident, unit };
}

const unitOf = async (incidentId: number, id: number) => (await req<Unit[]>('GET', `/api/incidents/${incidentId}/units`)).body.find((u) => u.id === id)!;
const journal = async (incidentId: number) => (await req<JournalEntry[]>('GET', `/api/incidents/${incidentId}/journal`)).body.map((e) => e.text);

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('App-Anbindung', () => {
  describe('mit Relay', () => {
    let incident: Incident;
    let unit: Unit;
    beforeEach(async () => {
      ({ incident, unit } = await setup());
    });

    it('koppelt eine App mit ID und Code und übernimmt ihre Positionen ohne Tagebuchflut', async () => {
      const paired = await req<AppLink>('POST', `/api/units/${unit.id}/app-link`, { deviceId: 'k7m2-qx9p', code: '123 456' });
      expect(paired.status).toBe(201);
      expect(paired.body).toMatchObject({ unitId: unit.id, deviceId: 'K7M2QX9P' });
      expect(relay.pairings.get('K7M2QX9P')?.label).toBe('HLF 20/1 · B3 Wohnungsbrand');
      expect((await req<AppLink[]>('GET', `/api/incidents/${incident.id}/app-links`)).body).toHaveLength(1);

      relay.send(52.6, 8.37, '2026-10-25T10:00:00.000Z');
      relay.send(52.601, 8.371, '2026-10-25T10:01:00.000Z');
      await app.appLinks.poll();
      let u = await unitOf(incident.id, unit.id);
      expect(u).toMatchObject({ lat: 52.601, lon: 8.371, positionSource: 'app', positionAt: '2026-10-25T10:01:00.000Z', positionAccuracyM: 8 });

      relay.send(52.602, 8.372, '2026-10-25T10:02:00.000Z');
      await app.appLinks.poll();
      u = await unitOf(incident.id, unit.id);
      expect(u.lat).toBe(52.602);
      const link = (await req<AppLink[]>('GET', `/api/incidents/${incident.id}/app-links`)).body[0]!;
      expect(link).toMatchObject({ lastPositionAt: '2026-10-25T10:02:00.000Z', battery: 0.8 });

      const texts = await journal(incident.id);
      expect(texts.filter((t) => t.startsWith('HLF 20/1: Position per App'))).toHaveLength(1);
      expect(texts).toContain('HLF 20/1: App K7M2-QX9P gekoppelt');

      // Von Hand verschoben: Quelle wechselt, die nächste App-Meldung übernimmt wieder
      await req('PATCH', `/api/units/${unit.id}`, { lat: 52.5, lon: 8.3 });
      expect((await unitOf(incident.id, unit.id)).positionSource).toBe('manual');
    });

    it('meldet falsche Codes und unbekannte Apps verständlich', async () => {
      const wrong = await req<{ error: string }>('POST', `/api/units/${unit.id}/app-link`, { deviceId: 'K7M2QX9P', code: '000000' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toMatch(/Code falsch/);
      const unknown = await req<{ error: string }>('POST', `/api/units/${unit.id}/app-link`, { deviceId: 'AAAAAAAA', code: '123456' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toMatch(/nicht gefunden/);
      expect((await req('POST', `/api/units/${unit.id}/app-link`, { deviceId: 'zu-kurz', code: '123456' })).status).toBe(400);
    });

    it('entkoppelt beim Entlassen der Einheit und mit dem Einsatzende', async () => {
      await req('POST', `/api/units/${unit.id}/app-link`, { deviceId: 'K7M2QX9P', code: '123456' });
      await req('PATCH', `/api/units/${unit.id}`, { status: 'entlassen' });
      relay.send(52.6, 8.37, '2026-10-25T10:00:00.000Z');
      await app.appLinks.poll();
      expect(relay.deleted).toEqual(['K7M2QX9P']);
      expect((await unitOf(incident.id, unit.id)).lat).toBeNull();
      expect((await req<AppLink[]>('GET', `/api/incidents/${incident.id}/app-links`)).body).toEqual([]);

      const other = (await req<Unit>('POST', `/api/incidents/${incident.id}/units`, { name: 'LF 10' })).body;
      await req('POST', `/api/units/${other.id}/app-link`, { deviceId: 'K7M2QX9P', code: '123456' });
      await req('POST', `/api/incidents/${incident.id}/close`);
      await app.appLinks.poll();
      expect(relay.deleted).toEqual(['K7M2QX9P', 'K7M2QX9P']);
      expect((await req('POST', `/api/units/${other.id}/app-link`, { deviceId: 'K7M2QX9P', code: '123456' })).status).toBe(409);
    });

    it('holt das Entkoppeln nach, wenn das Relay nicht erreichbar war', async () => {
      await req('POST', `/api/units/${unit.id}/app-link`, { deviceId: 'K7M2QX9P', code: '123456' });
      relay.online = false;
      expect((await req('DELETE', `/api/units/${unit.id}/app-link`)).status).toBe(204);
      expect(relay.pairings.has('K7M2QX9P')).toBe(true);
      expect((await journal(incident.id))).toContain('HLF 20/1: App K7M2-QX9P entkoppelt');
      relay.online = true;
      await app.appLinks.poll();
      expect(relay.pairings.has('K7M2QX9P')).toBe(false);
      expect((await req('DELETE', `/api/units/${unit.id}/app-link`)).status).toBe(404);
    });

    it('zeigt Admins den Zustand des Relays', async () => {
      await req('POST', `/api/units/${unit.id}/app-link`, { deviceId: 'K7M2QX9P', code: '123456' });
      await app.appLinks.poll();
      const s = (await req<AppRelayStatus>('GET', '/api/system/app-relay')).body;
      expect(s).toMatchObject({ enabled: true, relayUrl: RELAY, registered: true, activeLinks: 1, lastError: null });
      expect(s.lastPollAt).not.toBeNull();
      relay.online = false;
      await app.appLinks.poll();
      expect((await req<AppRelayStatus>('GET', '/api/system/app-relay')).body.lastError).toMatch(/nicht erreichbar/);
    });
  });

  it('ist ohne Relay-Adresse abgeschaltet', async () => {
    const { unit } = await setup(null);
    expect((await req('GET', '/api/app-relay')).body).toEqual({ enabled: false });
    expect((await req('POST', `/api/units/${unit.id}/app-link`, { deviceId: 'K7M2QX9P', code: '123456' })).status).toBe(503);
  });
});
