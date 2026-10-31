import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AppWindow, ArrowLeft, Boxes, ExternalLink, FileText, Map as MapIcon, Play, Power, RotateCw, Settings2, Square, Trash2, Wrench } from 'lucide-react';
import type { InstalledAddon, OptionValues } from '@elvis/shared';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { OptionsForm, validateOptions } from '../components/OptionsForm';
import { Badge, Card, EmptyState, Loading, Modal, PageHeader, Toggle } from '../components/ui';
import { AddonStatusBadge, OperationSteps } from './addons/common';
import { JobCard } from './addons/JobCard';

const BUSY = new Set(['installing', 'updating', 'removing']);

function ConfigCard({ addon }: { addon: InstalledAddon }) {
  const toast = useToast();
  const [values, setValues] = useState<OptionValues>(addon.options);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setValues(addon.options);
  }, [addon.options, dirty]);
  const errors = validateOptions(addon.manifest?.options ?? {}, values, addon.secretsSet);
  const save = useMutation({
    mutationFn: () => api.reconfigureAddon(addon.id, values),
    onSuccess: () => {
      setDirty(false);
      toast('success', 'Konfiguration wird übernommen – Container werden neu erstellt');
    },
    onError: (e) => toast('error', e.message),
  });
  if (!addon.manifest) return null;
  const busy = BUSY.has(addon.status) || (!!addon.operation && !addon.operation.finishedAt);

  return (
    <Card title="Konfiguration" icon={<Settings2 size={18} />}>
      <OptionsForm
        options={addon.manifest.options}
        values={values}
        onChange={(v) => {
          setValues(v);
          setDirty(true);
        }}
        errors={dirty ? errors : {}}
        secretsSet={addon.secretsSet}
        disabled={busy}
      />
      {Object.keys(addon.manifest.options).length > 0 && (
        <div className="form-actions">
          <button className="btn" disabled={!dirty || save.isPending} onClick={() => (setValues(addon.options), setDirty(false))}>
            Verwerfen
          </button>
          <button className="btn btn-primary" disabled={!dirty || busy || save.isPending || Object.keys(errors).length > 0} onClick={() => save.mutate()}>
            Speichern & übernehmen
          </button>
        </div>
      )}
    </Card>
  );
}

function LogsCard({ addon, target, setTarget }: { addon: InstalledAddon; target: string; setTarget: (t: string) => void }) {
  const [tail, setTail] = useState(200);
  const [auto, setAuto] = useState(false);
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ['addonLogs', addon.id, target, tail],
    queryFn: () => api.addonLogs(addon.id, target, tail),
    refetchInterval: auto ? 3000 : false,
    staleTime: 0,
  });
  return (
    <Card
      title="Protokoll"
      icon={<FileText size={18} />}
      className="span-3"
      actions={
        <button className="btn btn-sm" onClick={() => void refetch()} disabled={isFetching}>
          <RotateCw size={14} /> Aktualisieren
        </button>
      }
    >
      <div className="toolbar">
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Quelle">
          {addon.containers.map((c) => (
            <option key={c.name} value={c.name}>
              Container {c.name}
            </option>
          ))}
          {addon.jobs.map((j) => (
            <option key={j.id} value={`job:${j.id}`}>
              Job {j.label}
            </option>
          ))}
        </select>
        <select value={tail} onChange={(e) => setTail(Number(e.target.value))} aria-label="Zeilen">
          {[100, 200, 500, 2000].map((n) => (
            <option key={n} value={n}>
              letzte {n} Zeilen
            </option>
          ))}
        </select>
        <div className="toolbar-toggle">
          <Toggle label="Automatisch" checked={auto} onChange={setAuto} />
        </div>
      </div>
      {error ? <p className="hint tone-alarm">{(error as Error).message}</p> : <pre className="logs">{data || '(keine Ausgabe)'}</pre>}
    </Card>
  );
}

export function AddonDetailPage() {
  const id = useParams().id!;
  const toast = useToast();
  const navigate = useNavigate();
  const [logTarget, setLogTarget] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeData, setRemoveData] = useState(false);
  const { data: addon, isLoading, error } = useQuery({ queryKey: ['addons', id], queryFn: () => api.addon(id), retry: false });

  const power = useMutation({ mutationFn: (a: 'start' | 'stop' | 'restart') => api.addonPower(id, a), onError: (e) => toast('error', e.message) });
  const update = useMutation({ mutationFn: () => api.updateAddon(id), onError: (e) => toast('error', e.message) });
  const job = useMutation({
    mutationFn: (j: string) => api.runAddonJob(id, j),
    onSuccess: (_, j) => setLogTarget(`job:${j}`),
    onError: (e) => toast('error', e.message),
  });
  const uninstall = useMutation({
    mutationFn: () => api.uninstallAddon(id, removeData),
    onSuccess: () => {
      toast('success', `${addon?.name ?? id} deinstalliert`);
      navigate('/addons');
    },
    onError: (e) => toast('error', e.message),
  });

  if (isLoading) return <Loading />;
  if (!addon) {
    return (
      <EmptyState title="Addon nicht installiert">
        <p>{(error as Error | null)?.message}</p>
        <Link to="/addons" className="btn">
          Zu den Addons
        </Link>
      </EmptyState>
    );
  }

  const busy = BUSY.has(addon.status) || (!!addon.operation && !addon.operation.finishedAt);
  const running = addon.status === 'running' || addon.status === 'partial';
  const target = logTarget ?? addon.containers[0]?.name ?? (addon.jobs[0] ? `job:${addon.jobs[0].id}` : '');

  return (
    <>
      <PageHeader
        title={addon.name}
        subtitle={
          <>
            v{addon.version} · auf <Link to="/docker-hosts">{addon.hostName}</Link> · installiert {fmtDateTime(addon.installedAt)} <AddonStatusBadge status={addon.status} />
          </>
        }
        actions={
          <>
            <Link to="/addons" className="btn">
              <ArrowLeft size={16} /> Addons
            </Link>
            {running ? (
              <button className="btn" disabled={busy || power.isPending} onClick={() => power.mutate('stop')}>
                <Square size={16} /> Stoppen
              </button>
            ) : (
              <button className="btn" disabled={busy || power.isPending} onClick={() => power.mutate('start')}>
                <Power size={16} /> Starten
              </button>
            )}
            <button className="btn" disabled={busy || power.isPending} onClick={() => power.mutate('restart')}>
              <RotateCw size={16} /> Neustart
            </button>
            {addon.availableVersion && (
              <button className="btn btn-primary" disabled={busy || update.isPending} onClick={() => update.mutate()}>
                Auf v{addon.availableVersion} aktualisieren
              </button>
            )}
            <button className="btn btn-danger" disabled={busy} onClick={() => setRemoving(true)}>
              <Trash2 size={16} /> Deinstallieren
            </button>
          </>
        }
      />

      {addon.error && <div className="banner banner-alarm addon-banner">{addon.error}</div>}

      <div className="grid">
        {addon.operation && (
          <Card title="Letzter Vorgang" icon={<Wrench size={18} />} className="span-3">
            <OperationSteps op={addon.operation} />
          </Card>
        )}

        {addon.manifest?.provides.ui && (
          <Card
            title={addon.manifest.provides.ui.name}
            icon={<AppWindow size={18} />}
            className="span-3"
            actions={
              running && (
                <a className="btn btn-sm" href={`/api/addons/${addon.id}/ui/`} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> In neuem Tab öffnen
                </a>
              )
            }
          >
            {running ? <iframe className="addon-ui" src={`/api/addons/${addon.id}/ui/`} title={addon.manifest.provides.ui.name} /> : <p className="muted">Die Oberfläche ist verfügbar, sobald das Addon läuft.</p>}
          </Card>
        )}

        <Card title="Container" icon={<Boxes size={18} />}>
          <ul className="container-list">
            {addon.containers.map((c) => (
              <li key={c.name}>
                <span className="cell-title">{c.name}</span>
                <Badge tone={c.state === 'running' ? 'ok' : c.state === 'missing' ? 'alarm' : 'muted'}>{c.state}</Badge>
                <span className="cell-sub">{c.status}</span>
              </li>
            ))}
          </ul>
          {!!addon.manifest?.provides.mapSources.length && (
            <p className="muted">
              <MapIcon size={14} /> Stellt Kartenstile bereit: {addon.manifest.provides.mapSources.map((s) => s.name).join(', ')}
            </p>
          )}
        </Card>

        <ConfigCard addon={addon} />

        {addon.jobs.length > 0 && (
          <Card title="Jobs" icon={<Play size={18} />} className="span-2">
            {addon.jobs.map((j) => (
              <JobCard key={j.id} job={j} disabled={busy || job.isPending} onRun={() => job.mutate(j.id)} onLogs={() => setLogTarget(`job:${j.id}`)} />
            ))}
          </Card>
        )}

        {target && <LogsCard addon={addon} target={target} setTarget={setLogTarget} />}
      </div>

      <Modal open={removing} title={`${addon.name} deinstallieren`} onClose={() => setRemoving(false)}>
        <div className="form">
          <p>Die Container werden auf „{addon.hostName}“ entfernt.</p>
          <label className="checkbox">
            <input type="checkbox" checked={removeData} onChange={(e) => setRemoveData(e.target.checked)} /> Auch die Daten (Volumes) löschen
          </label>
          {removeData && <p className="hint tone-alarm">Die Daten lassen sich danach nicht wiederherstellen.</p>}
          <div className="form-actions">
            <button className="btn" onClick={() => setRemoving(false)}>
              Abbrechen
            </button>
            <button className="btn btn-danger" disabled={uninstall.isPending} onClick={() => uninstall.mutate()}>
              Deinstallieren
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
