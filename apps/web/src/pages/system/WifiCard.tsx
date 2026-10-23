import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, RefreshCw, Router, Trash2, Wifi } from 'lucide-react';
import { WIFI_GUEST_SSID_MAX, type WifiAp, type WifiApConfigInput, type WifiApTestResult, type WifiSettingsInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Modal, Segmented, Toggle } from '../../components/ui';
import { WifiQr } from '../../components/WifiQr';

const EMPTY_AP: WifiApConfigInput = { name: '', host: '', protocol: 'http', username: 'root', password: '', verifyTls: false, opsNetwork: 'lan', guestNetwork: '', enabled: true };

const useWifi = () => useQuery({ queryKey: ['wifi'], queryFn: api.wifi });

/** Betriebs-WLAN und Gastnetz – gilt für alle Accesspoints. Nur Admins. */
export function WifiCard() {
  const toast = useToast();
  const { data } = useWifi();
  const [v, setV] = useState<WifiSettingsInput | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setV({ ops: { enabled: data.settings.ops.enabled, ssid: data.settings.ops.ssid, password: '' }, guest: data.settings.guest });
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => api.updateWifiSettings(v!),
    onSuccess: () => (setDirty(false), toast('success', 'WLAN-Einstellungen gespeichert – werden auf die Accesspoints übertragen')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !v) return <Loading />;
  const setOps = (patch: Partial<WifiSettingsInput['ops']>) => (setV({ ...v, ops: { ...v.ops, ...patch } }), setDirty(true));
  const setGuest = (patch: Partial<WifiSettingsInput['guest']>) => (setV({ ...v, guest: { ...v.guest, ...patch } }), setDirty(true));
  const pwOk = v.ops.password === '' ? !v.ops.enabled || data.settings.ops.passwordSet : v.ops.password.length >= 8 && v.ops.password.length <= 63;
  const valid = (!v.ops.enabled || v.ops.ssid.trim() !== '') && pwOk && (!v.guest.enabled || v.guest.ssid.trim() !== '');
  const guest = data.guest;

  return (
    <Card title="WLAN" icon={<Wifi size={18} />} className="span-3">
      <div className="wifi-settings">
        <section>
          <h3 className="section-title">Betriebs-WLAN</h3>
          <Toggle label="Betriebs-WLAN auf den Accesspoints einrichten" checked={v.ops.enabled} onChange={(enabled) => setOps({ enabled })} />
          <div className="form-grid">
            <Field label="Netzname (SSID)">
              <input value={v.ops.ssid} onChange={(e) => setOps({ ssid: e.target.value })} maxLength={32} disabled={!v.ops.enabled} />
            </Field>
            <Field label="Passwort" hint="WPA2, 8 bis 63 Zeichen">
              <input
                type="password"
                value={v.ops.password}
                onChange={(e) => setOps({ password: e.target.value })}
                maxLength={63}
                autoComplete="new-password"
                placeholder={data.settings.ops.passwordSet ? '•••••• (unverändert)' : ''}
                disabled={!v.ops.enabled}
              />
            </Field>
          </div>
        </section>
        <section>
          <h3 className="section-title">Gastnetz</h3>
          <Toggle label="Gastnetz im Einsatz zuschalten" checked={v.guest.enabled} onChange={(enabled) => setGuest({ enabled })} />
          <Field label="Netzname (SSID)" hint={`Im Einsatz wird die Einsatznummer angehängt, z. B. „${v.guest.ssid || 'Gast'}-12“. Das Passwort entsteht je Einsatz neu.`}>
            <input value={v.guest.ssid} onChange={(e) => setGuest({ ssid: e.target.value })} maxLength={WIFI_GUEST_SSID_MAX} disabled={!v.guest.enabled} />
          </Field>
          {guest.active ? (
            <div className="wifi-guest-now">
              <WifiQr ssid={guest.ssid} password={guest.password} className="wifi-guest-qr" />
              <dl>
                <dt>Netzname</dt>
                <dd className="mono">{guest.ssid}</dd>
                <dt>Passwort</dt>
                <dd className="mono">{guest.password}</dd>
              </dl>
            </div>
          ) : (
            <p className="muted">{guest.reason}</p>
          )}
        </section>
      </div>
      <div className="form-actions spread">
        <span className="muted">Die Gastnetz-Bridge wird je Accesspoint festgelegt und muss dort bereits eingerichtet sein.</span>
        <span className="btn-row">
          <button className="btn" disabled={!dirty} onClick={() => setDirty(false)}>
            Verwerfen
          </button>
          <button className="btn btn-primary" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>
    </Card>
  );
}

function ApDialog({ ap, onClose }: { ap: WifiAp | null; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<WifiApConfigInput>(ap ? { ...ap, password: '' } : EMPTY_AP);
  const [test, setTest] = useState<WifiApTestResult | null>(null);
  const set = <K extends keyof WifiApConfigInput>(k: K, value: WifiApConfigInput[K]) => (setV({ ...v, [k]: value }), setTest(null));
  const valid = v.name.trim() !== '' && v.host.trim() !== '' && v.username.trim() !== '' && v.opsNetwork.trim() !== '' && (v.password !== '' || !!ap?.passwordSet);

  const runTest = useMutation({ mutationFn: () => api.testWifiAp(v, ap?.id), onSuccess: setTest, onError: (e) => toast('error', e.message) });
  const save = useMutation({
    mutationFn: () => (ap ? api.updateWifiAp(ap.id, v) : api.createWifiAp(v)),
    onSuccess: (a) => (toast('success', `Accesspoint „${a.name}“ gespeichert`), onClose()),
    onError: (e) => toast('error', e.message),
  });

  return (
    <Modal open title={ap ? `Accesspoint „${ap.name}“` : 'Accesspoint hinzufügen'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Name">
          <input value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={60} placeholder="z. B. AP Besprechungsraum" autoFocus />
        </Field>
        <Field label="Adresse" hint="IP-Adresse oder Hostname des OpenWrt-Geräts, ggf. mit :Port">
          <input value={v.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="192.168.1.2" />
        </Field>
        <Field label="Protokoll">
          <Segmented
            label="Protokoll"
            value={v.protocol}
            onChange={(p) => set('protocol', p)}
            options={[
              { value: 'http', label: 'HTTP' },
              { value: 'https', label: 'HTTPS' },
            ]}
          />
        </Field>
        <Field label="Benutzer" hint="Konto mit Schreibrechten auf die Konfiguration (meist root)">
          <input value={v.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Passwort">
          <input type="password" value={v.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={ap?.passwordSet ? '•••••• (unverändert)' : ''} />
        </Field>
        <Field label="Netz für das Betriebs-WLAN" hint="OpenWrt-Schnittstelle oder Bridge, z. B. lan oder br-lan">
          <input value={v.opsNetwork} onChange={(e) => set('opsNetwork', e.target.value.trim())} placeholder="lan" />
        </Field>
        <Field label="Gastnetz-Bridge" hint="Bridge (z. B. br-guests) oder Schnittstelle des Gastnetzes; muss auf dem AP bereits eingerichtet sein. Leer = kein Gastnetz auf diesem AP">
          <input value={v.guestNetwork} onChange={(e) => set('guestNetwork', e.target.value.trim())} placeholder="br-guests" />
        </Field>
        {v.protocol === 'https' && <Toggle label="Zertifikat prüfen" checked={v.verifyTls} onChange={(on) => set('verifyTls', on)} />}
        <Toggle label="Accesspoint aktiv" checked={v.enabled} onChange={(on) => set('enabled', on)} />
      </div>
      <p className="field-hint">ELVIS greift wie LuCI über /ubus zu und legt je Funkmodul eigene WLANs an (elvis_ops_…, elvis_guest_…); vorhandene WLANs bleiben unverändert. Für eine Bridge ohne Schnittstelle legt ELVIS die Schnittstelle elvis_guest an.</p>
      {test && <p className={test.ok ? 'tone-ok' : 'tone-alarm'}>{test.message}</p>}
      <div className="form-actions spread">
        <button type="button" className="btn" disabled={!valid || runTest.isPending} onClick={() => runTest.mutate()}>
          {runTest.isPending ? 'Teste …' : 'Verbindung testen'}
        </button>
        <span className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>
    </Modal>
  );
}

function ApStatus({ ap }: { ap: WifiAp }) {
  const s = ap.status;
  const badge =
    s.state === 'disabled' ? <Badge>deaktiviert</Badge> : s.state === 'pending' ? <Badge tone="warn">wird übertragen …</Badge> : s.state === 'ok' ? <Badge tone="ok">aktuell</Badge> : <Badge tone="alarm">Fehler</Badge>;
  return (
    <>
      {badge}
      {s.state !== 'disabled' && s.message && <div className="cell-sub">{s.message}</div>}
    </>
  );
}

/** OpenWrt-Accesspoints, auf die ELVIS das WLAN überträgt – nur Admins. */
export function WifiApsCard() {
  const toast = useToast();
  const { data } = useWifi();
  const aps = data?.aps;
  const [editing, setEditing] = useState<WifiAp | 'new' | null>(null);
  const remove = useMutation({ mutationFn: api.removeWifiAp, onError: (e) => toast('error', e.message) });
  const reorder = useMutation({ mutationFn: api.reorderWifiAps, onError: (e) => toast('error', e.message) });
  const sync = useMutation({
    mutationFn: api.syncWifi,
    onSuccess: (o) => {
      const failed = o.aps.filter((a) => a.status.state === 'error').length;
      toast(failed ? 'error' : 'success', failed ? `${failed} Accesspoint(s) mit Fehler` : 'Auf alle Accesspoints übertragen');
    },
    onError: (e) => toast('error', e.message),
  });
  const move = (i: number, d: -1 | 1) => {
    if (!aps) return;
    const ids = aps.map((a) => a.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <Card
      title="WLAN-Accesspoints (OpenWrt)"
      icon={<Router size={18} />}
      className="span-3"
      actions={
        <span className="btn-row">
          <button type="button" className="btn btn-sm" disabled={!aps?.length || sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw size={16} /> {sync.isPending ? 'Übertrage …' : 'Jetzt übertragen'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setEditing('new')}>
            <Plus size={16} /> Accesspoint hinzufügen
          </button>
        </span>
      }
    >
      {!aps ? (
        <Loading />
      ) : aps.length === 0 ? (
        <p className="muted">Noch keine Accesspoints. Benötigt werden OpenWrt mit LuCI (uhttpd-mod-ubus), Adresse und root-Zugang.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Adresse</th>
                <th>Schnittstellen</th>
                <th>Funkmodule</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {aps.map((a, i) => (
                <tr key={a.id} className={a.enabled ? '' : 'row-muted'}>
                  <td>
                    <div className="cell-title">{a.name}</div>
                    {a.status.syncedAt && <div className="cell-sub">abgeglichen {fmtDateTime(a.status.syncedAt)}</div>}
                  </td>
                  <td className="mono">{`${a.protocol}://${a.host}`}</td>
                  <td>
                    <span className="mono">{a.opsNetwork}</span>
                    <div className="cell-sub">Gast: {a.guestNetwork ? <span className="mono">{a.guestNetwork}</span> : 'keins'}</div>
                  </td>
                  <td>{a.status.radios.length ? a.status.radios.join(', ') : '–'}</td>
                  <td>
                    <ApStatus ap={a} />
                  </td>
                  <td>
                    <span className="btn-row">
                      <button type="button" className="btn btn-icon" aria-label="nach oben" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                        <ArrowUp size={16} />
                      </button>
                      <button type="button" className="btn btn-icon" aria-label="nach unten" disabled={i === aps.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                        <ArrowDown size={16} />
                      </button>
                      <button type="button" className="btn btn-icon" aria-label={`${a.name} bearbeiten`} onClick={() => setEditing(a)}>
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`${a.name} entfernen`}
                        disabled={remove.isPending}
                        onClick={() => window.confirm(`Accesspoint „${a.name}“ entfernen? Die dort eingerichteten WLANs bleiben bestehen.`) && remove.mutate(a.id)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ApDialog ap={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
