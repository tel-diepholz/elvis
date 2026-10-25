import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BluetoothDeviceConfig, BluetoothDeviceInput, BluetoothState, DeviceModule } from '@elvis/shared';
import { evaluateAlerts } from '../../alerts.js';
import { buildApp, type App } from '../../app.js';
import { parseConfig } from '../../config.js';
import { adminCookie } from '../../test-helpers.js';
import type { BleAdvertisement, BleScanner } from '../bluetooth/bluez.js';
import { VICTRON_COMPANY_ID, victronEncode } from '../bluetooth/victron.js';
import { BluetoothAdapter, type BluetoothSource } from './bluetooth.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, getState: () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeScanner implements BleScanner {
  readonly label = 'hci0';
  failures: Error[] = [];
  emit: ((a: BleAdvertisement) => void) | null = null;
  lost: ((err: Error) => void) | null = null;
  starts = 0;

  async start(onAdvertisement: (a: BleAdvertisement) => void, onLost: (err: Error) => void): Promise<void> {
    this.starts++;
    const err = this.failures.shift();
    if (err) throw err;
    this.emit = onAdvertisement;
    this.lost = onLost;
  }

  async stop(): Promise<void> {
    this.emit = null;
  }
}

function source(devices: Partial<BluetoothDeviceConfig>[]): BluetoothSource & { set(d: Partial<BluetoothDeviceConfig>[]): void } {
  let list: BluetoothDeviceConfig[] = [];
  const listeners = new Set<() => void>();
  const set = (d: Partial<BluetoothDeviceConfig>[]) => {
    list = d.map((x, i) => ({ id: `bt-${i}`, name: `Akku ${i + 1}`, kind: 'victron', address: '', key: KEY, warnBelowV: null, enabled: true, sort: i, ...x }));
    listeners.forEach((l) => l());
  };
  set(devices);
  return { list: () => list, onChange: (l) => (listeners.add(l), () => listeners.delete(l)), set };
}

const lithium = (voltageV: number, extra: Partial<{ errorFlags: number; cells: (number | 'low' | 'high')[] }> = {}) =>
  victronEncode({ type: 'lithium', bmsFlags: 0, errorFlags: 0, cells: [3.3, 3.3, 3.3, 3.3], voltageV, balancer: 'balanced', temperatureC: 15, ...extra }, KEY);
const adv = (address: string, data: Buffer, name: string | null = 'Lithium Battery Smart'): BleAdvertisement => ({ address, name, rssi: -60, manufacturerData: new Map([[VICTRON_COMPANY_ID, data]]) });

describe('Modul Bluetooth', () => {
  let adapter: BluetoothAdapter | null = null;
  afterEach(async () => {
    await adapter?.stop();
    adapter = null;
  });

  it('liest eingetragene Victron-Geräte und bietet unbekannte in der Nähe an', async () => {
    let now = 1_000_000;
    const src = source([{ address: 'AA:00:00:00:00:01' }, { address: 'AA:00:00:00:00:02', name: 'Akku 2', key: 'ffeeddccbbaa99887766554433221100' }]);
    const scanner = new FakeScanner();
    adapter = new BluetoothAdapter('bluez', src, scanner, { staleMs: 60_000, publishMs: 10, now: () => now });
    await adapter.start(ctx);
    expect(adapter.isOnline()).toBe(true);
    expect(adapter.getState().adapter).toEqual({ name: 'hci0', scanning: true, error: null });

    scanner.emit!(adv('AA:00:00:00:00:01', lithium(13.24)));
    // Falscher Schlüssel für Akku 2
    scanner.emit!(adv('AA:00:00:00:00:02', lithium(13.1)));
    scanner.emit!(adv('BB:00:00:00:00:09', lithium(13.0), 'Fremder Akku'));
    // Andere Hersteller und andere Victron-Pakete werden ignoriert
    scanner.emit!({ address: 'CC:00:00:00:00:01', name: 'Telefon', rssi: -40, manufacturerData: new Map([[0x004c, Buffer.from([1, 2, 3])]]) });
    await sleep(40);

    const s = adapter.getState();
    expect(s.devices[0]).toMatchObject({ name: 'Akku 1', stale: false, rssi: -60, advertisedName: 'Lithium Battery Smart', error: null, readout: { type: 'lithium', voltageV: 13.24, temperatureC: 15 } });
    expect(s.devices[1]).toMatchObject({ name: 'Akku 2', readout: null, error: 'Schlüssel passt nicht zum Gerät' });
    expect(s.nearby.map((n) => [n.address, n.type, n.configured])).toEqual([
      ['AA:00:00:00:00:01', 'Lithium-Batterie', true],
      ['AA:00:00:00:00:02', 'Lithium-Batterie', true],
      ['BB:00:00:00:00:09', 'Lithium-Batterie', false],
    ]);

    // Meldungen: falscher Schlüssel
    const alerts = (state: BluetoothState) => evaluateAlerts((id) => (id === 'bluetooth' ? state : undefined) as never, [], { stormWarnMs: 17 }).map((a) => [a.severity, a.title]);
    expect(alerts(adapter.getState())).toEqual([['warn', 'Akku 2: Schlüssel passt nicht zum Gerät']]);

    // Grenze, BMS-Fehler und Zelle zu niedrig
    src.set([{ address: 'AA:00:00:00:00:01', warnBelowV: 12.8 }]);
    scanner.emit!(adv('AA:00:00:00:00:01', lithium(12.5, { errorFlags: 0x10, cells: [3.3, 'low', 3.3, 3.3] })));
    await sleep(40);
    expect(adapter.getState().devices).toHaveLength(1);
    expect(alerts(adapter.getState())).toEqual([
      ['alarm', 'Akku 1: Batteriefehler'],
      ['alarm', 'Akku 1: Zellspannung zu niedrig'],
      ['warn', 'Akku 1: Spannung niedrig'],
    ]);

    // Länger nichts empfangen: „kein Empfang“ statt der Werte
    now += 61_000;
    await sleep(40);
    expect(adapter.getState().devices[0]!.stale).toBe(true);
    expect(alerts(adapter.getState())).toEqual([['warn', 'Akku 1: kein Empfang']]);
  });

  it('meldet erst nach der Wartezeit, dass ein Gerät nie empfangen wurde', async () => {
    let now = 0;
    adapter = new BluetoothAdapter('bluez', source([{ address: 'AA:00:00:00:00:01' }]), new FakeScanner(), { staleMs: 60_000, publishMs: 10, now: () => now });
    await adapter.start(ctx);
    await sleep(30);
    expect(adapter.getState().devices[0]).toMatchObject({ seenAt: null, stale: false });
    now = 61_000;
    await sleep(30);
    expect(adapter.getState().devices[0]).toMatchObject({ seenAt: null, stale: true });
  });

  it('gilt bei Adapterfehlern als nicht erreichbar und versucht es erneut', async () => {
    const scanner = new FakeScanner();
    scanner.failures.push(new Error('BlueZ (bluetoothd) läuft auf dem Server nicht'));
    adapter = new BluetoothAdapter('bluez', source([]), scanner, { staleMs: 60_000, publishMs: 10, retryMs: 20 });
    await adapter.start(ctx);
    expect(adapter.isOnline()).toBe(false);
    expect(adapter.getState().adapter).toEqual({ name: 'hci0', scanning: false, error: 'BlueZ (bluetoothd) läuft auf dem Server nicht' });
    await sleep(60);
    expect(scanner.starts).toBe(2);
    expect(adapter.isOnline()).toBe(true);
    // Später abgerissen (z. B. bluetoothd neu gestartet)
    scanner.lost!(new Error('Verbindung zu BlueZ getrennt'));
    expect(adapter.isOnline()).toBe(false);
    await sleep(60);
    expect(scanner.starts).toBe(3);
    expect(adapter.isOnline()).toBe(true);
  });
});

describe('Bluetooth-Geräte in den Einstellungen', () => {
  let app: App;
  let dataDir: string;
  let admin: string;

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const req = async <T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) => {
    const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  };

  it('legt Geräte an, prüft Adresse und Schlüssel und gibt sie an das Modul', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'elvis-bt-'));
    app = await buildApp(parseConfig({ dataDir }), { logger: false });
    admin = await adminCookie(app);

    // Modul ist da (Simulation als Vorgabe) und gehört zur Energie
    const modules = (await req<DeviceModule[]>('GET', '/api/system/devices')).body;
    expect(modules.find((m) => m.id === 'bluetooth')).toMatchObject({ system: 'energy', config: { driver: 'sim', enabled: true } });
    expect(modules.find((m) => m.id === 'bluetooth')!.drivers.map((d) => d.id)).toEqual(['sim', 'bluez']);

    const input: BluetoothDeviceInput = { name: 'Akku links', kind: 'victron', address: 'c8-2e-47-12-34-56', key: '0123 4567 89AB CDEF 0123 4567 89ab cdef', warnBelowV: 12.4, enabled: true };
    const created = await req<BluetoothDeviceConfig>('POST', '/api/system/bluetooth', input);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ address: 'C8:2E:47:12:34:56', key: KEY, warnBelowV: 12.4 });

    expect((await req('POST', '/api/system/bluetooth', { ...input, name: 'Doppelt' })).status).toBe(409);
    expect((await req('POST', '/api/system/bluetooth', { ...input, address: 'C8:2E:47', name: 'x' })).status).toBe(400);
    const noKey = await req<{ error: string }>('POST', '/api/system/bluetooth', { ...input, address: 'C8:2E:47:12:34:57', key: '' });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error).toMatch(/Schlüssel fehlt/);

    const second = (await req<BluetoothDeviceConfig>('POST', '/api/system/bluetooth', { ...input, name: 'Akku rechts', address: 'C8:2E:47:12:34:57' })).body;
    await req('PUT', '/api/system/bluetooth/order', { ids: [second.id, created.body.id] });
    expect((await req<BluetoothDeviceConfig[]>('GET', '/api/system/bluetooth')).body.map((d) => d.name)).toEqual(['Akku rechts', 'Akku links']);
    expect((await req('PUT', `/api/system/bluetooth/${created.body.id}`, { ...input, enabled: false })).status).toBe(200);

    // Das Modul zeigt nur aktive Geräte (Adapter starten erst mit app.start(), hier von Hand)
    await app.devices.adapter('bluetooth')!.start(ctx);
    const state = () => app.devices.adapter('bluetooth')!.getState() as BluetoothState;
    expect(state().devices.map((d) => d.name)).toEqual(['Akku rechts']);
    expect(state().adapter.name).toBe('Simulation');

    expect((await req('DELETE', `/api/system/bluetooth/${second.id}`)).status).toBe(204);
    expect(state().devices).toEqual([]);

    // Nur für Admins
    expect((await req('GET', '/api/system/bluetooth', undefined, '')).status).toBe(401);
  });
});
