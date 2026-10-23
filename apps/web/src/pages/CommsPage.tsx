import { useQuery } from '@tanstack/react-query';
import { Globe, Lock, Radio, Satellite, Signal, Wifi } from 'lucide-react';
import type { RadioDevice } from '@elvis/shared';
import { FMS_STATUS } from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCommand } from '../lib/hooks';
import { useDevice } from '../lib/live';
import { fmtNum, fmtTime } from '../lib/format';
import { UPLINK_KIND } from '../lib/labels';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { LeasesCard } from './comms/LeasesCard';
import { RouterCard } from './comms/RouterCard';
import { WifiClientsCard } from './comms/WifiClientsCard';
import { Badge, Card, Dot, Meter, PageHeader, Toggle } from '../components/ui';

function rssiTone(rssi: number | null) {
  if (rssi === null) return 'muted' as const;
  return rssi > -85 ? ('ok' as const) : rssi > -98 ? ('warn' as const) : ('alarm' as const);
}

function RadioRow({ d }: { d: RadioDevice }) {
  const radio = useDevice('radio')!;
  const { send, pending } = useCommand('radio');
  const activity = d.transmitting ? 'TX' : d.receiving ? 'RX' : null;
  return (
    <tr className={d.online ? '' : 'row-muted'}>
      <td>
        <div className="cell-title">
          <Dot tone={d.online ? 'ok' : 'alarm'} />
          {d.name}
        </div>
        <div className="cell-sub">
          {d.type} · ISSI {d.issi}
          {d.workplace ? ` · ${d.workplace}` : ''}
        </div>
      </td>
      <td>
        {d.type === 'HRT' ? (
          radio.state.talkgroups.find((t) => t.id === d.talkgroupId)?.name
        ) : (
          <select
            value={d.talkgroupId}
            disabled={pending || !d.online}
            onChange={(e) =>
              send('talkgroup.set', {
                deviceId: d.id,
                talkgroupId: e.target.value,
              })
            }
            aria-label={`Rufgruppe ${d.name}`}
          >
            {radio.state.talkgroups.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.mode})
              </option>
            ))}
          </select>
        )}
      </td>
      <td>
        <Badge tone={d.mode === 'DMO' ? 'info' : 'muted'}>{d.mode}</Badge>
      </td>
      <td>
        <span className={`tone-${rssiTone(d.rssiDbm)}`}>{d.rssiDbm !== null ? `${d.rssiDbm} dBm` : '–'}</span>
      </td>
      <td>{activity ? <Badge tone={activity === 'TX' ? 'alarm' : 'ok'}>{activity}</Badge> : <span className="muted">{d.lastActivity ? fmtTime(d.lastActivity) : '–'}</span>}</td>
      <td>
        {d.type === 'MRT' ? (
          <select
            value={d.fmsStatus ?? ''}
            disabled={pending || !d.online}
            onChange={(e) =>
              send('status.set', {
                deviceId: d.id,
                status: Number(e.target.value),
              })
            }
            aria-label="Fahrzeugstatus"
          >
            {[1, 2, 3, 4, 6].map((s) => (
              <option key={s} value={s}>
                {s} – {FMS_STATUS[s]!.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted">–</span>
        )}
      </td>
    </tr>
  );
}

export function CommsPage() {
  const radio = useDevice('radio');
  const net = useDevice('network');
  const router = useDevice('router');
  const { send, pending } = useCommand('network');
  const n = net?.state;
  // WLAN-Geräte (Modul „WLAN-Accesspoints“): nur angemeldet, wegen MAC-Adressen und Gerätenamen
  const wifiModule = useDevice('wifi');
  const loggedIn = !!useAuth().user;
  const showWifi = loggedIn && !!wifiModule?.state.aps.length;
  const { data: wifiClients = [] } = useQuery({ queryKey: ['wifiClients'], queryFn: api.wifiClients, enabled: showWifi, refetchInterval: 10_000 });
  const header = <PageHeader title="Netzwerk" subtitle="Router, Datenverbindungen, Fahrzeugnetz und Digitalfunk" />;
  if (!radio && !n && !router && !showWifi)
    return (
      <>
        {header}
        <ModuleDisabled name="Router, Digitalfunk und Netzwerk" />
      </>
    );

  return (
    <>
      {header}
      <div className="grid">
        {router && <RouterCard router={router} />}
        {showWifi && <WifiClientsCard all={wifiClients} aps={wifiModule.state.aps} network="ops" leases={router?.state.leases ?? null} />}
        {showWifi && <WifiClientsCard all={wifiClients} aps={wifiModule.state.aps} network="guest" leases={router?.state.leases ?? null} />}
        {router && <LeasesCard router={router} />}
        {radio && (
          <Card title="Digitalfunk" icon={<Radio size={18} />} className="span-3">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Gerät</th>
                    <th>Rufgruppe</th>
                    <th>Modus</th>
                    <th>Pegel</th>
                    <th>Aktivität</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {radio.state.devices.map((d) => (
                    <RadioRow key={d.id} d={d} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {n && (
          <>
            <Card
              title="Datenverbindungen"
              icon={<Globe size={18} />}
              className="span-2"
              actions={<Badge tone={n.internet ? 'ok' : 'alarm'}>{n.internet ? 'Internet verfügbar' : 'Kein Internet'}</Badge>}
            >
              <div className="uplinks">
                {n.uplinks.map((u) => {
                  const primary = u.id === n.primaryUplinkId;
                  return (
                    <div key={u.id} className={`uplink ${primary ? 'primary' : ''} ${u.online ? '' : 'offline'}`}>
                      <div className="uplink-head">
                        {u.kind === 'sat' ? <Satellite size={20} /> : <Signal size={20} />}
                        <div>
                          <strong>{u.name}</strong>
                          <div className="cell-sub">
                            {UPLINK_KIND[u.kind]} · {u.provider}
                          </div>
                        </div>
                        {primary && <Badge tone="info">Primär</Badge>}
                      </div>
                      <Meter value={u.signalPercent} tone={u.signalPercent > 50 ? 'ok' : u.signalPercent > 20 ? 'warn' : 'alarm'} label={`Signal ${u.name}`} />
                      <dl className="kv">
                        <dt>Signal</dt>
                        <dd>{u.online ? `${u.signalPercent} %` : 'offline'}</dd>
                        <dt>Durchsatz</dt>
                        <dd>
                          ↓ {fmtNum(u.rxMbps)} / ↑ {fmtNum(u.txMbps)} Mbit/s
                        </dd>
                        <dt>Latenz</dt>
                        <dd>{u.latencyMs !== null ? `${u.latencyMs} ms` : '–'}</dd>
                      </dl>
                      <button className="btn btn-sm" disabled={pending || primary || !u.online} onClick={() => send('uplink.primary', { id: u.id })}>
                        Als primär setzen
                      </button>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card title="Fahrzeugnetz" icon={<Wifi size={18} />}>
              <dl className="kv">
                <dt>WLAN</dt>
                <dd>{n.wlan.ssid}</dd>
                <dt>Clients</dt>
                <dd>{n.wlan.clients}</dd>
                <dt>VPN</dt>
                <dd className={n.vpn.connected ? 'tone-ok' : 'tone-warn'}>
                  <Lock size={14} /> {n.vpn.connected ? 'verbunden' : 'getrennt'} · {n.vpn.peer}
                </dd>
                <dt>Datenvolumen</dt>
                <dd>{fmtNum(n.dataUsageGb, 2)} GB</dd>
              </dl>
              <Toggle label="Gast-WLAN" checked={n.wlan.guestEnabled} disabled={pending} onChange={(on) => send('wlan.guest', { on })} />
            </Card>
          </>
        )}
      </div>
    </>
  );
}
