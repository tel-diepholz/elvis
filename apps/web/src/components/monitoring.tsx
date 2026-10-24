import type { MonitoringMetric, MonitoringSeverity, MonitoringTargetLive } from '@elvis/shared';
import { Badge, Dot, type Tone } from './ui';

export const SEVERITY_TONE: Record<MonitoringSeverity, Tone> = { ok: 'ok', info: 'info', warn: 'warn', alarm: 'alarm' };

const RANK: Record<MonitoringSeverity, number> = { ok: 0, info: 1, warn: 2, alarm: 3 };

/** Gesamtzustand eines Ziels; nicht erreichbare Geräte ohne Daueranspruch gelten als ausgeschaltet */
export function targetStatus(t: MonitoringTargetLive): { tone: Tone; label: string } {
  if (t.reachable === null) return { tone: 'muted', label: t.error ? 'keine Antwort' : 'wird abgefragt …' };
  if (!t.reachable) return t.alwaysOn ? { tone: 'alarm', label: 'nicht erreichbar' } : { tone: 'muted', label: 'ausgeschaltet' };
  const problems = t.metrics.filter((m) => m.severity !== 'ok');
  if (!problems.length) return { tone: 'ok', label: 'in Ordnung' };
  const worst = problems.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a));
  return { tone: SEVERITY_TONE[worst.severity], label: problems.length === 1 ? '1 Auffälligkeit' : `${problems.length} Auffälligkeiten` };
}

export function TargetBadge({ target }: { target: MonitoringTargetLive | undefined }) {
  if (!target) return <Badge>nicht abgefragt</Badge>;
  const s = targetStatus(target);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Messwerte als Liste; stale = Werte der letzten erfolgreichen Abfrage (Gerät gerade nicht erreichbar) */
export function MetricList({ metrics, stale = false }: { metrics: MonitoringMetric[]; stale?: boolean }) {
  if (!metrics.length) return <p className="muted">Keine Messwerte.</p>;
  return (
    <ul className={`metric-list ${stale ? 'is-stale' : ''}`}>
      {metrics.map((m) => (
        <li key={m.id}>
          <Dot tone={stale ? 'muted' : SEVERITY_TONE[m.severity]} />
          <span className="metric-label">{m.label}</span>
          <span className="metric-value mono">{m.text}</span>
          {m.problem && m.problem !== m.text && <span className="metric-problem cell-sub">{m.problem}</span>}
        </li>
      ))}
    </ul>
  );
}
