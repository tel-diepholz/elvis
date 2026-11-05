import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, ExternalLink, Link2, RefreshCw, Unlink } from 'lucide-react';
import { formatLinkCode, type CloudStatus } from '@elvis/shared';
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
            <button className="btn btn-danger" disabled={unlink.isPending} onClick={() => window.confirm(`Von „${l.node.name}“ trennen?`) && unlink.mutate()}>
              <Unlink size={16} /> Trennen
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
