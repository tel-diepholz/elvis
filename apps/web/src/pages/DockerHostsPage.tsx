import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import type { DockerHost, HostSetup } from '@elvis/shared';
import { ApiError, api } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Card, EmptyState, Field, Loading, Modal, PageHeader, Segmented, type Tone } from '../components/ui';

const STATUS: Record<DockerHost['status'], { label: string; tone: Tone }> = {
  ready: { label: 'Verbunden', tone: 'ok' },
  pending: { label: 'Wartet auf Einrichtung', tone: 'info' },
  unreachable: { label: 'Nicht erreichbar', tone: 'alarm' },
};

const CERT_WARN_MS = 30 * 86_400_000;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Ohne HTTPS gibt es keine Clipboard-API – auf das alte Verfahren ausweichen.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function SetupCommand({ setup }: { setup: HostSetup }) {
  const toast = useToast();
  return (
    <div className="setup-command">
      <ol className="setup-steps">
        <li>Auf dem Server als root bzw. mit sudo ausführen (Docker muss installiert sein):</li>
      </ol>
      <div className="command-box">
        <code>{setup.command}</code>
        <button
          className="btn btn-sm"
          onClick={async () => {
            const ok = await copyText(setup.command);
            toast(ok ? 'success' : 'error', ok ? 'Befehl kopiert' : 'Kopieren nicht möglich – bitte markieren und kopieren');
          }}
        >
          <Copy size={14} /> Kopieren
        </button>
      </div>
      <p className="muted">
        Das Skript richtet die Docker-API per TLS auf Port {setup.host.port} ein und meldet sich danach bei ELVIS. Der Link ist einmalig gültig bis{' '}
        {fmtDateTime(setup.expiresAt)}.
      </p>
    </div>
  );
}

function AddHostDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'elvis' | 'custom'>('elvis');
  const [form, setForm] = useState({ name: '', address: '', port: '2376', caPem: '', certPem: '', keyPem: '' });
  const [setup, setSetup] = useState<HostSetup | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = useMutation({
    mutationFn: () => {
      const base = { name: form.name.trim(), address: form.address.trim(), port: Number(form.port) || undefined };
      return mode === 'elvis' ? api.addDockerHost({ certMode: 'elvis', ...base }) : api.addDockerHost({ certMode: 'custom', ...base, caPem: form.caPem, certPem: form.certPem, keyPem: form.keyPem });
    },
    onSuccess: (res) => {
      if (res.command) setSetup(res as HostSetup);
      else {
        toast(res.host.status === 'ready' ? 'success' : 'error', res.host.status === 'ready' ? `${res.host.name} verbunden` : `${res.host.name} angelegt, aber nicht erreichbar: ${res.host.error ?? ''}`);
        onClose();
      }
    },
    onError: (e) => toast('error', e.message),
  });

  if (setup) {
    return (
      <div className="form">
        <SetupCommand setup={setup} />
        <div className="form-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Fertig
          </button>
        </div>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <form className="form" onSubmit={submit}>
      <Segmented<'elvis' | 'custom'>
        label="Zertifikate"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'elvis', label: 'ELVIS richtet TLS ein' },
          { value: 'custom', label: 'Eigene Zertifikate' },
        ]}
      />
      <div className="form-grid">
        <Field label="Name *">
          <input value={form.name} onChange={set('name')} placeholder="z. B. server2" required maxLength={60} autoFocus />
        </Field>
        <Field label="Adresse *" hint="IP-Adresse oder Hostname im Fahrzeug-LAN">
          <input value={form.address} onChange={set('address')} placeholder="z. B. 192.168.10.12" required />
        </Field>
        <Field label="TLS-Port">
          <input type="number" value={form.port} onChange={set('port')} min={1} max={65535} />
        </Field>
      </div>
      {mode === 'custom' && (
        <>
          <Field label="CA-Zertifikat (PEM)">
            <textarea rows={3} value={form.caPem} onChange={set('caPem')} placeholder="-----BEGIN CERTIFICATE-----" required />
          </Field>
          <Field label="Client-Zertifikat (PEM)">
            <textarea rows={3} value={form.certPem} onChange={set('certPem')} placeholder="-----BEGIN CERTIFICATE-----" required />
          </Field>
          <Field label="Client-Schlüssel (PEM)">
            <textarea rows={3} value={form.keyPem} onChange={set('keyPem')} placeholder="-----BEGIN RSA PRIVATE KEY-----" required />
          </Field>
        </>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={add.isPending || !form.name.trim() || !form.address.trim()}>
          {mode === 'elvis' ? 'Weiter' : 'Hinzufügen'}
        </button>
      </div>
    </form>
  );
}

/** Name, Adresse, Port ändern – z. B. wenn der Server eine neue IP-Adresse bekommen hat */
function EditHostDialog({ host, onClose, onSetup }: { host: DockerHost; onClose: () => void; onSetup: (s: HostSetup) => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: host.name, address: host.address, port: String(host.port) });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api.updateDockerHost(host.id, { name: form.name.trim(), address: form.address.trim(), port: Number(form.port) || host.port }),
    onSuccess: ({ host: h, setup }) => {
      if (setup) {
        onSetup(setup);
        toast('success', `${h.name} gespeichert – Zertifikat bitte mit dem angezeigten Befehl neu einrichten`);
      } else toast(h.status === 'ready' ? 'success' : 'error', h.status === 'ready' ? `${h.name} verbunden` : `${h.name} gespeichert, aber nicht erreichbar: ${h.error ?? ''}`);
      onClose();
    },
    onError: (e) => toast('error', e.message),
  });
  const changesCert = host.certMode === 'elvis' && (form.address.trim() !== host.address || form.name.trim() !== host.name);
  return (
    <Modal open title={`${host.name} bearbeiten`} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Name *">
            <input value={form.name} onChange={set('name')} required maxLength={60} />
          </Field>
          <Field label="Adresse *" hint="IP-Adresse oder Hostname im Fahrzeug-LAN">
            <input value={form.address} onChange={set('address')} required autoFocus />
          </Field>
          <Field label="TLS-Port">
            <input type="number" value={form.port} onChange={set('port')} min={1} max={65535} />
          </Field>
        </div>
        {changesCert && (
          <p className="hint tone-warn">
            Name und Adresse stehen im Serverzertifikat. Nach dem Speichern zeigt ELVIS einen neuen Einrichtungsbefehl – auf dem Server ausführen, dann ist der Host wieder
            verbunden. Installierte Addons bleiben erhalten.
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending || !form.name.trim() || !form.address.trim()}>
            Speichern
          </button>
        </div>
      </form>
    </Modal>
  );
}

function HostCard({ host }: { host: DockerHost }) {
  const toast = useToast();
  const [setup, setSetup] = useState<HostSetup | null>(null);
  const [editing, setEditing] = useState(false);
  const st = STATUS[host.status];
  const certSoon = host.certExpiresAt && new Date(host.certExpiresAt).getTime() - Date.now() < CERT_WARN_MS;

  const test = useMutation({
    mutationFn: () => api.testDockerHost(host.id),
    onSuccess: (h) => toast(h.status === 'ready' ? 'success' : 'error', h.status === 'ready' ? `${h.name} erreichbar` : `${h.name}: ${h.error ?? 'nicht erreichbar'}`),
    onError: (e) => toast('error', e.message),
  });
  const renew = useMutation({ mutationFn: () => api.renewHostSetup(host.id), onSuccess: setSetup, onError: (e) => toast('error', e.message) });
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await api.removeDockerHost(host.id);
      } catch (e) {
        // Noch Addons eingetragen (auch wenn der Host nicht erreichbar ist): nur auf ausdrückliche Bestätigung austragen
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        const ok = window.confirm(
          `${e.message}.\n\nTrotzdem entfernen? Die Addons werden dann nur aus ELVIS ausgetragen – Container und Daten auf dem Server bleiben unberührt und müssen dort bei Bedarf von Hand entfernt werden.`,
        );
        if (!ok) return false;
        await api.removeDockerHost(host.id, true);
      }
      return true;
    },
    onSuccess: (done) => done && toast('success', `${host.name} entfernt`),
    onError: (e) => toast('error', e.message),
  });

  return (
    <Card
      title={host.name}
      icon={<Server size={18} />}
      actions={<Badge tone={st.tone}>{st.label}</Badge>}
    >
      <dl className="kv">
        <dt>Adresse</dt>
        <dd className="mono">
          {host.address}:{host.port}
        </dd>
        <dt>Docker</dt>
        <dd>{host.dockerVersion ? `${host.dockerVersion} · ${host.arch ?? '?'}` : '–'}</dd>
        <dt>System</dt>
        <dd>{host.os ?? '–'}</dd>
        <dt>Addons</dt>
        <dd>{host.addonCount}</dd>
        <dt>Zertifikat</dt>
        <dd className={certSoon ? 'tone-warn' : undefined}>
          {host.certMode === 'custom' ? 'eigene Zertifikate' : host.certExpiresAt ? `gültig bis ${fmtDate(host.certExpiresAt)}` : 'noch nicht eingerichtet'}
        </dd>
        <dt>Geprüft</dt>
        <dd>{host.checkedAt ? fmtDateTime(host.checkedAt) : '–'}</dd>
      </dl>
      {host.error && host.status !== 'ready' && <p className="hint tone-alarm">{host.error}</p>}
      {setup && <SetupCommand setup={setup} />}
      <div className="btn-row">
        <button className="btn btn-sm" onClick={() => test.mutate()} disabled={test.isPending}>
          <RefreshCw size={14} /> Verbindung testen
        </button>
        {host.certMode === 'elvis' && (
          <button className="btn btn-sm" onClick={() => renew.mutate()} disabled={renew.isPending}>
            <KeyRound size={14} /> {host.status === 'pending' ? 'Einrichtungsbefehl' : 'Zertifikat erneuern'}
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setEditing(true)}>
          <Pencil size={14} /> Bearbeiten
        </button>
        <button
          className="btn btn-sm btn-danger"
          disabled={remove.isPending}
          onClick={() => window.confirm(`Host „${host.name}“ aus ELVIS entfernen? Die Docker-Konfiguration auf dem Server bleibt unverändert.`) && remove.mutate()}
        >
          <Trash2 size={14} /> Entfernen
        </button>
      </div>
      {editing && <EditHostDialog host={host} onClose={() => setEditing(false)} onSetup={setSetup} />}
    </Card>
  );
}

export function DockerHostsPage() {
  const { data: hosts, isLoading } = useQuery({ queryKey: ['dockerHosts'], queryFn: api.dockerHosts });
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title="Docker-Hosts"
        subtitle={
          <>
            Server, auf denen ELVIS <Link to="/addons">Addons</Link> betreiben kann – Verbindung über die Docker-API per TLS.
          </>
        }
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={18} /> Server hinzufügen
          </button>
        }
      />
      {isLoading ? (
        <Loading />
      ) : !hosts?.length ? (
        <Card>
          <EmptyState icon={<Server size={40} />} title="Noch kein Docker-Host hinterlegt">
            <p>Füge den ersten Server hinzu – ELVIS erzeugt die Zertifikate und einen Einrichtungsbefehl.</p>
          </EmptyState>
        </Card>
      ) : (
        <div className="grid">
          {hosts.map((h) => (
            <HostCard key={h.id} host={h} />
          ))}
        </div>
      )}
      <Modal open={adding} title="Server hinzufügen" onClose={() => setAdding(false)}>
        <AddHostDialog onClose={() => setAdding(false)} />
      </Modal>
    </>
  );
}
