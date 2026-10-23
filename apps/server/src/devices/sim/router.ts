import type { RouterState } from '@elvis/shared';
import { mapRouterState, type RutModem, type RutosSnapshot } from '../drivers/teltonika.js';
import { SimAdapter, clamp, drift } from './sim-adapter.js';

/**
 * Simulierter Teltonika-Router: WAN-Kabel an der Wache wird ab und zu gezogen, SIM 1 fällt
 * gelegentlich aus und das Modem schaltet auf SIM 2. Läuft durch dieselbe Umrechnung wie der echte Treiber.
 */
export class RouterSim extends SimAdapter<'router'> {
  protected readonly commands = {};
  private wanPlugged = true;
  private activeSim = 1;
  private sim1Ok = true;
  private signal = 72;
  /** Geräte im Fahrzeugnetz; Lease-Ende fest, damit die Restlaufzeit sinkt */
  private readonly clients = (
    [
      ['elw2-pc-1', '00:1b:21:3a:4f:01', 'lan', 10],
      ['elw2-pc-2', '00:1b:21:3a:4f:02', 'lan', 11],
      ['Drucker-A3', '30:05:5c:11:22:33', 'lan', 20],
      ['tablet-el', 'a4:83:e7:4c:aa:10', 'lan', 101],
      ['iPhone', 'f2:18:98:01:02:03', 'lan', 102],
      ['*', 'b8:27:eb:12:34:56', 'lan', 140],
    ] as const
  ).map(([hostname, macaddr, iface, host]) => ({ hostname, macaddr, interface: iface, ipaddr: `192.168.1.${host}`, end: Date.now() + (2 + Math.random() * 10) * 3600_000 }));

  constructor(private readonly options: { wanName: string }) {
    super('router', mapRouterState({ modems: [], interfaces: [], failover: {}, ports: [] }, { wanName: options.wanName, wanInterface: 'wan' }, null), { tickMs: 2000 });
  }

  protected tick(): void {
    if (Math.random() < 0.02) this.wanPlugged = !this.wanPlugged;
    if (Math.random() < 0.01) this.sim1Ok = !this.sim1Ok;
    // SIM-Umschaltung wie im Router: ohne Netz auf SIM 2, zurück, wenn SIM 1 wieder geht
    this.activeSim = this.sim1Ok ? 1 : 2;
    this.signal = Math.round(clamp(drift(this.signal, 70, 4), 5, 100));
    const sim1 = this.activeSim === 1;
    const modem: RutModem = {
      model: 'RUTM59 (Simulation)',
      builtin: true,
      sim_count: 2,
      active_sim: this.activeSim,
      simstate: 'Inserted',
      pinstate: 'Inserted',
      netstate: 'Registered, home',
      data_conn_state: 'Connected',
      operator: sim1 ? 'Telekom.de' : 'Vodafone.de',
      conntype: sim1 ? '5G (NSA)' : 'LTE',
      band: sim1 ? 'N78' : 'B20',
      signal_quality: this.signal,
      rssi: -60 - Math.round((100 - this.signal) / 3),
      rsrp: -85 - Math.round((100 - this.signal) / 2),
      rsrq: -10,
      sinr: Math.round(this.signal / 5),
      iccid: sim1 ? '8949022000000000001' : '8949020000000000002',
    };
    const snap: RutosSnapshot = {
      modems: [modem],
      interfaces: [
        {
          id: 'wan',
          is_up: this.wanPlugged,
          metric: 1,
          'ipv4-address': this.wanPlugged ? [{ address: '10.20.30.44', mask: 24 }] : [],
          route: this.wanPlugged ? [{ target: '0.0.0.0', mask: 0, nexthop: '10.20.30.1' }] : [],
        },
        { id: 'mob1s1a1', is_up: sim1, metric: 2 },
        { id: 'mob1s2a1', is_up: !sim1, metric: 3 },
      ],
      failover: {
        wan: { enabled: true, up: this.wanPlugged, status: this.wanPlugged ? 'online' : 'offline' },
        mob1s1a1: { enabled: true, up: sim1, status: sim1 ? 'online' : 'offline' },
        mob1s2a1: { enabled: true, up: !sim1, status: !sim1 ? 'online' : 'offline' },
      },
      ports: [{ name: 'WAN', state: this.wanPlugged ? 'up' : 'down', speed: 1000 }],
      leases: this.clients.map(({ end, ...l }) => ({ ...l, expires: l.ipaddr.endsWith('.20') ? 0 : Math.round((end - Date.now()) / 1000) })),
      staticLeases: [{ name: 'Drucker Führungsraum', mac: '30:05:5c:11:22:33', ip: '192.168.1.20' }],
    };
    const next: RouterState = mapRouterState(snap, { wanName: this.options.wanName, wanInterface: 'wan' }, this.state);
    this.update((s) => Object.assign(s, next));
  }
}
