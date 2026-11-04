import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LITE_DASHBOARD, LITE_DEVICE_IDS, type DashboardResponse, type DeviceModule } from '@elvis/shared';
import { buildApp, type App } from './app.js';
import { loadConfig, parseConfig } from './config.js';
import { openDb } from './db/index.js';
import { DeviceConfigStore } from './devices/config-store.js';
import { adminCookie } from './test-helpers.js';

describe('Ausbaustufe lite – Konfiguration', () => {
  it('ist ohne Angabe die Vollversion', () => {
    const config = parseConfig({});
    expect(config.edition).toBe('full');
    expect(config.docker.enabled).toBe(true);
    expect(config.scan.smtpPort).toBe(2525);
    expect(config.vehicle.name).toBe('ELW 2');
  });

  it('schaltet Docker immer ab und ändert nur Vorgaben, keine ausdrücklichen Angaben', () => {
    expect(parseConfig({ edition: 'lite' })).toMatchObject({ docker: { enabled: false }, scan: { smtpPort: null }, vehicle: { name: 'ELW 1' } });
    expect(parseConfig({ edition: 'lite', docker: { enabled: true }, scan: { smtpPort: 2526 }, vehicle: { name: 'ELW 1 Nord' } })).toMatchObject({
      docker: { enabled: false },
      scan: { smtpPort: 2526 },
      vehicle: { name: 'ELW 1 Nord' },
    });
  });

  it('übernimmt ELVIS_EDITION aus der Umgebung', () => {
    expect(loadConfig({ ELVIS_CONFIG: '/gibt/es/nicht.json', ELVIS_EDITION: 'lite' }).edition).toBe('lite');
    expect(() => loadConfig({ ELVIS_CONFIG: '/gibt/es/nicht.json', ELVIS_EDITION: 'gross' })).toThrow();
  });

  it('lässt Module ohne Einrichtung aus und nur die Messenger zu', () => {
    const config = parseConfig({ edition: 'lite', devices: { radio: { enabled: true, driver: 'sim' } } });
    const store = new DeviceConfigStore(openDb(':memory:'), config.devices, config.edition);
    expect(store.get('radio').config.enabled).toBe(false);
    expect(store.get('telegram').config.enabled).toBe(false);
    expect(() => store.set('radio', { enabled: true, driver: 'sim', options: {} }, 'x')).toThrow(/Ausbaustufe/);
    store.set('telegram', { enabled: true, driver: 'sim', options: {} }, 'x');
    expect(store.get('telegram').config.enabled).toBe(true);
  });
});

describe('Ausbaustufe lite – API', () => {
  let app: App;
  let dataDir: string;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'elvis-lite-'));
    app = await buildApp(parseConfig({ dataDir, edition: 'lite' }), { logger: false });
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('meldet die Ausbaustufe, bietet nur erlaubte Module an und startet keine Geräte', async () => {
    const info = (await app.server.inject({ method: 'GET', url: '/api/info' })).json() as { edition: string; docker: { enabled: boolean }; drivers: Record<string, string> };
    expect(info).toMatchObject({ edition: 'lite', docker: { enabled: false }, drivers: {} });
    const cookie = await adminCookie(app);
    const modules = (await app.server.inject({ method: 'GET', url: '/api/system/devices', headers: { cookie } })).json() as DeviceModule[];
    expect(modules.map((m) => m.id).sort()).toEqual([...LITE_DEVICE_IDS].sort());
    const radio = await app.server.inject({ method: 'PUT', url: '/api/system/devices/radio', headers: { cookie }, payload: { enabled: true, driver: 'sim', options: {} } });
    expect(radio.statusCode).toBe(404);
    expect((await app.server.inject({ method: 'GET', url: '/api/addons', headers: { cookie } })).statusCode).toBe(404);
  });

  it('liefert die Übersicht ohne Fahrzeugtechnik', async () => {
    const cookie = await adminCookie(app);
    const res = (await app.server.inject({ method: 'GET', url: '/api/me/dashboard', headers: { cookie } })).json() as DashboardResponse;
    expect(res.layout).toEqual(LITE_DASHBOARD);
  });
});
