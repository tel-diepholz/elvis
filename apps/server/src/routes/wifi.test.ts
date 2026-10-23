import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DisplayDevice, DisplaySelf, Incident, WifiAp, WifiApTestResult, WifiClient, WifiGuestInfo, WifiOverview } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { OpenWrtWifiAdapter } from '../devices/drivers/openwrt.js';
import type { UbusHttp, UciSection } from '../services/openwrt.js';
import { adminCookie } from '../test-helpers.js';

/**
 * OpenWrt-AP im Speicher: rpcd-Anmeldung und die genutzten uci-Aufrufe. luci = Rechte wie das root-Konto eines
 * aktuellen OpenWrt mit LuCI (uci apply statt commit, kein network.reload).
 */
const sec = (type: string, name: string, values: Record<string, string | string[]> = {}): UciSection => ({ '.type': type, '.name': name, ...values });

function fakeOpenWrt(opts: { password?: string; guestBridge?: boolean; luci?: boolean; network?: Record<string, UciSection> } = {}) {
  const config: { wireless: Record<string, UciSection>; network: Record<string, UciSection> } = {
    wireless: {
      radio0: sec('wifi-device', 'radio0', { band: '2g', disabled: '1' }),
      radio1: sec('wifi-device', 'radio1', { band: '5g', disabled: '1' }),
      default_radio0: sec('wifi-iface', 'default_radio0', { device: 'radio0', ssid: 'OpenWrt', network: 'lan', mode: 'ap' }),
    },
    network: opts.network ?? { lan: sec('interface', 'lan'), wan: sec('interface', 'wan'), ...(opts.guestBridge !== false && { guest: sec('interface', 'guest') }) },
  };
  const ap = { config, commits: 0, reloads: 0, reachable: true, stations: {} as Record<string, unknown[]> };
  const http: UbusHttp = async (_url, body) => {
    if (!ap.reachable) throw new Error('connect ECONNREFUSED');
    const [sid, object, method, p] = (body as { params: [string, string, string, Record<string, unknown>] }).params;
    const ok = (data?: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: data === undefined ? [0] : [0, data] } });
    if (object === 'session' && method === 'login') return p.username === 'root' && p.password === (opts.password ?? 'geheim') ? ok({ ubus_rpc_session: 'abc' }) : { status: 200, body: { result: [6] } };
    if (sid !== 'abc') return { status: 200, body: { error: { code: -32002, message: 'Access denied' } } };
    const cfg = config[p.config as 'wireless' | 'network'];
    if (object === 'uci' && method === 'get') return ok({ values: structuredClone(cfg) });
    if (object === 'uci' && method === 'add') {
      cfg[p.name as string] = sec(p.type as string, p.name as string, p.values as Record<string, string>);
      return ok({ section: p.name });
    }
    if (object === 'uci' && method === 'set') {
      Object.assign(cfg[p.section as string]!, p.values);
      return ok();
    }
    if (object === 'uci' && method === 'delete') {
      delete cfg[p.section as string];
      return ok();
    }
    if (object === 'luci-rpc' && method === 'getWirelessDevices') {
      const radios = Object.values(config.wireless).filter((r) => r['.type'] === 'wifi-device');
      return ok(
        Object.fromEntries(
          radios.map((r, ri) => [
            r['.name'],
            {
              config: { band: r.band },
              interfaces: Object.values(config.wireless)
                .filter((i) => i['.type'] === 'wifi-iface' && i.device === r['.name'])
                .map((i, ii) => ({ section: i['.name'], ifname: `wlan${ri}${ii ? `-${ii}` : ''}`, config: { ssid: i.ssid } })),
            },
          ]),
        ),
      );
    }
    if (object === 'luci-rpc' && method === 'getHostHints') return ok({ 'aa:bb:cc:00:00:01': { name: 'tablet-el', ipaddrs: ['192.168.1.50'] } });
    if (object === 'iwinfo' && method === 'assoclist') return ok({ results: ap.stations[p.device as string] ?? [] });
    const denied = { status: 200, body: { result: [6] } };
    if (object === 'uci' && method === 'commit') return opts.luci ? denied : (ap.commits++, ok());
    if (object === 'uci' && method === 'apply') return opts.luci ? (ap.commits++, ok()) : { status: 200, body: { result: [3] } };
    if (object === 'network' && method === 'reload') return opts.luci ? denied : (ap.reloads++, ok());
    return { status: 200, body: { result: [3] } };
  };
  return Object.assign(ap, { http });
}

let app: App;
let dataDir: string;
let admin = '';
let fake: ReturnType<typeof fakeOpenWrt>;

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T, setCookie: res.headers['set-cookie'] };
}

const AP = { name: 'AP Heck', host: '192.168.1.2', protocol: 'http', username: 'root', password: 'geheim', verifyTls: false, opsNetwork: 'lan', guestNetwork: 'guest', enabled: true };
const SETTINGS = { ops: { enabled: true, ssid: 'ELW-Betrieb', password: 'betrieb123' }, guest: { enabled: true, ssid: 'ELW-Gast' } };

async function setup(apOpts?: Parameters<typeof fakeOpenWrt>[0]) {
  fake = fakeOpenWrt(apOpts);
  app = await buildApp(parseConfig({ dataDir }), { logger: false, wifiHttp: (...a) => fake.http(...a) });
  admin = await adminCookie(app);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-wifi-'));
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const iface = (name: string) => fake.config.wireless[name];

describe('WLAN über OpenWrt', () => {
  it('richtet das Betriebs-WLAN auf allen Funkmodulen ein und lässt fremde Abschnitte stehen', async () => {
    await setup();
    expect((await req('PUT', '/api/system/wifi/settings', { ...SETTINGS, ops: { ...SETTINGS.ops, password: 'kurz' } })).status).toBe(400);
    expect((await req('PUT', '/api/system/wifi/settings', SETTINGS)).status).toBe(200);
    const created = await req<WifiAp>('POST', '/api/system/wifi/aps', AP);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ passwordSet: true, status: { state: 'pending' } });
    expect(created.body).not.toHaveProperty('password');

    const o = (await req<WifiOverview>('POST', '/api/system/wifi/sync')).body;
    expect(o.aps[0]!.status).toMatchObject({ state: 'ok', radios: ['radio0 (2,4 GHz)', 'radio1 (5 GHz)'] });
    expect(iface('elvis_ops_radio0')).toMatchObject({ '.type': 'wifi-iface', device: 'radio0', ssid: 'ELW-Betrieb', key: 'betrieb123', encryption: 'psk2', network: 'lan' });
    expect(iface('elvis_ops_radio1')).toMatchObject({ device: 'radio1', ssid: 'ELW-Betrieb' });
    expect(fake.config.wireless.radio0!.disabled).toBe('0');
    expect(iface('default_radio0')).toMatchObject({ ssid: 'OpenWrt' });
    // ohne Einsatz kein Gastnetz
    expect(iface('elvis_guest_radio0')).toBeUndefined();
    expect(o.guest).toEqual({ active: false, reason: 'Gastnetz startet mit dem nächsten Einsatz' });

    // unveränderter Sollstand: nichts schreiben, kein Neuladen
    const commits = fake.commits;
    await req('POST', '/api/system/wifi/sync');
    expect(fake.commits).toBe(commits);
  });

  it('schaltet das Gastnetz mit dem Einsatz zu und wieder ab, mit neuem Passwort je Einsatz', async () => {
    await setup();
    await req('PUT', '/api/system/wifi/settings', SETTINGS);
    await req('POST', '/api/system/wifi/aps', AP);
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;

    const guest = (await req<WifiGuestInfo>('GET', '/api/wifi/guest')).body;
    expect(guest).toMatchObject({ active: true, ssid: `ELW-Gast-${incident.id}`, incidentId: incident.id });
    const password = (guest as { password: string }).password;
    expect(password).toMatch(/^[A-Za-z2-9]{12}$/);
    await req('POST', '/api/system/wifi/sync');
    expect(iface('elvis_guest_radio0')).toMatchObject({ ssid: `ELW-Gast-${incident.id}`, key: password, network: 'guest', isolate: '1' });
    expect(iface('elvis_ops_radio0')).toMatchObject({ isolate: '0' });

    await req('POST', `/api/incidents/${incident.id}/close`);
    expect((await req<WifiGuestInfo>('GET', '/api/wifi/guest')).body.active).toBe(false);
    await req('POST', '/api/system/wifi/sync');
    expect(iface('elvis_guest_radio0')).toBeUndefined();
    expect(iface('elvis_ops_radio0')).toBeDefined();

    const next = (await req<Incident>('POST', '/api/incidents', { title: 'THL' })).body;
    const again = (await req<WifiGuestInfo>('GET', '/api/wifi/guest')).body as { ssid: string; password: string };
    expect(again.ssid).toBe(`ELW-Gast-${next.id}`);
    expect(again.password).not.toBe(password);
  });

  it('meldet fehlende Gastnetz-Bridge, falsche Zugangsdaten und nicht erreichbare APs', async () => {
    await setup({ guestBridge: false });
    await req('PUT', '/api/system/wifi/settings', SETTINGS);
    await req('POST', '/api/incidents', { title: 'Brand' });

    const test = await req<WifiApTestResult>('POST', '/api/system/wifi/aps/test', { ap: AP });
    expect(test.body).toEqual({ ok: false, message: 'Verbunden, aber Gastnetz-Bridge „guest“ nicht gefunden – vorhanden: Schnittstellen lan, wan' });
    expect((await req<WifiApTestResult>('POST', '/api/system/wifi/aps/test', { ap: { ...AP, guestNetwork: '' } })).body).toEqual({
      ok: true,
      message: 'Verbunden – 2 Funkmodule (radio0 (2,4 GHz), radio1 (5 GHz)), Betriebs-WLAN → lan',
    });
    expect((await req<WifiApTestResult>('POST', '/api/system/wifi/aps/test', { ap: { ...AP, password: 'falsch' } })).body.message).toBe('Anmeldung abgelehnt – Benutzer oder Passwort falsch');

    const ap = (await req<WifiAp>('POST', '/api/system/wifi/aps', AP)).body;
    let o = (await req<WifiOverview>('POST', '/api/system/wifi/sync')).body;
    // Betriebs-WLAN trotzdem eingerichtet
    expect(iface('elvis_ops_radio0')).toBeDefined();
    expect(o.aps[0]!.status).toMatchObject({ state: 'error', message: 'Gastnetz-Bridge „guest“ nicht gefunden – vorhanden: Schnittstellen lan, wan' });

    fake.reachable = false;
    o = (await req<WifiOverview>('POST', '/api/system/wifi/sync')).body;
    expect(o.aps[0]!.status.state).toBe('error');
    expect(o.aps[0]!.status.message).toMatch(/nicht erreichbar/);

    // leeres Passwort beim Bearbeiten = unverändert; deaktivierte APs werden nicht angefasst
    const updated = await req<WifiAp>('PUT', `/api/system/wifi/aps/${ap.id}`, { ...AP, password: '', enabled: false });
    expect(updated.body).toMatchObject({ passwordSet: true, status: { state: 'disabled' } });
  });

  it('nimmt Bridge-Geräte und Ports an und legt für eine Bridge ohne Schnittstelle eine an (LuCI-Rechte)', async () => {
    // Stand eines frisch eingerichteten APs: Gastnetz-Bridge nur unter „Geräte“, ohne Schnittstelle
    await setup({
      luci: true,
      network: {
        loopback: sec('interface', 'loopback', { device: 'lo' }),
        cfg030f15: sec('device', 'cfg030f15', { name: 'br-lan', type: 'bridge', ports: ['eth0'] }),
        lan: sec('interface', 'lan', { device: 'br-lan', proto: 'dhcp' }),
        cfg050f15: sec('device', 'cfg050f15', { name: 'br-guests', type: 'bridge' }),
      },
    });
    const ap = { ...AP, opsNetwork: 'eth0', guestNetwork: 'br-guests' };
    expect((await req<WifiApTestResult>('POST', '/api/system/wifi/aps/test', { ap })).body).toEqual({
      ok: true,
      message: 'Verbunden – 2 Funkmodule (radio0 (2,4 GHz), radio1 (5 GHz)), Betriebs-WLAN → lan, Gastnetz → Bridge br-guests (ELVIS legt dafür eine Schnittstelle an)',
    });
    expect((await req<WifiApTestResult>('POST', '/api/system/wifi/aps/test', { ap: { ...ap, guestNetwork: 'guest' } })).body.message).toBe(
      'Verbunden, aber Gastnetz-Bridge „guest“ nicht gefunden – vorhanden: Schnittstellen lan; Bridges br-lan, br-guests',
    );

    await req('PUT', '/api/system/wifi/settings', SETTINGS);
    expect((await req('POST', '/api/system/wifi/aps', ap)).status).toBe(201);
    const incident = (await req<Incident>('POST', '/api/incidents', { title: 'Brand' })).body;
    const o = (await req<WifiOverview>('POST', '/api/system/wifi/sync')).body;
    expect(o.aps[0]!.status.state).toBe('ok');
    expect(fake.commits).toBe(1);
    expect(fake.config.network.elvis_guest).toMatchObject({ '.type': 'interface', proto: 'none', device: 'br-guests' });
    expect(iface('elvis_ops_radio0')).toMatchObject({ network: 'lan' });
    expect(iface('elvis_guest_radio1')).toMatchObject({ network: 'elvis_guest', ssid: `ELW-Gast-${incident.id}` });

    await req('POST', `/api/incidents/${incident.id}/close`);
    await req('POST', '/api/system/wifi/sync');
    expect(fake.config.network.elvis_guest).toBeUndefined();
    expect(iface('elvis_guest_radio1')).toBeUndefined();
    expect(fake.config.network.cfg050f15).toBeDefined();
  });

  it('Modul „WLAN-Accesspoints“: schreibt die Geräte in wifi_clients und meldet nicht erreichbare APs als Alarm', async () => {
    await setup();
    await req('PUT', '/api/system/wifi/settings', SETTINGS);
    const ap = (await req<WifiAp>('POST', '/api/system/wifi/aps', AP)).body;
    await req('POST', '/api/incidents', { title: 'Brand' });
    await req('POST', '/api/system/wifi/sync');
    const adapter = app.devices.adapter('wifi') as OpenWrtWifiAdapter;
    expect(adapter.driver).toBe('openwrt');
    // radio0: default_radio0 (fremd) = wlan0, elvis_ops_radio0 = wlan0-1, elvis_guest_radio0 = wlan0-2
    fake.stations = {
      wlan0: [{ mac: 'AA:BB:CC:00:00:99', signal: -50 }],
      'wlan0-1': [{ mac: 'AA:BB:CC:00:00:01', signal: -48, connected_time: 600, rx: { rate: 866000 }, tx: { rate: 650000 } }],
      'wlan0-2': [{ mac: '72:be:55:ea:0d:6a', signal: -70 }],
    };
    await adapter.pollAll();
    expect(adapter.getState().aps).toEqual([{ id: ap.id, name: 'AP Heck', online: true, error: null, clients: { ops: 1, guest: 1 } }]);
    const clients = (await req<WifiClient[]>('GET', '/api/wifi/clients')).body;
    expect(clients).toEqual([
      expect.objectContaining({ mac: 'AA:BB:CC:00:00:01', name: 'tablet-el', ip: '192.168.1.50', network: 'ops', ssid: 'ELW-Betrieb', apName: 'AP Heck', band: '2,4 GHz', signalDbm: -48, rxRateKbps: 866000, connectedSec: 600 }),
      expect.objectContaining({ mac: '72:BE:55:EA:0D:6A', name: null, ip: null, network: 'guest', signalDbm: -70 }),
    ]);
    expect((await req('GET', '/api/wifi/clients', undefined, '')).status).toBe(401);

    // abgemeldet → aus der Tabelle
    fake.stations = { 'wlan0-1': fake.stations['wlan0-1']! };
    await adapter.pollAll();
    expect((await req<WifiClient[]>('GET', '/api/wifi/clients')).body.map((c) => c.network)).toEqual(['ops']);

    // nicht erreichbar → Alarm, Geräte bleiben mit letztem Stand
    fake.reachable = false;
    await adapter.pollAll();
    expect(app.devices.getAlerts()).toContainEqual(
      expect.objectContaining({ id: `wifi:${ap.id}`, severity: 'alarm', title: 'Accesspoint AP Heck nicht erreichbar', detail: expect.stringMatching(/nicht erreichbar/) }),
    );
    expect((await req<WifiClient[]>('GET', '/api/wifi/clients')).body).toHaveLength(1);
    fake.reachable = true;
    await adapter.pollAll();
    expect(app.devices.getAlerts().some((a) => a.id.startsWith('wifi:'))).toBe(false);

    // AP entfernt → Geräte weg
    await req('DELETE', `/api/system/wifi/aps/${ap.id}`);
    expect((await req<WifiClient[]>('GET', '/api/wifi/clients')).body).toEqual([]);
  });

  it('ist nur für Admins verwaltbar; das Gastnetz lesen auch gekoppelte Bildschirme', async () => {
    await setup();
    expect((await req('GET', '/api/system/wifi', undefined, '')).status).toBe(401);
    expect((await req('GET', '/api/wifi/guest', undefined, '')).status).toBe(401);

    const start = await req<DisplaySelf>('POST', '/api/display/pair', undefined, '');
    const cookie = String(start.setCookie).split(';')[0]!;
    await req<DisplayDevice>('POST', '/api/system/displays/pair', { code: (start.body as { code: string }).code, name: 'Lagetisch' });
    expect((await req<WifiGuestInfo>('GET', '/api/wifi/guest', undefined, cookie)).body).toEqual({ active: false, reason: 'Gastnetz ist ausgeschaltet' });
  });
});
