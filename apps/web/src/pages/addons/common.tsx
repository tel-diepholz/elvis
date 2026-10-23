import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react';
import type { AddonOperation, AddonStatus } from '@elvis/shared';
import { Badge, type Tone } from '../../components/ui';

export const ADDON_STATUS: Record<AddonStatus, { label: string; tone: Tone }> = {
  installing: { label: 'Wird installiert', tone: 'info' },
  running: { label: 'Läuft', tone: 'ok' },
  stopped: { label: 'Gestoppt', tone: 'muted' },
  partial: { label: 'Teilweise aktiv', tone: 'warn' },
  waiting: { label: 'Wartet auf Job', tone: 'info' },
  error: { label: 'Fehler', tone: 'alarm' },
  updating: { label: 'Wird aktualisiert', tone: 'info' },
  removing: { label: 'Wird entfernt', tone: 'info' },
};

export function AddonStatusBadge({ status }: { status: AddonStatus }) {
  const s = ADDON_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const STEP_ICON = {
  pending: <CircleDashed size={16} className="tone-muted" />,
  running: <Loader2 size={16} className="tone-info spin" />,
  done: <CheckCircle2 size={16} className="tone-ok" />,
  error: <XCircle size={16} className="tone-alarm" />,
};

export function OperationSteps({ op }: { op: AddonOperation }) {
  return (
    <div className="operation">
      <div className="operation-head">
        <strong>{op.label}</strong>
        {op.finishedAt ? <Badge tone={op.error ? 'alarm' : 'ok'}>{op.error ? 'fehlgeschlagen' : 'abgeschlossen'}</Badge> : <Badge tone="info">läuft …</Badge>}
      </div>
      <ul className="steps">
        {op.steps.map((s, i) => (
          <li key={i} className={`step step-${s.state}`}>
            {STEP_ICON[s.state]}
            <span>{s.label}</span>
            {s.detail && <span className="step-detail">{s.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
