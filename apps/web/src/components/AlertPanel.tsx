import { AlertOctagon, AlertTriangle, Info, X } from 'lucide-react';
import { SYSTEM_LABELS, type Alert } from '@elvis/shared';
import { useAlerts } from '../lib/live';
import { fmtTime } from '../lib/format';

const ICONS = { alarm: AlertOctagon, warn: AlertTriangle, info: Info };

export function AlertList({ alerts, compact }: { alerts: Alert[]; compact?: boolean }) {
  if (alerts.length === 0) return <p className="muted">Keine Meldungen – alle Systeme in Ordnung.</p>;
  return (
    <ul className={`alert-list ${compact ? 'compact' : ''}`}>
      {alerts.map((a) => {
        const Icon = ICONS[a.severity];
        return (
          <li key={a.id} className={`alert-item alert-${a.severity}`}>
            <Icon size={18} />
            <div className="alert-text">
              <strong>{a.title}</strong>
              {a.detail && <span>{a.detail}</span>}
            </div>
            <div className="alert-meta">
              <span>{SYSTEM_LABELS[a.system]}</span>
              <span>seit {fmtTime(a.since)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function AlertPanel({ onClose }: { onClose: () => void }) {
  const alerts = useAlerts();
  return (
    <div className="popover-backdrop" onClick={onClose}>
      <div className="popover" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Meldungen">
        <header className="popover-header">
          <h2>Meldungen ({alerts.length})</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Schließen">
            <X size={20} />
          </button>
        </header>
        <AlertList alerts={alerts} />
      </div>
    </div>
  );
}
