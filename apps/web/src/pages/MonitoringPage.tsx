import { Activity, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { MONITORING_KIND_LABELS } from '@elvis/shared';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtTime } from '../lib/format';
import { useCommand } from '../lib/hooks';
import { useDevice } from '../lib/live';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { MetricList, TargetBadge } from '../components/monitoring';
import { Card, EmptyState, PageHeader } from '../components/ui';

/** Zustand aller Monitoring-Ziele (live vom Modul „Monitoring“) */
export function MonitoringPage() {
  const monitoring = useDevice('monitoring');
  const user = useAuth().user;
  const { send, pending } = useCommand('monitoring');
  if (!monitoring) return <ModuleDisabled name="Monitoring" />;
  const targets = monitoring.state.targets;

  return (
    <>
      <PageHeader
        title="Monitoring"
        subtitle="Drucker, Rechner und weitere Geräte im Fahrzeugnetz"
        actions={
          user && (
            <button type="button" className="btn" disabled={pending} onClick={() => send('refresh')}>
              <RefreshCw size={16} /> Jetzt abfragen
            </button>
          )
        }
      />
      {targets.length === 0 ? (
        <EmptyState icon={<Activity size={32} />} title="Keine Geräte überwacht">
          {user?.isAdmin ? (
            <>
              Ziele unter <Link to="/system">System → Monitoring</Link> anlegen.
            </>
          ) : (
            'Ein Admin kann die Geräte in den Systemeinstellungen eintragen.'
          )}
        </EmptyState>
      ) : (
        <div className="grid">
          {targets.map((t) => (
            <Card key={t.id} title={t.name} icon={<Activity size={18} />} actions={<TargetBadge target={t} />}>
              <p className="cell-sub">
                {MONITORING_KIND_LABELS[t.kind]}
                {t.description && ` · ${t.description}`}
                {!t.alwaysOn && ' · nicht dauerhaft eingeschaltet'}
              </p>
              {t.reachable === false && (
                <p className={t.alwaysOn ? 'tone-alarm' : 'muted'}>
                  {t.error}
                  {t.seenAt ? ` – Werte vom ${fmtDateTime(t.seenAt)}` : ''}
                </p>
              )}
              <MetricList metrics={t.metrics} stale={t.reachable === false} />
              {t.checkedAt && <p className="cell-sub">abgefragt {fmtTime(t.checkedAt)}</p>}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
