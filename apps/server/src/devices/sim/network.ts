import { z } from 'zod';
import type { NetworkState } from '@elvis/shared';
import { CommandError, command } from '../adapter.js';
import { SimAdapter, clamp, drift, jitter, round } from './sim-adapter.js';

/** Fahrzeugrouter mit mehreren WAN-Uplinks. Real driver: Router-API / SNMP. */
export class NetworkSim extends SimAdapter<'network'> {
  protected readonly commands = {
    'uplink.primary': command(z.object({ id: z.string() }), ({ id }) => {
      const up = this.state.uplinks.find((u) => u.id === id);
      if (!up) throw new CommandError(`Unbekannter Uplink ${id}`, 404);
      if (!up.online) throw new CommandError(`${up.name} ist offline`);
      this.update((s) => void (s.primaryUplinkId = id));
      return `Primärer Uplink: ${up.name}`;
    }),
    'wlan.guest': command(z.object({ on: z.boolean() }), ({ on }) => {
      this.update((s) => void (s.wlan.guestEnabled = on));
    }),
  };

  constructor() {
    super('network', {
      internet: true,
      primaryUplinkId: '5g-1',
      uplinks: [
        { id: '5g-1', name: '5G Modem 1', kind: '5g', provider: 'Telekom', online: true, signalPercent: 78, rxMbps: 0, txMbps: 0, latencyMs: 28 },
        { id: 'lte-2', name: 'LTE Modem 2', kind: 'lte', provider: 'Vodafone', online: true, signalPercent: 64, rxMbps: 0, txMbps: 0, latencyMs: 41 },
        { id: 'sat-1', name: 'Satellit', kind: 'sat', provider: 'Starlink', online: true, signalPercent: 90, rxMbps: 0, txMbps: 0, latencyMs: 45 },
      ],
      wlan: { ssid: 'ELW2-Einsatz', clients: 6, guestEnabled: false },
      vpn: { connected: true, peer: 'Leitstelle / Kreis-VPN' },
      dataUsageGb: 3.42,
    } satisfies NetworkState);
  }

  protected tick(dt: number): void {
    this.update((s) => {
      for (const u of s.uplinks) {
        if (u.kind !== 'sat' && Math.random() < 0.003) u.online = !u.online;
        u.signalPercent = u.online ? Math.round(clamp(drift(u.signalPercent, u.kind === 'sat' ? 90 : 70, 3), 5, 100)) : 0;
        u.latencyMs = u.online ? Math.round(clamp(drift(u.latencyMs ?? 40, u.kind === 'sat' ? 45 : 30, 4), 10, 400)) : null;
      }
      // Automatic failover if the primary drops.
      const online = s.uplinks.filter((u) => u.online);
      if (!online.some((u) => u.id === s.primaryUplinkId) && online[0]) s.primaryUplinkId = online[0].id;
      s.internet = online.length > 0;

      for (const u of s.uplinks) {
        const primary = u.id === s.primaryUplinkId && u.online;
        u.rxMbps = primary ? round(clamp(8 + jitter(6), 0.2, 200)) : u.online ? round(Math.random() * 0.1, 2) : 0;
        u.txMbps = primary ? round(clamp(2 + jitter(1.5), 0.1, 50)) : 0;
      }
      const totalMbps = s.uplinks.reduce((a, u) => a + u.rxMbps + u.txMbps, 0);
      s.dataUsageGb = round(s.dataUsageGb + (totalMbps * dt) / 8 / 1024, 3);
      s.wlan.clients = Math.round(clamp(s.wlan.clients + (Math.random() < 0.02 ? Math.sign(jitter(1)) : 0), 0, 40));
      s.vpn.connected = s.internet && (s.vpn.connected || Math.random() < 0.2);
    });
  }
}
