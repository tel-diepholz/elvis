import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Link2, MonitorSmartphone, Pencil, Trash2 } from 'lucide-react';
import type { DisplayDevice } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Modal } from '../../components/ui';

/** Neueste Version der App „ELVIS Bildschirm“ für Smart-TVs (github.com/tel-diepholz/elvis-tv) */
const TV_APP_URL = 'https://github.com/tel-diepholz/elvis-tv/releases/latest/download/elvis-tv.apk';

function TvAppHint() {
  return (
    <p className="muted">
      Smart-TV oder anderes Android-Gerät: App <a href={TV_APP_URL}>ELVIS Bildschirm (APK)</a> installieren und als Adresse <code>{location.origin}</code> eingeben.
    </p>
  );
}

function PairDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const digits = code.replace(/\D/g, '');
  const pair = useMutation({
    mutationFn: () => api.pairDisplay(digits, name),
    onSuccess: (d) => (toast('success', `Bildschirm „${d.name}“ gekoppelt`), onClose()),
    onError: (e) => toast('error', e.message),
  });
  return (
    <Modal open title="Bildschirm koppeln" onClose={onClose}>
      <p className="muted">
        Auf dem Bildschirm <code>{`${location.origin}/bildschirm`}</code> öffnen (Kiosk-Browser oder App). Er zeigt einen 6-stelligen Code.
      </p>
      <TvAppHint />
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (digits.length === 6 && name.trim()) pair.mutate();
        }}
      >
        <Field label="Code vom Bildschirm">
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123 456" maxLength={7} autoFocus className="mono" />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="z. B. Lagetisch, Monitor Führungsraum" />
        </Field>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn btn-primary" disabled={digits.length !== 6 || !name.trim() || pair.isPending}>
            Koppeln
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Gekoppelte Bildschirme – nur Admins */
export function DisplaysCard() {
  const toast = useToast();
  const { data: displays } = useQuery({ queryKey: ['displays'], queryFn: api.displays });
  const [pairing, setPairing] = useState(false);
  const rename = useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.renameDisplay(id, name), onError: (e) => toast('error', e.message) });
  const remove = useMutation({ mutationFn: api.removeDisplay, onError: (e) => toast('error', e.message) });
  const reorder = useMutation({ mutationFn: api.reorderDisplays, onError: (e) => toast('error', e.message) });
  const move = (list: DisplayDevice[], i: number, d: -1 | 1) => {
    const ids = list.map((x) => x.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <Card
      title="Bildschirme"
      icon={<MonitorSmartphone size={18} />}
      className="span-3"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setPairing(true)}>
          <Link2 size={16} /> Bildschirm koppeln
        </button>
      }
    >
      {!displays ? (
        <Loading />
      ) : displays.length === 0 ? (
        <>
          <p className="muted">
            Noch keine Bildschirme. Auf dem Gerät <code>{`${location.origin}/bildschirm`}</code> öffnen und den angezeigten Code hier eintragen.
          </p>
          <TvAppHint />
        </>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Auflösung</th>
                <th>Gekoppelt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {displays.map((d, i) => (
                <tr key={d.id}>
                  <td>
                    <div className="cell-title">{d.name}</div>
                    <div className="cell-sub" title={d.userAgent}>
                      {d.userAgent.split(' ').slice(-2).join(' ') || '–'}
                    </div>
                  </td>
                  <td>{d.online ? <Badge tone="ok">verbunden</Badge> : <Badge>{d.lastSeenAt ? `zuletzt ${fmtDateTime(d.lastSeenAt)}` : 'offline'}</Badge>}</td>
                  <td className="mono">{d.screen ? `${d.screen.width}×${d.screen.height}` : '–'}</td>
                  <td>{fmtDateTime(d.pairedAt)}</td>
                  <td>
                    <span className="btn-row">
                      <button type="button" className="btn btn-icon" aria-label="nach oben" disabled={i === 0 || reorder.isPending} onClick={() => move(displays, i, -1)}>
                        <ArrowUp size={16} />
                      </button>
                      <button type="button" className="btn btn-icon" aria-label="nach unten" disabled={i === displays.length - 1 || reorder.isPending} onClick={() => move(displays, i, 1)}>
                        <ArrowDown size={16} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`${d.name} umbenennen`}
                        onClick={() => {
                          const name = window.prompt('Neuer Name', d.name)?.trim();
                          if (name && name !== d.name) rename.mutate({ id: d.id, name });
                        }}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`${d.name} entkoppeln`}
                        disabled={remove.isPending}
                        onClick={() => window.confirm(`Bildschirm „${d.name}“ entkoppeln? Er zeigt danach wieder einen Kopplungscode.`) && remove.mutate(d.id)}
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
      {pairing && <PairDialog onClose={() => setPairing(false)} />}
    </Card>
  );
}
