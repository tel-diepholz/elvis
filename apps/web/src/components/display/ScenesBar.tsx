import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Layers, Pencil, Save, Settings2, Trash2 } from 'lucide-react';
import type { DisplayDevice, DisplayScene } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Field, Modal, Segmented } from '../ui';

function SaveDialog({ display, onClose }: { display: DisplayDevice; onClose: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'new' | 'overwrite'>('new');
  const [name, setName] = useState('');
  const [target, setTarget] = useState<number | null>(display.scenes[0]?.id ?? null);
  const save = useMutation({
    mutationFn: () => (mode === 'new' ? api.saveDisplayScene(display.id, name.trim()) : api.updateDisplayScene(display.id, target!, { overwrite: true })),
    onSuccess: (s) => (toast('success', `Szene „${s.name}“ gespeichert`), onClose()),
    onError: (e) => toast('error', e.message),
  });
  const valid = mode === 'new' ? name.trim() !== '' : target !== null;
  return (
    <Modal open title={`Szene speichern – ${display.name}`} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <p className="muted">Die aktuelle Anordnung ({display.layout.tiles.length} Kachel(n)) wird gespeichert.</p>
        {display.scenes.length > 0 && (
          <Segmented
            label="Speichern als"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'new', label: 'Neue Szene' },
              { value: 'overwrite', label: 'Bestehende überschreiben' },
            ]}
          />
        )}
        {mode === 'new' ? (
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="z. B. Anfahrt, Lage, Kameras" autoFocus />
          </Field>
        ) : (
          <Field label="Szene">
            <select value={target ?? ''} onChange={(e) => setTarget(Number(e.target.value))}>
              {display.scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn btn-primary" disabled={!valid || save.isPending}>
            <Save size={16} /> Speichern
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ManageDialog({ display, onClose }: { display: DisplayDevice; onClose: () => void }) {
  const toast = useToast();
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const onError = (e: Error) => toast('error', e.message);
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { name?: string; overwrite?: boolean } }) => api.updateDisplayScene(display.id, id, patch),
    onSuccess: (s, v) => (setRenaming(null), toast('success', v.patch.overwrite ? `Szene „${s.name}“ überschrieben` : `Umbenannt in „${s.name}“`)),
    onError,
  });
  const remove = useMutation({ mutationFn: (id: number) => api.removeDisplayScene(display.id, id), onError });
  const reorder = useMutation({ mutationFn: (ids: number[]) => api.reorderDisplayScenes(display.id, ids), onError });
  const move = (i: number, d: -1 | 1) => {
    const ids = display.scenes.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };
  const busy = update.isPending || remove.isPending || reorder.isPending;

  return (
    <Modal open title={`Szenen – ${display.name}`} onClose={onClose}>
      {display.scenes.length === 0 ? (
        <p className="muted">Noch keine Szenen gespeichert.</p>
      ) : (
        <ul className="scene-list">
          {display.scenes.map((s: DisplayScene, i) => (
            <li key={s.id}>
              {renaming?.id === s.id ? (
                <form
                  className="scene-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (renaming.name.trim()) update.mutate({ id: s.id, patch: { name: renaming.name.trim() } });
                  }}
                >
                  <input value={renaming.name} onChange={(e) => setRenaming({ id: s.id, name: e.target.value })} maxLength={60} autoFocus aria-label="Neuer Name" />
                  <button type="submit" className="btn btn-icon" aria-label="Namen übernehmen" disabled={busy}>
                    <Check size={16} />
                  </button>
                </form>
              ) : (
                <div className="scene-info">
                  <strong>{s.name}</strong>
                  {s.id === display.activeSceneId && <Badge tone="ok">angezeigt</Badge>}
                  <span className="cell-sub">
                    {s.tiles} Kachel(n) · {fmtDateTime(s.updatedAt)} · {s.updatedBy}
                  </span>
                </div>
              )}
              <span className="btn-row">
                <button type="button" className="btn btn-icon" aria-label={`${s.name} nach oben`} disabled={i === 0 || busy} onClick={() => move(i, -1)}>
                  <ArrowUp size={16} />
                </button>
                <button type="button" className="btn btn-icon" aria-label={`${s.name} nach unten`} disabled={i === display.scenes.length - 1 || busy} onClick={() => move(i, 1)}>
                  <ArrowDown size={16} />
                </button>
                <button type="button" className="btn btn-icon" aria-label={`${s.name} umbenennen`} disabled={busy} onClick={() => setRenaming({ id: s.id, name: s.name })}>
                  <Pencil size={16} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label={`${s.name} mit aktueller Anordnung überschreiben`}
                  title="Mit aktueller Anordnung überschreiben"
                  disabled={busy || s.id === display.activeSceneId}
                  onClick={() => window.confirm(`Szene „${s.name}“ mit der aktuellen Anordnung überschreiben?`) && update.mutate({ id: s.id, patch: { overwrite: true } })}
                >
                  <Save size={16} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label={`${s.name} löschen`}
                  disabled={busy}
                  onClick={() => window.confirm(`Szene „${s.name}“ löschen?`) && remove.mutate(s.id)}
                >
                  <Trash2 size={16} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Szenen eines Bildschirms: aufrufen per Klick, aktuelle Anordnung speichern, verwalten */
export function ScenesBar({ display, disabled }: { display: DisplayDevice; disabled?: boolean }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const apply = useMutation({
    mutationFn: (id: number) => api.applyDisplayScene(display.id, id),
    onError: (e) => toast('error', e.message),
  });
  return (
    <div className="scenes-bar" role="group" aria-label="Szenen">
      <span className="scenes-label">
        <Layers size={16} /> Szenen
      </span>
      {display.scenes.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`btn btn-sm scene-chip ${s.id === display.activeSceneId ? 'active' : ''}`}
          aria-pressed={s.id === display.activeSceneId}
          disabled={disabled || apply.isPending}
          onClick={() => s.id !== display.activeSceneId && apply.mutate(s.id)}
          title={s.id === display.activeSceneId ? 'Wird angezeigt' : `Szene „${s.name}“ anzeigen`}
        >
          {s.name}
        </button>
      ))}
      {display.scenes.length > 0 && display.activeSceneId === null && <span className="muted scenes-hint">Anordnung geändert</span>}
      <span className="btn-row scenes-actions">
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setDialog('save')}>
          <Save size={16} /> Als Szene speichern
        </button>
        {display.scenes.length > 0 && (
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setDialog('manage')} aria-label="Szenen verwalten">
            <Settings2 size={16} /> Verwalten
          </button>
        )}
      </span>
      {dialog === 'save' && <SaveDialog display={display} onClose={() => setDialog(null)} />}
      {dialog === 'manage' && <ManageDialog display={display} onClose={() => setDialog(null)} />}
    </div>
  );
}
