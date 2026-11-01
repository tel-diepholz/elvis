import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpToLine, Check, LayoutGrid, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  DASHBOARD_TILE_IDS,
  DASHBOARD_TILE_TYPES,
  DEFAULT_DASHBOARD,
  compactDashboard,
  findDashboardSpot,
  type DashboardTile,
  type DashboardTileType,
  type DisplayTile,
} from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useMediaQuery } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { DashboardGrid } from '../components/dashboard/DashboardGrid';
import { DASHBOARD_ICONS, HEADLESS } from '../components/dashboard/tiles';
import { TileSettings } from '../components/display/GridEditor';
import { Field, Loading, Modal } from '../components/ui';

/** Anonyme Arbeitsplätze: Grundeinstellung ohne Einsatzdaten (bis auf den Hinweis zur Anmeldung) */
const ANONYMOUS_TILES = compactDashboard(DEFAULT_DASHBOARD.tiles.filter((t) => t.type === 'incident' || !DASHBOARD_TILE_TYPES[t.type].requiresLogin));

const newId = (type: DashboardTileType) => `${type}-${Math.random().toString(36).slice(2, 8)}`;

export function DashboardPage() {
  const { user } = useAuth();
  const stacked = useMediaQuery('(max-width: 900px)');
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['dashboard', user?.id ?? 0], queryFn: api.dashboard, enabled: !!user });
  const [draft, setDraft] = useState<DashboardTile[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const editing = draft !== null;

  // Abmelden oder Wechsel auf schmale Ansicht beendet das Bearbeiten
  useEffect(() => {
    if (!user || stacked) setDraft(null);
  }, [user, stacked]);

  const save = useMutation({
    mutationFn: (tiles: DashboardTile[]) => api.saveDashboard({ tiles }),
    onSuccess: (res) => {
      qc.setQueryData(['dashboard', user?.id ?? 0], res);
      setDraft(null);
      toast('success', 'Übersicht gespeichert');
    },
    onError: (e) => toast('error', e.message),
  });
  const reset = useMutation({
    mutationFn: api.resetDashboard,
    onSuccess: (res) => {
      qc.setQueryData(['dashboard', user?.id ?? 0], res);
      setDraft(null);
      toast('success', 'Grundeinstellung wiederhergestellt');
    },
    onError: (e) => toast('error', e.message),
  });

  if (user && !data) return <Loading />;
  const saved = user ? data!.layout.tiles : ANONYMOUS_TILES;
  const tiles = draft ?? saved;
  const settingsTile = draft?.find((t) => t.id === settingsId) ?? null;

  const add = (type: DashboardTileType) => {
    const { w, h } = DASHBOARD_TILE_TYPES[type].size;
    const spot = findDashboardSpot(tiles, w, h);
    setDraft([...tiles, { id: newId(type), type, ...spot, w, h, config: {} }]);
    setAdding(false);
  };
  const remove = (id: string) => {
    setDraft(tiles.filter((t) => t.id !== id));
    setSettingsId(null);
  };
  const setConfig = (id: string, config: DashboardTile['config']) => setDraft(tiles.map((t) => (t.id === id ? { ...t, config } : t)));

  return (
    <div className="dashboard">
      {user && !stacked && (
        <div className={`dash-toolbar ${editing ? 'editing' : ''}`}>
          {editing ? (
            <>
              <strong className="dash-toolbar-title">Übersicht anpassen</strong>
              <span className="muted dash-toolbar-hint">Kacheln ziehen zum Verschieben, Ecke unten rechts zum Ändern der Größe</span>
              <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                <Plus size={16} /> Kachel hinzufügen
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setDraft(compactDashboard(tiles))} title="Leere Zeilen über den Kacheln entfernen">
                <ArrowUpToLine size={16} /> Lücken schließen
              </button>
              {data?.custom && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={reset.isPending}
                  onClick={() => window.confirm('Eigene Anordnung verwerfen und die Grundeinstellung wiederherstellen?') && reset.mutate()}
                >
                  <RotateCcw size={16} /> Grundeinstellung
                </button>
              )}
              <span className="dash-toolbar-spacer" />
              <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>
                Abbrechen
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={save.isPending} onClick={() => save.mutate(tiles)}>
                <Check size={16} /> Speichern
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(saved)} title="Kacheln dieser Übersicht für Ihren Benutzer anordnen">
              <LayoutGrid size={16} /> Anpassen
            </button>
          )}
        </div>
      )}

      {tiles.length ? (
        <DashboardGrid tiles={tiles} editing={editing} stacked={stacked} onChange={setDraft} onSettings={setSettingsId} onRemove={remove} />
      ) : (
        <div className="dash-empty">
          <p className="muted">Keine Kacheln auf der Übersicht.</p>
          {editing && (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <Plus size={16} /> Kachel hinzufügen
            </button>
          )}
        </div>
      )}

      <Modal open={adding} title="Kachel hinzufügen" onClose={() => setAdding(false)} wide>
        <div className="dash-catalog">
          {DASHBOARD_TILE_IDS.map((type) => {
            const info = DASHBOARD_TILE_TYPES[type];
            const Icon = DASHBOARD_ICONS[type];
            const count = tiles.filter((t) => t.type === type).length;
            return (
              <button key={type} type="button" className="dash-catalog-item" onClick={() => add(type)}>
                <Icon size={22} />
                <span>
                  <strong>{info.label}</strong>
                  {count > 0 && <span className="muted"> · {count}× vorhanden</span>}
                  <span className="cell-sub">{info.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Modal>

      <Modal open={!!settingsTile} title={settingsTile ? DASHBOARD_TILE_TYPES[settingsTile.type].label : ''} onClose={() => setSettingsId(null)}>
        {settingsTile && <DashboardTileSettings tile={settingsTile} onChange={(c) => setConfig(settingsTile.id, c)} onRemove={() => remove(settingsTile.id)} />}
      </Modal>
    </div>
  );
}

/** Eigene Kacheln der Übersicht ohne weitere Einstellungen */
const OWN_TYPES: ReadonlySet<DashboardTileType> = new Set(['incident', 'journal', 'messages', 'radio', 'energy', 'monitoring']);

function DashboardTileSettings({ tile, onChange, onRemove }: { tile: DashboardTile; onChange: (config: DashboardTile['config']) => void; onRemove: () => void }) {
  return (
    <div className="tile-settings">
      {!HEADLESS.has(tile.type) && (
        <Field label="Überschrift" hint={`leer = „${DASHBOARD_TILE_TYPES[tile.type].label}“`}>
          <input value={String(tile.config.heading ?? '')} maxLength={60} onChange={(e) => onChange({ ...tile.config, heading: e.target.value.slice(0, 60) })} />
        </Field>
      )}
      {OWN_TYPES.has(tile.type) ? (
        <>
          <p className="muted">{DASHBOARD_TILE_TYPES[tile.type].description}</p>
          <button type="button" className="btn" onClick={onRemove}>
            <Trash2 size={16} /> Kachel entfernen
          </button>
        </>
      ) : (
        <TileSettings tile={tile as DisplayTile} onChange={onChange} onRemove={onRemove} />
      )}
    </div>
  );
}
