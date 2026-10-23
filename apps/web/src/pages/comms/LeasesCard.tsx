import { useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import type { DeviceSnapshot } from '@elvis/shared';
import { fmtMinutes } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { Badge, Card } from '../../components/ui';

const ipKey = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + (Number(o) || 0), 0);

/** Vom Router vergebene DHCP-Leases (IPv4) als durchsuchbare Tabelle. */
export function LeasesCard({ router }: { router: DeviceSnapshot<'router'> }) {
  const now = useNow();
  const [filter, setFilter] = useState('');
  const leases = router.state.leases;
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = leases ?? [];
    return (q ? list.filter((l) => [l.name, l.hostname, l.ip, l.mac, l.interface].some((v) => v?.toLowerCase().includes(q))) : list).slice().sort((a, b) => ipKey(a.ip) - ipKey(b.ip));
  }, [leases, filter]);

  return (
    <Card title="DHCP-Leases" icon={<Network size={18} />} className="span-3" actions={leases && <Badge tone="info">{leases.length} vergeben</Badge>}>
      {leases === null ? (
        <p className="muted">Der Router liefert keine DHCP-Leases (DHCP-Server aus oder Firmware ohne diese Abfrage).</p>
      ) : (
        <>
          {leases.length > 8 && (
            <input className="leases-filter" type="search" placeholder="Suchen nach Name, IP oder MAC …" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Leases durchsuchen" />
          )}
          <div className={`table-wrap ${router.online ? '' : 'stale'}`}>
            <table className="table">
              <thead>
                <tr>
                  <th>Gerät</th>
                  <th>IP-Adresse</th>
                  <th>MAC-Adresse</th>
                  <th>Netz</th>
                  <th>Zuweisung</th>
                  <th>Läuft ab</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => {
                  const minutes = l.expiresAt ? Math.max(0, Math.round((new Date(l.expiresAt).getTime() - now.getTime()) / 60_000)) : null;
                  return (
                    <tr key={`${l.mac}-${l.ip}`}>
                      <td>
                        <div className="cell-title">{l.name ?? l.hostname ?? <span className="muted">unbekannt</span>}</div>
                        {l.name && l.hostname && l.name !== l.hostname && <div className="cell-sub">{l.hostname}</div>}
                      </td>
                      <td className="mono">{l.ip}</td>
                      <td className="mono">{l.mac}</td>
                      <td>{l.interface ?? '–'}</td>
                      <td>
                        <Badge tone={l.static ? 'info' : 'muted'}>{l.static ? 'fest' : 'dynamisch'}</Badge>
                      </td>
                      <td className="mono">{minutes === null ? 'unbegrenzt' : minutes < 1 ? '< 1 min' : fmtMinutes(minutes)}</td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      {filter ? 'Keine Treffer' : 'Keine Leases vergeben'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
