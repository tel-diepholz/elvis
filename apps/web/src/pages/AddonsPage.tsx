import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Package, PackagePlus, RefreshCw, ShieldAlert } from 'lucide-react';
import { defaultOptionValues, renderTemplate, requestedPermissions, type AddonManifest, type AddonStoreEntry, type DockerHost, type OptionValues } from '@elvis/shared';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { OptionsForm, validateOptions } from '../components/OptionsForm';
import { Badge, Card, EmptyState, Field, Loading, Modal, PageHeader, Segmented } from '../components/ui';
import { AddonStatusBadge } from './addons/common';

function InstallDialog({ manifest, hosts, onClose }: { manifest: AddonManifest; hosts: DockerHost[]; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const usable = hosts.filter((h) => h.status === 'ready' && (!h.arch || manifest.arch.includes(h.arch)));
  const [hostId, setHostId] = useState<number | null>(usable[0]?.id ?? null);
  const [values, setValues] = useState<OptionValues>(() => defaultOptionValues(manifest.options));
  const [touched, setTouched] = useState(false);
  const errors = validateOptions(manifest.options, values);
  const host = hosts.find((h) => h.id === hostId);

  // Rechte mit den aktuellen Werten anzeigen (z. B. tatsächlicher Port statt Platzhalter).
  const permissions = useMemo(
    () =>
      requestedPermissions(manifest).map((p) => {
        try {
          return { ...p, detail: renderTemplate(p.detail, { options: values, addon: { id: manifest.id, version: manifest.version }, host: { address: host?.address ?? '', name: host?.name ?? '' } }) };
        } catch {
          return p;
        }
      }),
    [manifest, values, host],
  );

  const install = useMutation({
    mutationFn: () => api.installAddon(manifest.id, hostId!, values),
    onSuccess: () => {
      onClose();
      navigate(`/addons/${manifest.id}`);
    },
    onError: (e) => toast('error', e.message),
  });

  if (!usable.length) {
    return (
      <EmptyState icon={<AlertTriangle size={36} />} title="Kein passender Docker-Host verbunden">
        <p>
          {manifest.name} benötigt einen verbundenen Host ({manifest.arch.join(' oder ')}).
        </p>
        <Link to="/docker-hosts" className="btn btn-primary" onClick={onClose}>
          Docker-Hosts verwalten
        </Link>
      </EmptyState>
    );
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!Object.keys(errors).length && hostId) install.mutate();
      }}
    >
      <p className="muted">{manifest.description}</p>
      <Field label="Installieren auf">
        <select value={hostId ?? ''} onChange={(e) => setHostId(Number(e.target.value))}>
          {hosts.map((h) => {
            const ok = usable.includes(h);
            return (
              <option key={h.id} value={h.id} disabled={!ok}>
                {h.name} ({h.address}){!ok ? (h.status !== 'ready' ? ' – nicht verbunden' : ` – ${h.arch} nicht unterstützt`) : ''}
              </option>
            );
          })}
        </select>
      </Field>
      <OptionsForm options={manifest.options} values={values} onChange={setValues} errors={touched ? errors : {}} />
      {permissions.length > 0 && (
        <div className="permissions">
          <h3>
            <ShieldAlert size={16} /> Benötigte Rechte auf dem Host
          </h3>
          <ul>
            {permissions.map((p, i) => (
              <li key={i} className={p.kind === 'port' ? '' : 'tone-warn'}>
                {p.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={install.isPending || !hostId}>
          <PackagePlus size={18} /> Installieren
        </button>
      </div>
    </form>
  );
}

function StoreCard({ entry, onInstall }: { entry: AddonStoreEntry; onInstall: (m: AddonManifest) => void }) {
  const m = entry.manifest;
  if (!m) {
    return (
      <Card title={entry.addonDir || entry.repository.name} icon={<AlertTriangle size={18} />} actions={<Badge tone="alarm">ungültig</Badge>}>
        <p className="hint tone-alarm">{entry.error}</p>
        <p className="muted">Repository: {entry.repository.name}</p>
      </Card>
    );
  }
  const update = entry.installedVersion && entry.installedVersion !== m.version;
  return (
    <Card
      title={m.name}
      icon={<Package size={18} />}
      actions={entry.installedVersion ? <Badge tone={update ? 'warn' : 'ok'}>{update ? 'Update verfügbar' : 'Installiert'}</Badge> : undefined}
    >
      <p className="addon-desc">{m.description || '–'}</p>
      <div className="chip-row">
        <Badge>v{m.version}</Badge>
        <Badge>{m.arch.join(' / ')}</Badge>
        <Badge>{entry.repository.name}</Badge>
      </div>
      <div className="btn-row">
        {entry.installedVersion ? (
          <Link to={`/addons/${m.id}`} className="btn btn-sm">
            Öffnen
          </Link>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => onInstall(m)}>
            <PackagePlus size={16} /> Installieren
          </button>
        )}
      </div>
    </Card>
  );
}

export function AddonsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'installed' | 'store'>('installed');
  const [installing, setInstalling] = useState<AddonManifest | null>(null);
  const { data: installed, isLoading } = useQuery({ queryKey: ['addons', 'list'], queryFn: api.addons });
  const { data: store } = useQuery({ queryKey: ['addons', 'store'], queryFn: api.addonStore });
  const { data: hosts = [] } = useQuery({ queryKey: ['dockerHosts'], queryFn: api.dockerHosts });

  const refresh = useMutation({
    mutationFn: api.refreshAddonStore,
    onSuccess: () => {
      // auch installierte Addons: deren „Update auf …“ hängt am Repo-Stand
      void qc.invalidateQueries({ queryKey: ['addons'] });
      toast('success', 'Repositories aktualisiert');
    },
    onError: (e) => toast('error', e.message),
  });

  return (
    <>
      <PageHeader
        title="Addons"
        subtitle="Zusätzliche Dienste als Docker-Container auf den Fahrzeug-Servern"
        actions={
          <>
            <Link to="/docker-hosts" className="btn">
              Docker-Hosts ({hosts.filter((h) => h.status === 'ready').length}/{hosts.length})
            </Link>
            <button className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw size={16} /> Repositories aktualisieren
            </button>
          </>
        }
      />
      <Segmented<'installed' | 'store'>
        label="Ansicht"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'installed', label: `Installiert (${installed?.length ?? 0})` },
          { value: 'store', label: `Store (${store?.filter((e) => e.manifest).length ?? 0})` },
        ]}
      />
      <div className="spacer" />

      {tab === 'installed' &&
        (isLoading ? (
          <Loading />
        ) : !installed?.length ? (
          <Card>
            <EmptyState icon={<Package size={40} />} title="Noch keine Addons installiert">
              <button className="btn btn-primary" onClick={() => setTab('store')}>
                Zum Store
              </button>
            </EmptyState>
          </Card>
        ) : (
          <div className="grid">
            {installed.map((a) => (
              <Link key={a.id} to={`/addons/${a.id}`} className="card card-link">
                <div className="card-link-head">
                  <h2 className="card-title">
                    <Package size={18} /> {a.name}
                  </h2>
                  <AddonStatusBadge status={a.status} />
                </div>
                <div className="muted">
                  v{a.version} · auf {a.hostName}
                  {a.availableVersion && <span className="tone-warn"> · Update auf v{a.availableVersion}</span>}
                </div>
                {a.error && <div className="hint tone-alarm">{a.error}</div>}
              </Link>
            ))}
          </div>
        ))}

      {tab === 'store' && (
        <div className="grid">
          {store?.map((e, i) => <StoreCard key={`${e.repository.id}-${e.addonDir}-${i}`} entry={e} onInstall={setInstalling} />)}
        </div>
      )}

      <Modal open={!!installing} title={installing ? `${installing.name} installieren` : ''} onClose={() => setInstalling(null)}>
        {installing && <InstallDialog manifest={installing} hosts={hosts} onClose={() => setInstalling(null)} />}
      </Modal>
    </>
  );
}
