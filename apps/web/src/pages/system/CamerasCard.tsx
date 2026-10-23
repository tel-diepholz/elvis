import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Cctv, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CameraConfig, CameraConfigInput, CameraTestResult } from '@elvis/shared';
import { api } from '../../lib/api';
import { useDevice } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Modal, Segmented, Toggle } from '../../components/ui';

const EMPTY: CameraConfigInput = { name: '', type: 'axis', host: '', protocol: 'http', username: 'root', password: '', verifyTls: false, resolution: '1280x720', enabled: true };
const RESOLUTIONS = ['640x360', '1280x720', '1920x1080'];

function CameraDialog({ camera, onClose }: { camera: CameraConfig | null; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<CameraConfigInput>(camera ? { ...camera, password: '' } : EMPTY);
  const [test, setTest] = useState<CameraTestResult | null>(null);
  const set = <K extends keyof CameraConfigInput>(k: K, value: CameraConfigInput[K]) => (setV({ ...v, [k]: value }), setTest(null));
  const axis = v.type === 'axis';
  const valid = v.name.trim() !== '' && (!axis || (v.host.trim() !== '' && (v.password !== '' || !!camera?.passwordSet)));

  const runTest = useMutation({ mutationFn: () => api.testCamera(v, camera?.id), onSuccess: setTest, onError: (e) => toast('error', e.message) });
  const save = useMutation({
    mutationFn: () => (camera ? api.updateCamera(camera.id, v) : api.createCamera(v)),
    onSuccess: (c) => (toast('success', `Kamera „${c.name}“ gespeichert`), onClose()),
    onError: (e) => toast('error', e.message),
  });

  return (
    <Modal open title={camera ? `Kamera „${camera.name}“` : 'Kamera hinzufügen'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Name">
          <input value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={60} placeholder="z. B. Lichtmast" autoFocus />
        </Field>
        <Field label="Typ">
          <select value={v.type} onChange={(e) => set('type', e.target.value as CameraConfigInput['type'])}>
            <option value="axis">Axis (VAPIX)</option>
            <option value="demo">Demo (ohne Hardware)</option>
          </select>
        </Field>
        {axis && (
          <>
            <Field label="Adresse" hint="IP-Adresse oder Hostname, ggf. mit :Port">
              <input value={v.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="192.168.1.90" />
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
            <Field label="Benutzer" hint="Konto mit Bedienrechten (Operator); für Zoom/Fokus bei festen Kameras Administrator">
              <input value={v.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Passwort">
              <input type="password" value={v.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={camera?.passwordSet ? '•••••• (unverändert)' : ''} />
            </Field>
            <Field label="Auflösung des Livebilds">
              <select value={v.resolution} onChange={(e) => set('resolution', e.target.value)}>
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            {v.protocol === 'https' && <Toggle label="Zertifikat prüfen" checked={v.verifyTls} onChange={(on) => set('verifyTls', on)} />}
          </>
        )}
        <Toggle label="Kamera aktiv" checked={v.enabled} onChange={(on) => set('enabled', on)} />
      </div>
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

/** Kameras für das Modul „Kameras“ – nur Admins. */
export function CamerasCard() {
  const toast = useToast();
  const status = useDevice('cameras')?.state.cameras ?? [];
  const { data: cameras } = useQuery({ queryKey: ['cameras'], queryFn: api.cameraConfigs });
  const [editing, setEditing] = useState<CameraConfig | 'new' | null>(null);
  const remove = useMutation({ mutationFn: api.removeCamera, onError: (e) => toast('error', e.message) });
  const reorder = useMutation({ mutationFn: api.reorderCameras, onError: (e) => toast('error', e.message) });
  const move = (i: number, d: -1 | 1) => {
    if (!cameras) return;
    const ids = cameras.map((c) => c.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <Card
      title="Kameras"
      icon={<Cctv size={18} />}
      className="span-3"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setEditing('new')}>
          <Plus size={16} /> Kamera hinzufügen
        </button>
      }
    >
      {!cameras ? (
        <Loading />
      ) : cameras.length === 0 ? (
        <p className="muted">Noch keine Kameras. Für Axis-Kameras Adresse und ein Konto mit Bedienrechten bereithalten.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Typ / Adresse</th>
                <th>Modell</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cameras.map((c, i) => {
                const s = status.find((x) => x.id === c.id);
                return (
                  <tr key={c.id} className={c.enabled ? '' : 'row-muted'}>
                    <td>
                      <div className="cell-title">{c.name}</div>
                    </td>
                    <td>{c.type === 'demo' ? 'Demo' : <span className="mono">{`${c.protocol}://${c.host}`}</span>}</td>
                    <td>{s?.model ?? '–'}</td>
                    <td>{!c.enabled ? <Badge>deaktiviert</Badge> : s?.online ? <Badge tone="ok">verbunden</Badge> : <Badge tone="alarm">{s?.error ?? 'nicht verbunden'}</Badge>}</td>
                    <td>
                      <span className="btn-row">
                        <button type="button" className="btn btn-icon" aria-label="nach oben" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                          <ArrowUp size={16} />
                        </button>
                        <button type="button" className="btn btn-icon" aria-label="nach unten" disabled={i === cameras.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                          <ArrowDown size={16} />
                        </button>
                        <button type="button" className="btn btn-icon" aria-label={`${c.name} bearbeiten`} onClick={() => setEditing(c)}>
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`${c.name} entfernen`}
                          disabled={remove.isPending}
                          onClick={() => window.confirm(`Kamera „${c.name}“ entfernen?`) && remove.mutate(c.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CameraDialog camera={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
