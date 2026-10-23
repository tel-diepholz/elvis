import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateAlerts } from '../../alerts.js';
import { TeltonikaAdapter, mapLeases, mapRouterState, type RutModem, type RutosSnapshot } from './teltonika.js';

const opts = { wanName: 'LAN Feuerwache', wanInterface: 'wan' };

const modem = (p: Partial<RutModem> = {}): RutModem => ({
  id: '2-1',
  model: 'RUTM59',
  builtin: true,
  sim_count: 2,
  active_sim: 1,
  simstate: 'Inserted',
  pinstate: 'Inserted',
  netstate: 'Registered, home',
  data_conn_state: 'Connected',
  operator: 'Telekom.de',
  conntype: '5G (NSA)',
  band: 'N78',
  signal_quality: 80,
  rssi: -61,
  rsrp: -88,
  rsrq: -11,
  sinr: 17,
  iccid: '8949022000000000001',
  ...p,
});

const snapshot = (p: Partial<RutosSnapshot> = {}): RutosSnapshot => ({
  modems: [modem()],
  interfaces: [
    { id: 'wan', is_up: true, metric: 1, 'ipv4-address': [{ address: '10.20.30.44', mask: 24 }], route: [{ target: '0.0.0.0', mask: 0, nexthop: '10.20.30.1' }] },
    { id: 'wan6', is_up: true, metric: 1 },
    { id: 'mob1s1a1', is_up: true, metric: 2 },
    { id: 'mob1s2a1', is_up: false, metric: 3 },
  ],
  failover: {
    wan: { enabled: true, up: true, status: 'online' },
    mob1s1a1: { enabled: true, up: true, status: 'online' },
    mob1s2a1: { enabled: true, up: false, status: 'offline' },
  },
  ports: [
    { name: 'LAN1', state: 'down' },
    { name: 'WAN', state: 'up', speed: 1000 },
  ],
  ...p,
});

describe('Teltonika: Umrechnung', () => {
  it('zeigt beide SIM-Steckplätze, Failover in Rangfolge und den benannten WAN-Port', () => {
    const s = mapRouterState(snapshot(), opts, null);
    expect(s.model).toBe('RUTM59');
    expect(s.wan).toEqual({ name: 'LAN Feuerwache', link: true, speedMbps: 1000, up: true, ip: '10.20.30.44', gateway: '10.20.30.1' });
    expect(s.sims[0]).toMatchObject({ slot: 1, active: true, status: 'connected', operator: 'Telekom.de', networkType: '5G (NSA)', signalPercent: 80, rsrpDbm: -88 });
    expect(s.sims[1]).toMatchObject({ slot: 2, active: false, status: 'standby', operator: null, seenAt: null });
    expect(s.failover.members.map((m) => [m.id, m.label, m.status, m.priority, m.active])).toEqual([
      ['wan', 'LAN Feuerwache', 'online', 1, true],
      ['mob1s1a1', 'SIM 1 (Telekom.de)', 'online', 2, false],
      ['mob1s2a1', 'SIM 2', 'standby', 3, false],
    ]);
    expect(s.failover).toMatchObject({ enabled: true, activeId: 'wan', onBackup: false });
    expect(s.internet).toBe(true);
  });

  it('erkennt Failover auf Mobilfunk und merkt sich die Werte der Reserve-SIM', () => {
    const first = mapRouterState(snapshot(), opts, null);
    // WAN-Kabel gezogen, SIM 1 fällt aus, Modem schaltet auf SIM 2
    const second = mapRouterState(
      snapshot({
        modems: [modem({ active_sim: 2, operator: 'Vodafone.de', conntype: 'LTE', iccid: '8949020000000000002' })],
        failover: { wan: { enabled: true, up: false, status: 'offline' }, mob1s1a1: { enabled: true, status: 'offline' }, mob1s2a1: { enabled: true, up: true, status: 'online' } },
        ports: [{ name: 'WAN', state: 'down', speed: 0 }],
        interfaces: [
          { id: 'wan', is_up: false, metric: 1 },
          { id: 'mob1s1a1', is_up: false, metric: 2 },
          { id: 'mob1s2a1', is_up: true, metric: 3 },
        ],
      }),
      opts,
      first,
    );
    expect(second.wan).toMatchObject({ link: false, up: false, ip: null, speedMbps: null });
    expect(second.failover).toMatchObject({ activeId: 'mob1s2a1', onBackup: true });
    expect(second.sims[0]).toMatchObject({ active: false, status: 'standby', operator: 'Telekom.de', iccid: '8949022000000000001', signalPercent: null });
    expect(second.sims[0]!.seenAt).not.toBeNull();
    expect(second.sims[1]).toMatchObject({ active: true, status: 'connected', operator: 'Vodafone.de' });

    const alerts = evaluateAlerts((id) => (id === 'router' ? second : undefined) as never, [], { stormWarnMs: 17 });
    expect(alerts.map((a) => [a.id, a.detail])).toEqual([['router:backup', 'SIM 2 (Vodafone.de)']]);
  });

  it('meldet SIM-Probleme und fehlendes Internet', () => {
    const noSim = mapRouterState(snapshot({ modems: [modem({ simstate: 'Not inserted', pinstate: 'Not inserted', data_conn_state: 'Disconnected' })], failover: {}, interfaces: [{ id: 'wan', is_up: false }] }), opts, null);
    expect(noSim.sims[0]).toMatchObject({ status: 'no-sim', operator: null });
    expect(noSim.internet).toBe(false);
    expect(noSim.failover.enabled).toBe(false);
    const ids = evaluateAlerts((id) => (id === 'router' ? noSim : undefined) as never, [], { stormWarnMs: 17 }).map((a) => a.id);
    expect(ids).toEqual(['router:internet', 'router:sim']);
    expect(mapRouterState(snapshot({ modems: [modem({ pinstate: 'Required PIN, 3 attempts left', data_conn_state: 'Disconnected', netstate: 'Not registered' })] }), opts, null).sims[0]!.status).toBe('pin-required');
  });

  it('kommt ohne Port- und Failover-Endpunkte aus (ältere Firmware)', () => {
    const s = mapRouterState(snapshot({ ports: null, failover: null }), opts, null);
    expect(s.wan.link).toBeNull();
    expect(s.failover.enabled).toBe(false);
    expect(s.failover.activeId).toBe('wan'); // aus Schnittstellenstatus und Metrik
  });
});

describe('Teltonika: DHCP-Leases', () => {
  it('sortiert nach IP, markiert feste Zuweisungen und rundet den Ablauf auf die Minute', () => {
    const now = new Date('2026-10-22T20:00:10Z');
    const leases = mapLeases(
      [
        { ipaddr: '192.168.1.101', macaddr: 'A4:83:E7:4C:AA:10', hostname: 'tablet-el', interface: 'lan', expires: 3600 },
        { ipaddr: '192.168.1.20', macaddr: '30:05:5c:11:22:33', hostname: '*', interface: 'lan', expires: 0 },
        { ipaddr: '192.168.1.9', macaddr: '00:1b:21:3a:4f:01', hostname: 'pc-1', expires: 30 },
        { ipaddr: '', macaddr: 'kaputt' },
      ],
      { cfg01: { name: 'Drucker Führungsraum', mac: '30:05:5C:11:22:33', ip: '192.168.1.20' } },
      now,
    );
    expect(leases).toEqual([
      { ip: '192.168.1.9', mac: '00:1b:21:3a:4f:01', hostname: 'pc-1', interface: null, expiresAt: '2026-10-22T20:01:00.000Z', static: false, name: null },
      { ip: '192.168.1.20', mac: '30:05:5c:11:22:33', hostname: null, interface: 'lan', expiresAt: null, static: true, name: 'Drucker Führungsraum' },
      { ip: '192.168.1.101', mac: 'a4:83:e7:4c:aa:10', hostname: 'tablet-el', interface: 'lan', expiresAt: '2026-10-22T21:01:00.000Z', static: false, name: null },
    ]);
    // gleiche Restlaufzeit wenige Sekunden später → gleicher Zustand (kein Dauer-Update)
    expect(mapLeases([{ ipaddr: '1.1.1.1', macaddr: 'aa', expires: 3595 }], null, new Date('2026-10-22T20:00:15Z'))![0]!.expiresAt).toBe('2026-10-22T21:01:00.000Z');
    expect(mapLeases([{ ipaddr: '1.1.1.1', macaddr: 'aa', expires: 3590 }], null, new Date('2026-10-22T20:00:20Z'))![0]!.expiresAt).toBe('2026-10-22T21:01:00.000Z');
    expect(mapLeases(null, null, now)).toBeNull();
  });
});

describe('Teltonika: API-Zugriff', () => {
  let server: Server;
  let port: number;
  const calls: string[] = [];
  let tokenCounter = 0;
  let validToken = '';
  let rejectPassword = false;

  beforeEach(async () => {
    calls.length = 0;
    server = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url === '/api/login') {
          const { username, password } = JSON.parse(raw);
          if (rejectPassword || username !== 'elvis' || password !== 'geheim') return send(401, { success: false, errors: [{ code: 121, error: 'Authentication failed' }] });
          validToken = `t${++tokenCounter}`;
          return send(200, { success: true, data: { username, token: validToken, expires: 299 } });
        }
        if (req.headers.authorization !== `Bearer ${validToken}`) return send(401, { success: false, errors: [{ code: 120, error: 'Unauthorized access' }] });
        const s = snapshot();
        if (req.url === '/api/modems/status') return send(200, { success: true, data: s.modems });
        if (req.url === '/api/interfaces/status') return send(200, { success: true, data: s.interfaces });
        if (req.url === '/api/failover/status') return send(200, { success: true, data: s.failover });
        if (req.url === '/api/dhcp/leases/ipv4/status') return send(200, { success: true, data: [{ ipaddr: '192.168.1.10', macaddr: '00:11:22:33:44:55', hostname: 'pc', interface: 'lan', expires: 600 }] });
        return send(404, { success: false, errors: [{ code: 122, error: 'Endpoint not implemented' }] });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, getState: () => undefined };
  const adapter = () => new TeltonikaAdapter({ host: `127.0.0.1:${port}`, protocol: 'http', username: 'elvis', password: 'geheim', wanName: 'LAN Feuerwache', pollSeconds: 300 });

  it('meldet sich an, fragt ab und merkt sich nicht unterstützte Endpunkte', async () => {
    const a = adapter();
    await a.start(ctx);
    await a.poll();
    expect(a.isOnline()).toBe(true);
    expect(a.getState().sims[0]).toMatchObject({ status: 'connected', operator: 'Telekom.de' });
    expect(a.getState().wan).toMatchObject({ name: 'LAN Feuerwache', link: null, ip: '10.20.30.44' });
    expect(calls.filter((c) => c.includes('login'))).toHaveLength(1);
    expect(a.getState().leases).toMatchObject([{ ip: '192.168.1.10', hostname: 'pc', static: false }]);

    // Token läuft im Router ab → neu anmelden; Port-Status (404) wird nicht erneut gefragt
    validToken = 'abgelaufen';
    calls.length = 0;
    await a.poll();
    expect(a.isOnline()).toBe(true);
    expect(calls.filter((c) => c.includes('login'))).toHaveLength(1);
    expect(calls).not.toContain('GET /api/ports_settings/status');
    await a.stop();
  });

  it('geht bei falschem Passwort oder unerreichbarem Router auf offline', async () => {
    rejectPassword = true;
    const a = adapter();
    await a.start(ctx);
    await a.poll();
    expect(a.isOnline()).toBe(false);
    rejectPassword = false;
    await a.poll();
    expect(a.isOnline()).toBe(true);
    await a.stop();

    const gone = new TeltonikaAdapter({ host: '127.0.0.1:1', protocol: 'http', password: 'x', pollSeconds: 300 });
    await gone.start(ctx);
    await gone.poll();
    expect(gone.isOnline()).toBe(false);
    await gone.stop();
  });
});
