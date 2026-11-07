import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogoConfig, LogoLink, LogoRule } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { LogoAdapter } from '../devices/drivers/logo.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-logo-'));
  // Simulierte LOGO: Taster-Impuls auf NIn schaltet Qn um
  app = await buildApp(parseConfig({ dataDir, devices: { logo: { enabled: true, driver: 'sim' } } }), { logger: false });
  admin = await adminCookie(app);
  await app.devices.start();
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const adapter = () => app.devices.adapter('logo') as LogoAdapter;
const logoAlerts = () => app.devices.getAlerts().filter((a) => a.id.startsWith('logo:'));

describe('LOGO', () => {
  it('liest alle Signale und hält Bezeichnungen, Regeln und Verknüpfungen im Zustand', async () => {
    await adapter().poll();
    const s = adapter().getState();
    expect(s.connected).toBe(true);
    expect(Object.keys(s.values)).toHaveLength(24 + 20 + 64 + 64 + 8 + 8 + 64 + 32 + 16 + 64);
    expect(s.values.Q7).toBe(0);

    expect((await req('PUT', '/api/logo/labels/Q7', { label: 'Umfeldbeleuchtung' })).status).toBe(200);
    expect((await req('PUT', '/api/logo/labels/Q99', { label: 'x' })).status).toBe(404);
    expect(adapter().getState().labels).toEqual({ Q7: 'Umfeldbeleuchtung' });
    await req('PUT', '/api/logo/labels/Q7', { label: '' });
    expect(adapter().getState().labels).toEqual({});
  });

  it('ist nur für angemeldete Nutzer änderbar und prüft die Eingaben', async () => {
    expect((await req('GET', '/api/logo', undefined, '')).status).toBe(401);
    expect((await req('PUT', '/api/logo/labels/Q7', { label: 'x' }, '')).status).toBe(401);
    expect((await req('POST', '/api/logo/rules', { signal: 'NI1', title: '' })).status).toBe(400);
    expect((await req('POST', '/api/logo/links', { name: 'x', button: 'Q1', output: 'Q2' })).status).toBe(400);
  });

  it('meldet „Lichtmast ausgefahren“, solange NI1 = 1', async () => {
    const rule = (await req<LogoRule>('POST', '/api/logo/rules', { signal: 'NI1', op: '=', value: 1, severity: 'warn', title: 'Lichtmast ausgefahren' })).body;
    await adapter().poll();
    expect(logoAlerts()).toEqual([]);

    // Schalter der LOGO setzt NI1 (im Fahrzeug von außen; hier direkt im Simulator)
    const sim = (adapter() as unknown as { client: { setSignal(id: string, v: number): void } }).client;
    sim.setSignal('NI1', 1);
    await adapter().poll();
    expect(logoAlerts()).toEqual([expect.objectContaining({ id: `logo:rule:${rule.id}`, severity: 'warn', title: 'Lichtmast ausgefahren' })]);

    sim.setSignal('NI1', 0);
    await adapter().poll();
    expect(logoAlerts()).toEqual([]);

    await req('PUT', `/api/logo/rules/${rule.id}`, { signal: 'NI1', title: 'Lichtmast ausgefahren', enabled: false });
    sim.setSignal('NI1', 1);
    await adapter().poll();
    expect(logoAlerts()).toEqual([]);
    expect((await req('DELETE', `/api/logo/rules/${rule.id}`)).status).toBe(204);
    expect((await req<LogoConfig>('GET', '/api/logo')).body.rules).toEqual([]);
  });

  it('schaltet über die Verknüpfung: Taster NI4 → Ausgang Q4 zeigt den Zustand', async () => {
    const link = (await req<LogoLink>('POST', '/api/logo/links', { name: 'Umfeldbeleuchtung', button: 'NI4', output: 'Q4' })).body;
    // ein Taster gehört zu genau einem Ausgang
    expect((await req('POST', '/api/logo/links', { name: 'doppelt', button: 'NI4', output: 'Q5' })).status).toBe(409);
    await adapter().poll();
    expect(adapter().getState().values).toMatchObject({ NI4: 0, Q4: 0 });

    const pulse = await req('POST', '/api/devices/logo/commands', { action: 'pulse', params: { signal: 'NI4' } });
    expect(pulse.status).toBe(200);
    await adapter().poll();
    // Impuls ist vorbei (NI4 wieder 0), der Ausgang ist an
    expect(adapter().getState().values).toMatchObject({ NI4: 0, Q4: 1 });
    await req('POST', '/api/devices/logo/commands', { action: 'pulse', params: { signal: 'NI4' } });
    await adapter().poll();
    expect(adapter().getState().values.Q4).toBe(0);

    // nur verknüpfte Taster, und nur NI
    expect((await req('POST', '/api/devices/logo/commands', { action: 'pulse', params: { signal: 'NI5' } })).status).toBe(400);
    expect((await req('POST', '/api/devices/logo/commands', { action: 'pulse', params: { signal: 'Q4' } })).status).toBe(400);
    expect((await req('DELETE', `/api/logo/links/${link.id}`)).status).toBe(204);
    expect((await req('POST', '/api/devices/logo/commands', { action: 'pulse', params: { signal: 'NI4' } })).status).toBe(400);
  });

  it('gilt nach zwei Fehlversuchen als ausgefallen und verwirft veraltete Werte', async () => {
    const sim = (adapter() as unknown as { client: { failing: boolean } | null }).client;
    await adapter().poll();
    expect(adapter().isOnline()).toBe(true);
    const client = (adapter() as unknown as { client: { failing: boolean } }).client ?? sim!;
    client.failing = true;
    await adapter().poll();
    expect(adapter().isOnline()).toBe(true);
    await adapter().poll();
    expect(adapter().isOnline()).toBe(false);
    expect(adapter().getState()).toMatchObject({ connected: false, values: {} });
    expect(app.devices.getAlerts().some((a) => a.id === 'offline:logo')).toBe(true);
  });
});
