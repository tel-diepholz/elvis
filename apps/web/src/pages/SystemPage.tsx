import { useQuery } from '@tanstack/react-query';
import { Cpu, History, Palette } from 'lucide-react';
import { SYSTEM_LABELS } from '@elvis/shared';
import { api } from '../lib/api';
import { fmtDateTime, fmtTime } from '../lib/format';
import { useSettings } from '../lib/hooks';
import { useLive } from '../lib/live';
import { CamerasCard } from './system/CamerasCard';
import { DisplaysCard } from './system/DisplaysCard';
import { DocumentFoldersCard } from './system/DocumentFoldersCard';
import { ForcesCard } from './system/ForcesCard';
import { ModulesCard } from './system/ModulesCard';
import { PrintSettingsCard } from './system/PrintSettingsCard';
import { ScanSettingsCard } from './system/ScanSettingsCard';
import { RolesCard } from './system/RolesCard';
import { TaskTemplatesCard } from './system/TaskTemplatesCard';
import { SettingsCard } from './system/SettingsCard';
import { WifiApsCard, WifiCard } from './system/WifiCard';
import { useAuth } from '../lib/auth';
import { applyTheme, useTheme, type Theme } from '../lib/theme';
import { Badge, Card, Dot, PageHeader, Segmented } from '../components/ui';

export function SystemPage() {
  const { devices } = useLive();
  const vehicle = useSettings().data?.vehicle;
  const { data: audit = [] } = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(100) });
  const theme = useTheme();
  const admin = !!useAuth().user?.isAdmin;

  return (
    <>
      <PageHeader title="System" subtitle={vehicle ? `${vehicle.organization} · ${vehicle.callsign}` : undefined} />
      <div className="grid">
        <SettingsCard />
        {admin ? (
          <>
            <ModulesCard />
            <CamerasCard />
            <DisplaysCard />
            <WifiCard />
            <WifiApsCard />
            <DocumentFoldersCard />
            <PrintSettingsCard />
            <ScanSettingsCard />
            <RolesCard />
            <TaskTemplatesCard />
            <ForcesCard />
          </>
        ) : (
          <Card title="Geräte & Treiber" icon={<Cpu size={18} />} className="span-2">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Gerät</th>
                    <th>Bereich</th>
                    <th>Treiber</th>
                    <th>Letzte Daten</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.values(devices).map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="cell-title">
                          <Dot tone={d.online ? 'ok' : 'alarm'} /> {d.name}
                        </div>
                      </td>
                      <td>{SYSTEM_LABELS[d.system]}</td>
                      <td>
                        <Badge tone={d.driver === 'sim' ? 'warn' : 'ok'}>{d.driver === 'sim' ? 'Simulation' : d.driver}</Badge>
                      </td>
                      <td className="mono">{fmtTime(d.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card title="Darstellung" icon={<Palette size={18} />}>
          <Segmented<Theme>
            label="Farbschema"
            value={theme}
            onChange={applyTheme}
            options={[
              { value: 'dark', label: 'Dunkel' },
              { value: 'light', label: 'Hell' },
              { value: 'system', label: 'System' },
            ]}
          />
          <p className="muted">Das dunkle Schema ist für den Nachtbetrieb im Fahrzeug optimiert.</p>
        </Card>

        <Card title="Bedienprotokoll" icon={<History size={18} />} className="span-3">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Bediener</th>
                  <th>Gerät</th>
                  <th>Aktion</th>
                  <th>Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{fmtDateTime(a.timestamp)}</td>
                    <td>{a.operator}</td>
                    <td>{a.target}</td>
                    <td>
                      <code>{a.action}</code> {a.params !== '{}' && <span className="cell-sub">{a.params}</span>}
                    </td>
                    <td>
                      <Badge tone={a.success ? 'ok' : 'alarm'}>{a.success ? 'OK' : 'abgelehnt'}</Badge> {a.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
