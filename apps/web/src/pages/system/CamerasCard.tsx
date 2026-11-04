import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BellRing, Cctv, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CameraConfig, CameraConfigInput, CameraTestResult, DoorbellButton } from '@elvis/shared';
import { api } from '../../lib/api';
import { useDevice } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Modal, Segmented, Toggle } from '../../components/ui';

const EMPTY: CameraConfigInput = { name: '', type: 'axis', host: '', protocol: 'http', username: 'root', password: '', verifyTls: false, resolution: '1280x720', enabled: true, bells: [] };
const RESOLUTIONS: Record<CameraConfigInput['type'], string[]> = {
  axis: ['640x360', '1280x720', '1920x1080'],
  // 2N liefert nur feste Bildgrößen (4:3); ELVIS nimmt die nächstliegende der Türstation
  '2n': ['320x240', '640x480', '1280x960'],
  demo: ['1280x720'],
};
/** Vorgaben beim Wechsel des Typs */
const TYPE_DEFAULTS: Partial<Record<CameraConfigInput['type'], Partial<CameraConfigInput>>> = {
  axis: { username: 'root', resolution: '1280x720' },
  '2n': { username: '', resolution: '640x480', bells: [{ key: '1', label: 'Klingel', displays: [] }] },
};

const BELL_KEYS = ['*', '1', '2', '3', '4', '5', '6', '7', '8'];

/** Klingeltasten einer Türstation: Taste, Bezeichnung und Bildschirme, auf denen das Klingeln erscheint */
function BellsEditor({ bells, onChange }: { bells: DoorbellButton[]; onChange: (b: DoorbellButton[]) => void }) {
  const { data: displays } = useQuery({ queryKey: ['displays'], queryFn: api.displays });
  const patch = (i: number, p: Partial<DoorbellButton>) => onChange(bells.map((b, j) => (j === i ? { ...b, ...p } : b)));
  return (
    <div className="bells-editor">
      <div className="bells-head">
        <strong>
          <BellRing size={16} /> Klingeln
        </strong>
        <button type="button" className="btn btn-sm" onClick={() => onChange([...bells, { key: String(bells.length + 1), label: '', displays: [] }])} disabled={bells.length >= 20}>
          <Plus size={14} /> Taste
        </button>
      </div>
      {bells.length === 0 && <p className="muted">Keine Klingel – Tastendrücke werden nicht angezeigt.</p>}
      {bells.map((b, i) => (
        <div key={i} className="bells-row">
          <select value={b.key} onChange={(e) => patch(i, { key: e.target.value })} aria-label="Taste">
            {BELL_KEYS.map((k) => (
              <option key={k} value={k}>
                {k === '*' ? 'jede Taste' : `Taste ${k}`}
              </option>
            ))}
          </select>
          <input value={b.label} onChange={(e) => patch(i, { label: e.target.value })} maxLength={60} placeholder="Bezeichnung, z. B. Haupteingang" aria-label="Bezeichnung" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(bells.filter((_, j) => j !== i))} aria-label="Taste entfernen">
            <Trash2 size={14} />
          </button>
          <div className="bells-displays">
            {!displays ? (
              <Loading />
            ) : displays.length === 0 ? (
              <span className="muted">Noch keine Bildschirme gekoppelt.</span>
            ) : (
              displays.map((d) => (
                <label key={d.id} className="check">
                  <input
                    type="checkbox"
                    checked={b.displays.includes(d.id)}
                    onChange={(e) => patch(i, { displays: e.target.checked ? [...b.displays, d.id] : b.displays.filter((x) => x !== d.id) })}
                  />
                  {d.name}
                </label>
              ))
            )}
          </div>
        </div>
      ))}
      <p className="muted small">Das Klingeln erscheint auf den gewählten Bildschirmen als Dialog mit Livebild und leisem Ton. Für den Ton den Kiosk-Browser mit --autoplay-policy=no-user-gesture-required starten.</p>
    </div>
  );
}

function CameraDialog({ camera, onClose }: { camera: CameraConfig | null; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<CameraConfigInput>(camera ? { ...camera, password: '' } : EMPTY);
  const [test, setTest] = useState<CameraTestResult | null>(null);
  const set = <K extends keyof CameraConfigInput>(k: K, value: CameraConfigInput[K]) => (setV({ ...v, [k]: value }), setTest(null));
  const axis = v.type !== 'demo';
  const twoN = v.type === '2n';
  const resolutions = RESOLUTIONS[v.type];
  const changeType = (type: CameraConfigInput['type']) => (setV({ ...v, type, ...(!camera && TYPE_DEFAULTS[type]) }), setTest(null));
  const valid = v.name.trim() !== '' && (!axis || (v.host.trim() !== '' && (v.password !== '' || !!camera?.passwordSet))) && (!twoN || v.bells.every((b) => b.label.trim() !== ''));

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
          <select value={v.type} onChange={(e) => changeType(e.target.value as CameraConfigInput['type'])}>
            <option value="axis">Axis (VAPIX)</option>
            <option value="2n">2N-Türstation (z. B. IP Base) – nur Bild</option>
            <option value="demo">Demo (ohne Hardware)</option>
          </select>
        </Field>
        {axis && (
          <>
            <Field label="Adresse" hint="IP-Adresse oder Hostname, ggf. mit :Port">
              <input value={v.host} onChange={(e) => set('host', e.target.value.trim())} placeholder={twoN ? '192.168.128.236' : '192.168.1.90'} />
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
            <Field
              label="Benutzer"
              hint={twoN ? 'Konto der HTTP API (Dienste → HTTP API → Konto) mit dem Recht „Kamera“' : 'Konto mit Bedienrechten (Operator); für Zoom/Fokus bei festen Kameras Administrator'}
            >
              <input value={v.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Passwort">
              <input type="password" value={v.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={camera?.passwordSet ? '•••••• (unverändert)' : ''} />
            </Field>
            <Field label="Auflösung des Livebilds">
              <select value={v.resolution} onChange={(e) => set('resolution', e.target.value)}>
                {(resolutions.includes(v.resolution) ? resolutions : [v.resolution, ...resolutions]).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            {v.protocol === 'https' && <Toggle label="Zertifikat prüfen" checked={v.verifyTls} onChange={(on) => set('verifyTls', on)} />}
            {twoN && <BellsEditor bells={v.bells} onChange={(b) => set('bells', b)} />}
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
