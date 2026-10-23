import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Eye, LayoutGrid, MonitorSmartphone, Plus, RotateCw, Save, X } from 'lucide-react';
import { DISPLAY_TILE_IDS, DISPLAY_TILE_TYPES, findFreeSpot, type DisplayDevice, type DisplayLayout, type DisplayTileType } from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { DisplayCanvas, ScaledScreen } from '../components/display/DisplayCanvas';
import { GridEditor, TileSettings } from '../components/display/GridEditor';
import { ScenesBar } from '../components/display/ScenesBar';
import { Badge, Card, EmptyState, PageHeader } from '../components/ui';

const SELECTED_KEY = 'elvis.display';
const readSelected = () => {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
};
const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function Editor({ display, onDone }: { display: DisplayDevice; onDone: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<DisplayLayout>(display.layout);
  const [selected, setSelected] = useState<string | null>(null);
  const tile = draft.tiles.find((t) => t.id === selected) ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(display.layout);

  const save = useMutation({
    mutationFn: () => api.saveDisplayLayout(display.id, draft),
    onSuccess: () => (toast('success', `${display.name}: Layout übernommen`), onDone()),
    onError: (e) => toast('error', e.message),
  });

  const add = (type: DisplayTileType) => {
    const { w, h } = DISPLAY_TILE_TYPES[type].size;
    // passt die Standardgröße nicht, schrittweise kleiner versuchen
    for (let ww = w, hh = h; ww >= 1 && hh >= 1; ww > hh ? ww-- : hh--) {
      const spot = findFreeSpot(draft, ww, hh);
      if (spot) {
        const id = newId();
        setDraft({ ...draft, tiles: [...draft.tiles, { id, type, ...spot, w: ww, h: hh, config: {} }] });
        setSelected(id);
        return;
      }
    }
    toast('error', 'Kein freier Platz im Raster – Kacheln verkleinern oder entfernen');
  };

  const resizeGrid = (cols: number, rows: number) => {
    const outside = draft.tiles.filter((t) => t.x + t.w > cols || t.y + t.h > rows);
    if (outside.length) return toast('error', `${outside.length} Kachel(n) lägen außerhalb – zuerst verschieben oder verkleinern`);
    setDraft({ ...draft, cols, rows });
  };

  return (
    <div className="display-editor">
      <div className="display-editor-main">
        <div className="display-editor-toolbar">
          <select
            value=""
            aria-label="Kachel hinzufügen"
            onChange={(e) => {
              if (e.target.value) add(e.target.value as DisplayTileType);
              e.target.value = '';
            }}
          >
            <option value="">+ Kachel hinzufügen …</option>
            {DISPLAY_TILE_IDS.map((t) => (
              <option key={t} value={t}>
                {DISPLAY_TILE_TYPES[t].label}
              </option>
            ))}
          </select>
          <label className="display-editor-grid">
            Raster
            <select value={draft.cols} onChange={(e) => resizeGrid(Number(e.target.value), draft.rows)} aria-label="Spalten">
              {[4, 6, 8, 12, 16, 24].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            ×
            <select value={draft.rows} onChange={(e) => resizeGrid(draft.cols, Number(e.target.value))} aria-label="Zeilen">
              {[3, 4, 6, 8, 9, 12, 16].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="btn-row">
            <button type="button" className="btn" onClick={onDone}>
              <X size={16} /> Verwerfen
            </button>
            <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              <Save size={16} /> Speichern
            </button>
          </span>
        </div>
        <GridEditor layout={draft} screen={display.screen} selectedId={selected} onSelect={setSelected} onChange={setDraft} />
        <p className="field-hint">Kacheln ziehen zum Verschieben, an der Ecke unten rechts ziehen für die Größe. Tastatur: Pfeiltasten verschieben, Umschalt+Pfeil ändert die Größe.</p>
      </div>
      <Card title={tile ? 'Kachel' : 'Hinweis'} icon={<LayoutGrid size={18} />} className="display-editor-side">
        {tile ? (
          <TileSettings
            tile={tile}
            onChange={(config) => setDraft({ ...draft, tiles: draft.tiles.map((t) => (t.id === tile.id ? { ...t, config } : t)) })}
            onRemove={() => (setDraft({ ...draft, tiles: draft.tiles.filter((t) => t.id !== tile.id) }), setSelected(null))}
          />
        ) : (
          <p className="muted">Kachel anklicken, um sie einzustellen. Neue Kacheln über „Kachel hinzufügen“ – sie landen an der ersten freien Stelle.</p>
        )}
      </Card>
    </div>
  );
}

export function DisplaysPage() {
  const toast = useToast();
  const { user } = useAuth();
  const { data: displays } = useQuery({ queryKey: ['displays'], queryFn: api.displays });
  const [selected, setSelected] = useState<string | null>(readSelected);
  const [editing, setEditing] = useState(false);
  const command = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'reload' | 'identify' }) => api.displayCommand(id, action),
    onError: (e) => toast('error', e.message),
  });
  const header = <PageHeader title="Bildschirme" subtitle="Inhalte der Bildschirme im Fahrzeug steuern" />;

  if (!displays) return header;
  if (displays.length === 0)
    return (
      <>
        {header}
        <EmptyState icon={<MonitorSmartphone size={32} />} title="Noch keine Bildschirme gekoppelt">
          Auf dem Bildschirm (Kiosk-Browser) <code>{`${location.origin}/bildschirm`}</code> öffnen – er zeigt einen Code. {user?.isAdmin ? <Link to="/system">Unter System → Bildschirme koppeln.</Link> : 'Ein Admin koppelt ihn unter System → Bildschirme.'}
        </EmptyState>
      </>
    );

  const display = displays.find((d) => d.id === selected) ?? displays[0]!;
  const choose = (id: string) => {
    if (editing) return;
    setSelected(id);
    try {
      localStorage.setItem(SELECTED_KEY, id);
    } catch {
      /* nur Komfort */
    }
  };

  return (
    <>
      <div className="display-switcher" role="tablist" aria-label="Bildschirm wählen">
        {displays.map((d) => (
          <button key={d.id} type="button" role="tab" aria-selected={d.id === display.id} className={`btn display-chip ${d.id === display.id ? 'active' : ''}`} disabled={editing && d.id !== display.id} onClick={() => choose(d.id)}>
            <span className={`dot tone-bg-${d.online ? 'ok' : 'muted'}`} /> {d.name}
          </button>
        ))}
      </div>

      {editing ? (
        <Editor key={display.id} display={display} onDone={() => setEditing(false)} />
      ) : (
        <div className="display-view">
          <div className="display-view-head">
            <div>
              <strong>{display.name}</strong>{' '}
              <Badge tone={display.online ? 'ok' : 'muted'}>{display.online ? 'verbunden' : 'offline'}</Badge>
              <div className="cell-sub">
                {display.screen ? `${display.screen.width}×${display.screen.height}` : 'Auflösung unbekannt'} · {display.layout.tiles.length} Kachel(n)
                {display.lastSeenAt && !display.online && ` · zuletzt ${fmtDateTime(display.lastSeenAt)}`}
              </div>
            </div>
            <span className="btn-row">
              <button type="button" className="btn" disabled={!display.online || command.isPending} onClick={() => command.mutate({ id: display.id, action: 'identify' })} title="Namen auf dem Bildschirm einblenden">
                <Eye size={16} /> Erkennen
              </button>
              <button type="button" className="btn" disabled={!display.online || command.isPending} onClick={() => command.mutate({ id: display.id, action: 'reload' })}>
                <RotateCw size={16} /> Neu laden
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
                <LayoutGrid size={16} /> Konfigurieren
              </button>
            </span>
          </div>
          <ScenesBar display={display} />
          <ScaledScreen screen={display.screen} className="display-preview">
            {display.layout.tiles.length ? (
              <DisplayCanvas layout={display.layout} />
            ) : (
              <div className="display-center display-pairing">
                <MonitorSmartphone size={96} />
                <h1>{display.name}</h1>
                <p>Noch keine Inhalte – über „Konfigurieren“ Kacheln hinzufügen.</p>
              </div>
            )}
          </ScaledScreen>
        </div>
      )}
    </>
  );
}
