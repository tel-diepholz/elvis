import { CalendarClock, CheckCircle2, CircleDashed, FileText, Loader2, Play, XCircle } from 'lucide-react';
import type { AddonJobState, AddonJobStepState } from '@elvis/shared';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { Badge, type Tone } from '../../components/ui';

const INTERVAL: Record<string, string> = { never: 'nie', daily: 'täglich', weekly: 'wöchentlich', monthly: 'monatlich' };

const STATE: Record<AddonJobState['state'], { label: string; tone: Tone }> = {
  idle: { label: 'noch nicht ausgeführt', tone: 'muted' },
  running: { label: 'läuft', tone: 'info' },
  succeeded: { label: 'erfolgreich', tone: 'ok' },
  failed: { label: 'fehlgeschlagen', tone: 'alarm' },
  interrupted: { label: 'unterbrochen', tone: 'warn' },
};

/** Fortschrittsbalken; ohne Prozentwert als unbestimmter (laufender) Balken. */
export function ProgressBar({ percent, tone = 'info', label }: { percent: number | null; tone?: Tone; label: string }) {
  const indeterminate = percent === null;
  return (
    <div
      className={`progress ${indeterminate ? 'indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
    >
      <div className={`progress-fill tone-bg-${tone}`} style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

const STEP_ICON: Record<AddonJobStepState['state'], JSX.Element> = {
  pending: <CircleDashed size={16} className="tone-muted" />,
  running: <Loader2 size={16} className="tone-info spin" />,
  done: <CheckCircle2 size={16} className="tone-ok" />,
  error: <XCircle size={16} className="tone-alarm" />,
};

export function JobCard({ job, disabled, onRun, onLogs }: { job: AddonJobState; disabled: boolean; onRun: () => void; onLogs: () => void }) {
  const st = STATE[job.state];
  const running = job.state === 'running';
  const current = job.steps.find((s) => s.state === 'running');
  return (
    <div className={`job ${running ? 'job-running' : ''}`}>
      <div className="job-head">
        <div>
          <strong>{job.label}</strong>
          {job.description && <div className="cell-sub">{job.description}</div>}
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>

      {(running || job.state === 'failed') && (
        <div className="job-progress">
          <div className="job-progress-head">
            <span>{running ? (current ? `${current.label}${current.message ? ` – ${current.message}` : ''}` : 'Startet …') : 'Abgebrochen'}</span>
            <strong className="mono">{job.percent !== null ? `${fmtNum(job.percent, 0)} %` : ''}</strong>
          </div>
          <ProgressBar percent={job.percent} tone={job.state === 'failed' ? 'alarm' : 'info'} label={`Fortschritt ${job.label}`} />
        </div>
      )}

      {job.steps.length > 1 && (running || job.state !== 'idle') && (
        <ol className="job-steps">
          {job.steps.map((s, i) => (
            <li key={i} className={`job-step step-${s.state}`}>
              {STEP_ICON[s.state]}
              <span className="job-step-label">{s.label}</span>
              {s.state === 'running' && <ProgressBar percent={s.percent} label={s.label} />}
              {s.state === 'running' && s.percent !== null && <span className="mono job-step-pct">{fmtNum(s.percent, 0)} %</span>}
              {s.state === 'error' && s.message && <span className="job-step-error">{s.message}</span>}
            </li>
          ))}
        </ol>
      )}

      <dl className="kv job-meta">
        {job.startedAt && (
          <>
            <dt>Letzter Lauf</dt>
            <dd>
              {fmtDateTime(job.startedAt)}
              {job.triggeredBy ? ` · ${job.triggeredBy}` : ''}
            </dd>
          </>
        )}
        {job.lastSuccessAt && job.state !== 'succeeded' && (
          <>
            <dt>Zuletzt erfolgreich</dt>
            <dd>{fmtDateTime(job.lastSuccessAt)}</dd>
          </>
        )}
        {job.schedule && (
          <>
            <dt>
              <CalendarClock size={14} /> Zeitplan
            </dt>
            <dd>
              {job.schedule.interval === 'never'
                ? 'nur manuell'
                : `${INTERVAL[job.schedule.interval]} um ${String(job.schedule.hour).padStart(2, '0')}:00 Uhr${job.schedule.nextRun ? ` · nächster Lauf ${fmtDateTime(job.schedule.nextRun)}` : ''}`}
            </dd>
          </>
        )}
      </dl>

      <div className="btn-row">
        <button className="btn btn-sm" disabled={disabled || running} onClick={onRun}>
          <Play size={14} /> {running ? 'Läuft …' : 'Jetzt ausführen'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onLogs}>
          <FileText size={14} /> Protokoll
        </button>
      </div>
    </div>
  );
}
