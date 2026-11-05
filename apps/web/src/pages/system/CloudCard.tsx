import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, DatabaseZap, ExternalLink, Link2, RefreshCw, Unlink } from 'lucide-react';
import { RECORD_KINDS, RECORD_KIND_LABELS, formatLinkCode, type CloudStatus, type CloudSyncStatus } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useSettings } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading } from '../../components/ui';

/**
 * Cloud-Zugang: diese Installation mit einem Bereich der Baustruktur im Portal verknüpfen (Code anfordern, ein
 * Verwalter gibt ihn im Portal ein). Danach zeigt das Portal den Zustand der Cloud-Module dieser Installation.
 */
export function CloudCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [name, setName] = useState<string | null>(null);
  // Solange ein Code offen ist, oft nachfragen – der Verwalter gibt ihn gerade im Portal ein
  const { data: s, isFetching, refetch } = useQuery({
    queryKey: ['cloud', 'status'],
    queryFn: () => api.cloudStatus(true),
    refetchInterval: (q) => (q.state.data?.link.state === 'pending' ? 5_000 : false),
  });
  useEffect(() => {
    if (name === null && settings) setName(settings.vehicle.name);
  }, [settings, name]);

  const done = (msg: string) => (next: CloudStatus) => (qc.setQueryData(['cloud', 'status'], next), toast('success', msg));
  const onError = (e: Error) => toast('error', e.message);
  const link = useMutation({ mutationFn: () => api.requestCloudLink(name ?? ''), onSuccess: done('Verknüpfungscode angefordert'), onError });
  const unlink = useMutation({ mutationFn: api.unlinkCloud, onSuccess: done('Von der Cloud getrennt'), onError });

  if (!s) return <Loading />;
  const l = s.link;
  return (
    <Card
      title="Cloud-Zugang"
      icon={<Cloud size={18} />}
      actions={
        <button className="btn btn-sm btn-ghost" onClick={() => void refetch()} disabled={isFetching} aria-label="Neu abfragen">
          <RefreshCw size={16} />
        </button>
      }
    >
      <p className="muted">
        Im Portal <a href={s.portalUrl} target="_blank" rel="noreferrer">{s.portalUrl.replace(/^https?:\/\//, '')}</a> pflegen Verwalter von Landkreis, Gemeinde
        oder Ortsfeuerwehr Stammdaten gemeinsam und sehen den Zustand der Cloud-Module ihrer Installationen (wartende Mails, Chat, App, Backup).
      </p>
      {!s.available && <p className="muted">Die Cloud-Anbindung ist aus (app.relayUrl in config/elvis.json).</p>}
      {s.error && (
        <p>
          <Badge tone="warn">{s.error}</Badge>
        </p>
      )}
      {s.available && l.state === 'none' && (
        <form className="form" onSubmit={(e) => (e.preventDefault(), link.mutate())}>
          <Field label="Name im Portal" hint="Vorgabe ist der Fahrzeugname">
            <input value={name ?? ''} maxLength={80} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <div className="form-actions">
            <button className="btn btn-primary" disabled={link.isPending || !name?.trim()}>
              <Link2 size={16} /> Verknüpfungscode anfordern
            </button>
          </div>
        </form>
      )}
      {l.state === 'pending' && (
        <div className="form">
          <p>Diesen Code im Portal auf der Seite des Bereichs (z. B. der Gemeinde) unter „Installation verknüpfen“ eingeben:</p>
          <p className="cloud-code mono" aria-label="Verknüpfungscode">
            {formatLinkCode(l.code)}
          </p>
          <p className="muted">Gültig bis {fmtDateTime(l.expiresAt)}. Diese Seite merkt die Verknüpfung von selbst.</p>
          <div className="form-actions">
            <a className="btn" href={s.portalUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> Portal öffnen
            </a>
            <button className="btn" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
              Code zurückziehen
            </button>
          </div>
        </div>
      )}
      {l.state === 'linked' && (
        <div className="form">
          <p>
            <Badge tone="ok">Verknüpft</Badge> mit <strong>{l.node.path.join(' › ')}</strong>
          </p>
          <p className="muted">
            seit {fmtDateTime(l.linkedAt)} · von {l.linkedBy}
          </p>
          <div className="form-actions">
            <a className="btn" href={`${s.portalUrl}/knoten/${encodeURIComponent(l.node.id)}`} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> Im Portal öffnen
            </a>
            <button
              className="btn btn-danger"
              disabled={unlink.isPending}
              onClick={() => window.confirm(`Von „${l.node.name}“ trennen? Die Daten aus der Cloud bleiben als lokale (änderbare) erhalten, es wird nichts mehr abgeholt.`) && unlink.mutate()}
            >
              <Unlink size={16} /> Trennen
            </button>
          </div>
          <SyncPanel />
        </div>
      )}
    </Card>
  );
}

const fmt = (iso: string | null) => (iso ? fmtDateTime(iso) : 'noch nie');

/** Stammdaten aus der Cloud: Stand, Hinweise, jetzt bzw. alles neu abholen */
function SyncPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ['cloud', 'sync'], queryFn: api.cloudSync, refetchInterval: 30_000 });
  const action = useMutation({
    mutationFn: api.cloudSyncAction,
    onSuccess: (next: CloudSyncStatus) => {
      qc.setQueryData(['cloud', 'sync'], next);
      if (next.lastError) toast('error', next.lastError);
    },
    onError: (e: Error) => toast('error', e.message),
  });
  if (!s) return null;
  return (
    <section className="form cloud-sync" aria-label="Stammdaten aus der Cloud">
      <h3>
        <DatabaseZap size={16} /> Stammdaten aus der Cloud
      </h3>
      <p className="muted">
        Kräfte, Einsatzstichworte, Rollen, Benutzer (ohne PIN), Aufgabenvorlagen und die Objektbibliothek aus dem Portal werden hier mit „Quelle: Cloud“ angezeigt und sind
        nur lesbar – gepflegt werden sie im Portal. Lokale Einträge bleiben lokal und gehen nicht in die Cloud.
      </p>
      <p>
        {s.lastError ? <Badge tone="warn">{s.lastError}</Badge> : <Badge tone="ok">Aktiv</Badge>} <span className="muted">zuletzt erfolgreich {fmt(s.lastSuccessAt)} · jede Minute</span>
      </p>
      <table className="table cloud-sync-counts">
        <thead>
          <tr>
            <th />
            <th>aus der Cloud</th>
            <th>lokal</th>
          </tr>
        </thead>
        <tbody>
          {RECORD_KINDS.map((k) => (
            <tr key={k}>
              <td>{RECORD_KIND_LABELS[k]}</td>
              <td>{s.counts[k].cloud}</td>
              <td>{s.counts[k].local}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.notices.length > 0 && (
        <details>
          <summary>{s.notices.length} Hinweise</summary>
          <ul className="simple-list">
            {s.notices.map((c, i) => (
              <li key={i}>
                <div className="grow">
                  <div className="cell-title">
                    {RECORD_KIND_LABELS[c.kind]}: {c.name}
                  </div>
                  <div className="cell-sub">
                    {fmtDateTime(c.at)} · {c.reason}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="form-actions">
        <button className="btn" disabled={action.isPending} onClick={() => action.mutate('run')}>
          <RefreshCw size={16} /> Jetzt abholen
        </button>
        <button className="btn" disabled={action.isPending} title="Alles aus der Cloud erneut abholen, z. B. nachdem ein gleichnamiger lokaler Eintrag entfernt wurde" onClick={() => action.mutate('resync')}>
          Alles neu abholen
        </button>
      </div>
    </section>
  );
}
