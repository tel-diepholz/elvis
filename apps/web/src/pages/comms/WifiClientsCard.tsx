import { useMemo } from 'react';
import { Users, Wifi } from 'lucide-react';
import type { DhcpLease, WifiApLive, WifiClient } from '@elvis/shared';
import { fmtMinutes } from '../../lib/format';
import { Badge, Card } from '../../components/ui';

const signalTone = (dbm: number | null) => (dbm === null ? 'muted' : dbm > -65 ? 'ok' : dbm > -75 ? 'warn' : 'alarm');
const mbit = (kbps: number | null) => (kbps === null ? '–' : String(Math.round(kbps / 1000)));
const connected = (sec: number | null) => (sec === null ? '–' : sec < 60 ? '< 1 min' : fmtMinutes(Math.floor(sec / 60)));

/**
 * Geräte in einem WLAN der OpenWrt-APs (Tabelle wifi_clients, vom Modul „WLAN-Accesspoints“ gepflegt). Namen und IPs
 * ergänzt die DHCP-Lease-Liste des Routers (im Gastnetz kennt der AP sie meist nicht, weil er dort selbst keine Adresse hat).
 */
export function WifiClientsCard({ all, aps, network, leases }: { all: WifiClient[]; aps: WifiApLive[]; network: WifiClient['network']; leases: DhcpLease[] | null }) {
  const byMac = useMemo(() => new Map((leases ?? []).map((l) => [l.mac.toLowerCase(), l])), [leases]);
  const clients = all.filter((c) => c.network === network);
  const guest = network === 'guest';
  const ssids = [...new Set(clients.map((c) => c.ssid))];
  // Störungen nur auf einer Karte zeigen; die Geräte nicht erreichbarer APs stehen mit letztem Stand da
  const offline = guest ? [] : aps.filter((a) => !a.online);

  return (
    <Card
      title={guest ? 'Gastnetz-Geräte' : 'WLAN-Clients (Betriebs-WLAN)'}
      icon={guest ? <Users size={18} /> : <Wifi size={18} />}
      className="span-3"
      actions={
        <span className="btn-row">
          {ssids.map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
          <Badge tone="info">{clients.length} verbunden</Badge>
        </span>
      }
    >
      {offline.map((a) => (
        <p key={a.id} className="tone-alarm">
          {a.name} nicht erreichbar{a.error ? `: ${a.error}` : ''} – Geräte mit letztem bekannten Stand
        </p>
      ))}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Gerät</th>
              <th>IP-Adresse</th>
              <th>MAC-Adresse</th>
              <th>Accesspoint</th>
              <th>Signal</th>
              <th>Rate ↓/↑ Mbit/s</th>
              <th>Verbunden</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const lease = byMac.get(c.mac.toLowerCase());
              const name = lease?.name ?? lease?.hostname ?? c.name;
              return (
                <tr key={`${c.apId}-${c.mac}`}>
                  <td>
                    <div className="cell-title">{name ?? <span className="muted">unbekannt</span>}</div>
                  </td>
                  <td className="mono">{lease?.ip ?? c.ip ?? '–'}</td>
                  <td className="mono">{c.mac}</td>
                  <td>
                    {c.apName}
                    {c.band && <div className="cell-sub">{c.band}</div>}
                  </td>
                  <td>
                    <span className={`tone-${signalTone(c.signalDbm)}`}>{c.signalDbm === null ? '–' : `${c.signalDbm} dBm`}</span>
                  </td>
                  <td className="mono">
                    {mbit(c.rxRateKbps)} / {mbit(c.txRateKbps)}
                  </td>
                  <td className="mono">{connected(c.connectedSec)}</td>
                </tr>
              );
            })}
            {clients.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {guest ? 'Keine Geräte im Gastnetz' : 'Keine Geräte im Betriebs-WLAN'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
