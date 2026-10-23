import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceModule, SerialPortInfo } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { adminCookie } from '../test-helpers.js';
import { DeviceConfigStore } from './config-store.js';
import { DeviceManager } from './manager.js';
import { listSerialPorts } from './serialports.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };

describe('Modulkonfiguration', () => {
  it('nimmt Vorgaben aus der Konfigurationsdatei und gleicht Typen an', () => {
    const config = parseConfig({ dataDir: ':memory:', devices: { weather: { driver: 'actisense-airmar', options: { port: '/dev/ttyUSB0', baudRate: 115200 } } } });
    const store = new DeviceConfigStore(openDb(':memory:'), config.devices);
    expect(store.get('weather')).toEqual({
      source: 'config',
      config: { enabled: true, driver: 'actisense-airmar', options: { port: '/dev/ttyUSB0', baudRate: '115200', sourceAddress: '', setRxAll: true } },
    });
    expect(store.get('radio').config).toEqual({ enabled: true, driver: 'sim', options: {} });
  });

  it('prüft Treiber und Einstellungen beim Speichern', () => {
    const store = new DeviceConfigStore(openDb(':memory:'), {});
    expect(() => store.set('weather', { enabled: true, driver: 'gibtsnicht', options: {} }, 'x')).toThrow(/Unbekannter Treiber/);
    expect(() => store.set('weather', { enabled: true, driver: 'actisense-airmar', options: { port: '' } }, 'x')).toThrow(/port/);
    expect(() => store.set('weather', { enabled: true, driver: 'actisense-airmar', options: { port: '/dev/x', sourceAddress: 'abc' } }, 'x')).toThrow(/sourceAddress/);
    store.set('weather', { enabled: false, driver: 'actisense-airmar', options: { port: '/dev/x', sourceAddress: '35', fremd: 1 } }, 'x');
    expect(store.get('weather')).toMatchObject({ source: 'settings', config: { enabled: false, options: { port: '/dev/x', sourceAddress: '35' } } });
    expect(store.get('weather').config.options).not.toHaveProperty('fremd');
  });

  it('aktiviert, deaktiviert und wechselt Treiber zur Laufzeit', async () => {
    const db = openDb(':memory:');
    const config = parseConfig({ dataDir: ':memory:' });
    const m = new DeviceManager(config, log, new DeviceConfigStore(db, config.devices));
    const removed: string[] = [];
    const updated: string[] = [];
    m.onRemoved((id) => removed.push(id));
    m.onDevice((d) => updated.push(d.id));
    await m.start();
    expect(m.snapshots().map((d) => d.id)).toContain('weather');

    await m.configure('weather', { enabled: false, driver: 'sim', options: {} }, 'Test');
    expect(removed).toEqual(['weather']);
    expect(m.has('weather')).toBe(false);
    expect(m.module('weather')).toMatchObject({ online: null, config: { enabled: false } });
    expect(m.getAlerts().some((a) => a.id === 'offline:weather')).toBe(false);

    // Airmar ohne Gerät: läuft, ist aber offline und meldet das
    await m.configure('weather', { enabled: true, driver: 'actisense-airmar', options: { port: '/dev/gibt-es-nicht' } }, 'Test');
    expect(m.snapshot('weather').driver).toBe('actisense-airmar');
    expect(m.snapshot('weather').online).toBe(false);
    expect(updated).toContain('weather');
    expect(m.getAlerts().some((a) => a.id === 'offline:weather')).toBe(true);

    // Neuer Manager liest die gespeicherte Konfiguration
    const again = new DeviceManager(config, log, new DeviceConfigStore(db, config.devices));
    expect(again.module('weather')).toMatchObject({ source: 'settings', config: { driver: 'actisense-airmar' } });
    await m.stop();
  });
});

describe('Serielle Schnittstellen', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'elvis-serial-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('bevorzugt stabile Namen aus /dev/serial/by-id und sortiert USB nach vorn', async () => {
    const dev = join(dir, 'ttyUSB0');
    writeFileSync(dev, '');
    symlinkSync(dev, join(dir, 'usb-Actisense_NGX-1_ABC123-if00-port0'));
    const ports = await listSerialPorts(
      async () => [{ path: '/dev/ttyS0' }, { path: dev, manufacturer: 'Actisense', vendorId: '0403', productId: 'd9aa', serialNumber: 'ABC123' }],
      dir,
    );
    expect(ports).toEqual<SerialPortInfo[]>([
      { path: join(dir, 'usb-Actisense_NGX-1_ABC123-if00-port0'), device: dev, label: 'ttyUSB0 – Actisense, 0403:d9aa, S/N ABC123' },
      { path: '/dev/ttyS0', device: '/dev/ttyS0', label: 'ttyS0' },
    ]);
  });
});

describe('API /api/system/devices', () => {
  let app: App;
  let dataDir: string;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'elvis-test-'));
    app = await buildApp(parseConfig({ dataDir }), { logger: false });
    await app.devices.start();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('ist Admins vorbehalten und protokolliert Änderungen', async () => {
    expect((await app.server.inject({ method: 'GET', url: '/api/system/devices' })).statusCode).toBe(401);
    const cookie = await adminCookie(app);
    const list = (await app.server.inject({ method: 'GET', url: '/api/system/devices', headers: { cookie } })).json() as DeviceModule[];
    const weather = list.find((d) => d.id === 'weather')!;
    expect(weather.drivers.map((d) => d.id)).toEqual(['sim', 'actisense-airmar']);
    expect(weather.drivers[1]!.options.port).toMatchObject({ type: 'serialport', required: true });

    const off = await app.server.inject({ method: 'PUT', url: '/api/system/devices/weather', headers: { cookie }, payload: { enabled: false, driver: 'sim', options: {} } });
    expect(off.statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: '/api/devices/weather' })).statusCode).toBe(404);
    const bad = await app.server.inject({ method: 'PUT', url: '/api/system/devices/weather', headers: { cookie }, payload: { enabled: true, driver: 'actisense-airmar', options: {} } });
    expect(bad.statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PUT', url: '/api/system/devices/toaster', headers: { cookie }, payload: { enabled: true, driver: 'sim' } })).statusCode).toBe(404);

    const audit = (await app.server.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).json() as { target: string; success: boolean; message: string }[];
    expect(audit.filter((a) => a.target === 'modul:weather').map((a) => [a.success, a.message])).toEqual(
      expect.arrayContaining([[true, 'deaktiviert'], [false, expect.stringContaining('port')]]),
    );
    expect((await app.server.inject({ method: 'GET', url: '/api/system/serialports', headers: { cookie } })).statusCode).toBe(200);
  });

  it('liefert Router-Passwörter nie aus, behält sie beim Speichern und protokolliert sie nicht', async () => {
    const cookie = await adminCookie(app);
    const put = (options: Record<string, unknown>) =>
      app.server.inject({ method: 'PUT', url: '/api/system/devices/router', headers: { cookie }, payload: { enabled: true, driver: 'teltonika-rutos', options } });
    const base = { host: '127.0.0.1:1', protocol: 'http', username: 'elvis', wanName: 'LAN Feuerwache' };
    expect((await put({ ...base, password: '' })).statusCode).toBe(400);
    const saved = (await put({ ...base, password: 'geheim' })).json() as DeviceModule;
    expect(saved.config.options.password).toBe('');
    expect(saved.secretsSet).toEqual(['password']);
    // erneut speichern ohne Passwort → bleibt erhalten
    expect((await put({ ...base, wanName: 'Wache 2', password: '' })).statusCode).toBe(200);
    const list = (await app.server.inject({ method: 'GET', url: '/api/system/devices', headers: { cookie } })).json() as DeviceModule[];
    expect(list.find((m) => m.id === 'router')).toMatchObject({ secretsSet: ['password'], config: { options: { wanName: 'Wache 2', password: '' } } });
    const audit = (await app.server.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).body;
    expect(audit).not.toContain('geheim');
    expect(audit).toContain('***');
    // Deaktivieren klappt auch mit unvollständigen Einstellungen
    expect((await app.server.inject({ method: 'PUT', url: '/api/system/devices/router', headers: { cookie }, payload: { enabled: false, driver: 'teltonika-rutos', options: {} } })).statusCode).toBe(200);
  });
});
