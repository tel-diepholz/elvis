import { useQuery } from '@tanstack/react-query';
import { Globe, Lock, Satellite, Signal, Wifi } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCommand } from '../lib/hooks';
import { useDevice } from '../lib/live';
import { fmtNum } from '../lib/format';
import { UPLINK_KIND } from '../lib/labels';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { LeasesCard } from './comms/LeasesCard';
import { RouterCard } from './comms/RouterCard';
import { WifiClientsCard } from './comms/WifiClientsCard';
import { Badge, Card, Meter, PageHeader, Toggle } from '../components/ui';

export function CommsPage() {
  const net = useDevice('network');
  const router = useDevice('router');
  const { send, pending } = useCommand('network');
  const n = net?.state;
  // WLAN-Geräte (Modul „WLAN-Accesspoints“): nur angemeldet, wegen MAC-Adressen und Gerätenamen
  const wifiModule = useDevice('wifi');
  const loggedIn = !!useAuth().user;
  const showWifi = loggedIn && !!wifiModule?.state.aps.length;
  const { data: wifiClients = [] } = useQuery({ queryKey: ['wifiClients'], queryFn: api.wifiClients, enabled: showWifi, refetchInterval: 10_000 });
  const header = <PageHeader title="Netzwerk" subtitle="Router, Datenverbindungen und Fahrzeugnetz" />;
  if (!n && !router && !showWifi)
    return (
      <>
        {header}
        <ModuleDisabled name="Router und Netzwerk" />
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
