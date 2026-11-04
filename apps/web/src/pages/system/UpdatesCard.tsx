import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import type { UpdateStatus } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import { useActiveIncident } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Markdown } from '../../components/messages/Markdown';
import { Badge, Card, Loading, Modal } from '../../components/ui';

const RUNNING: UpdateStatus['phase'][] = ['downloading', 'verifying', 'installing'];

/**
 * Einstellungen → Update (ELVIS lite unter Windows): nach Updates suchen und installieren. Während der Installation
 * ist der Server kurz weg; danach lädt die Seite neu, sobald die neue Version antwortet.
 */
export function UpdatesCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const incident = useActiveIncident().data;
  const [confirm, setConfirm] = useState(false);
  const { data: s } = useQuery({
    queryKey: ['updates'],
    queryFn: api.updateStatus,
    refetchInterval: (q) => (q.state.data && RUNNING.includes(q.state.data.phase) ? 1000 : false),
  });
  const check = useMutation({ mutationFn: api.checkUpdates, onSuccess: (r) => qc.setQueryData(['updates'], r), onError: (e) => toast('error', e.message) });
  const install = useMutation({
    mutationFn: api.installUpdate,
    onSuccess: (r) => {
      setConfirm(false);
      qc.setQueryData(['updates'], r);
    },
    onError: (e) => toast('error', e.message),
  });
  useRestartWatch(s);

  if (!s) return <Loading />;
  const running = RUNNING.includes(s.phase);
  const badge = running ? <Badge tone="info">Update läuft …</Badge> : s.available ? <Badge tone="warn">Update verfügbar</Badge> : s.checkedAt && !s.checkError ? <Badge tone="ok">Aktuell</Badge> : null;

  return (
    <Card title="Update" icon={<Download size={18} />} actions={badge}>
      <dl className="kv">
        <dt>Installierte Version</dt>
        <dd>{s.current}</dd>
        {s.checkedAt && (
          <>
            <dt>Zuletzt gesucht</dt>
            <dd>{fmtDateTime(s.checkedAt)}</dd>
          </>
        )}
      </dl>
      {s.lastResult && <LastResult r={s.lastResult} />}
      {s.checkError && <p className="tone-alarm">{s.checkError}</p>}
      {s.checkedAt && !s.checkError && !s.available && <p className="muted">ELVIS ist auf dem neuesten Stand.</p>}

      {s.available && s.latest && (
        <div className="update-release">
          <h4>
            Neue Version {s.latest.version}
            <span className="muted"> · {fmtDateTime(s.latest.publishedAt)} · {fmtBytes(s.latest.size)}</span>
          </h4>
          {s.latest.notes ? <Markdown text={s.latest.notes} /> : <p className="muted">Keine Hinweise zu dieser Version.</p>}
          <a href={s.latest.url} target="_blank" rel="noreferrer">
            Release auf GitHub
          </a>
        </div>
      )}

      {running && <Progress s={s} />}
      {s.phase === 'failed' && <p className="tone-alarm">Update fehlgeschlagen: {s.message}</p>}
      {s.available && !s.installable && s.reason && <p className="muted">{s.reason}</p>}

      <div className="form-actions">
        <button className="btn" disabled={check.isPending || running} onClick={() => check.mutate()}>
          <RefreshCw size={16} /> {check.isPending ? 'Suche …' : 'Nach Updates suchen'}
        </button>
        {s.available && s.installable && (
          <button className="btn btn-primary" disabled={running || install.isPending} onClick={() => setConfirm(true)}>
            <Download size={16} /> Update installieren
          </button>
        )}
      </div>

      <Modal open={confirm} title={`Update auf ${s.latest?.version ?? ''} installieren`} onClose={() => setConfirm(false)}>
        {incident && (
          <p className="tone-alarm">
            <strong>Achtung: Eine Lage ist aufgelegt.</strong> ELVIS ist während des Updates einige Minuten nicht erreichbar – auch nicht für Tablets.
          </p>
        )}
        <p>
          ELVIS lädt die neue Version, prüft ihre Signatur, sichert die Datenbank und startet neu. Kommt die neue Version nicht hoch, wird die bisherige Version
          automatisch wiederhergestellt.
        </p>
        <div className="form-actions">
          <button className="btn" onClick={() => setConfirm(false)}>
            Abbrechen
          </button>
          <button className={`btn ${incident ? 'btn-danger' : 'btn-primary'}`} disabled={install.isPending} onClick={() => install.mutate()}>
            {incident ? 'Trotz laufender Lage installieren' : 'Jetzt installieren'}
          </button>
        </div>
      </Modal>
    </Card>
  );
}

function Progress({ s }: { s: UpdateStatus }) {
  const percent = s.progress === null ? null : Math.round(s.progress * 100);
  return (
    <div className="update-progress">
      <div className={`progress ${percent === null ? 'indeterminate' : ''}`}>
        <div className="progress-fill tone-bg-info" style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      <span className="muted">
        {s.message}
        {percent !== null && ` ${percent} %`}
      </span>
    </div>
  );
}

function LastResult({ r }: { r: NonNullable<UpdateStatus['lastResult']> }) {
  if (r.ok) return <p className="tone-ok">Letztes Update ({fmtDateTime(r.at)}): {r.from} → {r.to} erfolgreich.</p>;
  return (
    <p className="tone-alarm">
      Letztes Update ({fmtDateTime(r.at)}) auf {r.to} ist fehlgeschlagen
      {r.rolledBack ? ` – Version ${r.from} und die Datenbank wurden wiederhergestellt.` : '.'} Protokolle: %ProgramData%\ELVIS lite\logs
    </p>
  );
}

/** Während der Installation: warten, bis der Server mit einer anderen Version antwortet, dann neu laden */
function useRestartWatch(s: UpdateStatus | undefined) {
  const installing = s?.phase === 'installing';
  const from = s?.current;
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(async () => {
      try {
        const info = (await (await fetch('/api/info', { cache: 'no-store' })).json()) as { version?: string };
        if (info.version && info.version !== from) window.location.reload();
      } catch {
        // Server startet gerade neu
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [installing, from]);
}
