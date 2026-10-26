import { useEffect, useMemo, useState } from 'react';
import { CircleMarker, GeoJSON, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, ExternalLink, ListPlus, Plus, Save, Search, Trash2, X } from 'lucide-react';
import {
  buildOverpassQl,
  overpassBadge,
  overpassBoundsSchema,
  overpassQuerySchema,
  toMgrs,
  MAP_OBJECT_COLORS,
  OVERPASS_ELEMENTS,
  OVERPASS_MAX_FEATURES,
  OVERPASS_OPS,
  type Incident,
  type NewMapObject,
  type OverpassBounds,
  type OverpassElements,
  type OverpassFeature,
  type OverpassFilter,
  type OverpassOp,
  type OverpassQuery,
  type OverpassResult,
  type OverpassStatus,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Field, Segmented } from '../../components/ui';
import { MapIcon, MapIconPicker, useMapIcons } from '../../components/map/mapIcons';
import { pointIcon, pointSymbol } from '../../components/map/objects';

/** Farbe der Overpass-Treffer ohne eigene Farbe der Abfrage: hebt sich von Kartenobjekten (Blau) und Suchtreffern ab */
export const OVERPASS_COLOR = '#d81b60';

export const NEW_OVERPASS_QUERY: OverpassQuery = { name: 'Neue Abfrage', mode: 'simple', elements: 'nwr', filters: [{ key: 'amenity', op: '=', value: '' }], ql: '', icon: null, badge: '', color: null };

/** Nur die Felder der Abfrage (gespeicherte Abfragen bringen Kennung und Autor mit) */
export const queryFields = ({ name, mode, elements, filters, ql, icon, badge, color }: OverpassQuery): OverpassQuery => ({ name, mode, elements, filters, ql, icon, badge, color });

/** Erste Fehlermeldung der Prüfung, null wenn die Abfrage passt */
export function overpassProblem(q: OverpassQuery): string | null {
  const r = overpassQuerySchema.safeParse(q);
  return r.success ? null : r.error.issues[0]!.message;
}

/** Treffer einer Abfrage; die Abfrage bestimmt Symbol und Schild */
export interface OverpassHits {
  query: OverpassQuery;
  result: OverpassResult;
}

/** Abfrage im aktuellen Kartenausschnitt ausführen – aus dem Menü „Objekte“ (Vorlagen) und dem Abfragebereich */
export function useOverpassRun(bounds: () => OverpassBounds | null, onHits: (h: OverpassHits) => void) {
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: ({ query, b }: { query: OverpassQuery; b: OverpassBounds }) => api.overpassRun(query, b),
    onSuccess: (result, { query }) => onHits({ query, result }),
    onError: (e) => toast('error', e.message),
  });
  const run = (query: OverpassQuery) => {
    const b = bounds();
    if (!b) return;
    const checked = overpassBoundsSchema.safeParse(b);
    if (!checked.success) return toast('error', checked.error.issues[0]!.message);
    mutation.mutate({ query, b: checked.data });
  };
  /** Gerade laufende Abfrage (für die Ladeanzeige), sonst null */
  const running = mutation.isPending ? (mutation.variables?.query ?? null) : null;
  return { run, pending: mutation.isPending, running, error: mutation.error };
}
export type OverpassRunner = ReturnType<typeof useOverpassRun>;

/** Abfrage bearbeiten: einfacher Tag-Filter (erzeugt QL) oder Overpass QL, dazu Symbol und Schild der Treffer */
export function OverpassQueryEditor({ value, onChange }: { value: OverpassQuery; onChange: (q: OverpassQuery) => void }) {
  const [picking, setPicking] = useState(false);
  const set = (p: Partial<OverpassQuery>) => onChange({ ...value, ...p });
  const setFilter = (i: number, p: Partial<OverpassFilter>) => set({ filters: value.filters.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  return (
    <div className="overpass-editor">
      <Field label="Name">
        <input value={value.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Segmented
        label="Art der Abfrage"
        value={value.mode}
        options={[
          { value: 'simple', label: 'Einfach' },
          { value: 'ql', label: 'Overpass QL' },
        ]}
        // Beim Wechsel zu QL das erzeugte QL übernehmen, damit man darauf aufbauen kann
        onChange={(mode) => set(mode === 'ql' && value.mode === 'simple' ? { mode, ql: buildOverpassQl(value.elements, value.filters) } : { mode })}
      />
      {value.mode === 'simple' ? (
        <>
          <Field label="Objekte">
            <select value={value.elements} onChange={(e) => set({ elements: e.target.value as OverpassElements })}>
              {OVERPASS_ELEMENTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="overpass-filters" role="group" aria-label="Filter (alle müssen zutreffen)">
            {value.filters.map((f, i) => (
              <div key={i} className="overpass-filter">
                <input className="mono" aria-label="Schlüssel" placeholder="Schlüssel" value={f.key} maxLength={100} onChange={(e) => setFilter(i, { key: e.target.value })} />
                <select aria-label="Vergleich" value={f.op} onChange={(e) => setFilter(i, { op: e.target.value as OverpassOp })}>
                  {OVERPASS_OPS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  className="mono"
                  aria-label="Wert"
                  placeholder={f.op === 'exists' ? '' : 'Wert'}
                  disabled={f.op === 'exists'}
                  value={f.op === 'exists' ? '' : f.value}
                  maxLength={200}
                  onChange={(e) => setFilter(i, { value: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="Filter entfernen"
                  disabled={value.filters.length === 1}
                  onClick={() => set({ filters: value.filters.filter((_, j) => j !== i) })}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-sm" disabled={value.filters.length >= 10} onClick={() => set({ filters: [...value.filters, { key: '', op: '=', value: '' }] })}>
            <Plus size={14} /> Filter (alle müssen zutreffen)
          </button>
          <pre className="overpass-preview mono">{buildOverpassQl(value.elements, value.filters)}</pre>
        </>
      ) : (
        <Field label="Abfrage" hint="{{bbox}} steht für den Kartenausschnitt. Mit „out geom;“ kommen Linien und Flächen mit, „out center;“ liefert nur Punkte.">
          <textarea className="mono overpass-ql" rows={8} spellCheck={false} value={value.ql} maxLength={10_000} onChange={(e) => set({ ql: e.target.value })} />
        </Field>
      )}

      <div className="overpass-look">
        <span className="field-label">Symbol der Treffer</span>
        <button type="button" className="btn btn-sm" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
          {value.icon ? (
            <>
              <MapIcon name={value.icon} /> {value.icon}
            </>
          ) : (
            'Kreis (kein Symbol)'
          )}
        </button>
      </div>
      {picking && <MapIconPicker value={value.icon} label="Symbol der Treffer" onPick={(icon) => (set({ icon }), setPicking(false))} />}
      <div className="overpass-look">
        <span className="field-label">Farbe</span>
        <div className="overpass-colors" role="radiogroup" aria-label="Farbe der Treffer">
          {MAP_OBJECT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={value.color === c.value}
              aria-label={c.label}
              title={c.label}
              className={`map-color ${value.color === c.value ? 'active' : ''}`}
              style={{ background: c.value }}
              onClick={() => set({ color: c.value })}
            />
          ))}
          <button type="button" role="radio" aria-checked={!value.color} className={`btn btn-sm ${value.color ? '' : 'active'}`} onClick={() => set({ color: null })}>
            Standard
          </button>
        </div>
      </div>
      <Field label="Schild am Symbol" hint="Tag-Werte in geschweiften Klammern, z. B. „DN {fire_hydrant:diameter}“. Fehlen alle Werte, gibt es kein Schild.">
        <input className="mono" value={value.badge} maxLength={120} placeholder="z. B. DN {fire_hydrant:diameter}" onChange={(e) => set({ badge: e.target.value })} />
      </Field>
    </div>
  );
}

function statusText(status: OverpassStatus | undefined): string {
  if (!status) return '';
  if (status.source === 'local') return `Quelle: ${status.name} – funktioniert offline`;
  if (status.source === 'online') return `Quelle: ${status.name} (öffentlich, Internet nötig) – die Overpass-API des Addons „OSM-Daten“ ist nicht bereit`;
  return 'Kein Overpass-Server eingerichtet';
}

/** Zusammenfassung der Treffer (Abfragebereich und Meldung nach einer Vorlage) */
export function overpassResultText(r: OverpassResult): string[] {
  const lines = [
    `${r.features.length ? `${r.features.length} Treffer` : 'Keine Treffer im Kartenausschnitt'}${r.truncated ? ` (nur die ersten ${OVERPASS_MAX_FEATURES})` : ''} · ${r.sourceName}${r.source === 'online' ? ' (öffentlich)' : ''}`,
  ];
  if (r.skipped) lines.push(`${r.skipped} Elemente ohne Geometrie ausgelassen – „out geom;“ oder „out center;“ verwenden`);
  if (r.remark) lines.push(`Hinweis von Overpass: ${r.remark}`);
  return lines;
}

/**
 * Bereich „OpenStreetMap abfragen“ (aus dem Menü „Objekte“) unter der Werkzeugleiste: Vorlage laden (aus den
 * Einstellungen oder im Einsatz gespeichert), Abfrage bearbeiten, im Kartenausschnitt ausführen und im Einsatz
 * speichern. Bleibt beim Klick in die Karte offen; Esc oder X schließt. Die Abfrage bleibt beim Schließen erhalten.
 */
export function OverpassPanel({
  open,
  onClose,
  incident,
  loggedIn,
  canEdit,
  templates,
  runner,
  hits,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  incident: Incident | null | undefined;
  loggedIn: boolean;
  /** Im laufenden Einsatz speichern */
  canEdit: boolean;
  /** Vorlagen aus den Einstellungen */
  templates: OverpassQuery[];
  runner: OverpassRunner;
  hits: OverpassHits | null;
  onClear: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const incidentId = incident?.id;
  const { data: saved = [] } = useQuery({
    queryKey: ['overpassQueries', 'incident', incidentId],
    queryFn: () => api.incidentOverpassQueries(incidentId!),
    enabled: !!incidentId && loggedIn,
  });
  // Bereitschaft des Addons ändert sich mit dessen Status (Thema „addons“)
  const { data: status } = useQuery({ queryKey: ['addons', 'overpassStatus'], queryFn: api.overpassStatus, staleTime: 30_000 });
  const [draft, setDraft] = useState<OverpassQuery>(NEW_OVERPASS_QUERY);
  /** Gewählte Vorlage: „tpl:<Index>“ oder „inc:<Kennung>“ */
  const [selected, setSelected] = useState('');
  const savedId = selected.startsWith('inc:') ? Number(selected.slice(4)) : null;
  const problem = overpassProblem(draft);

  const pick = (key: string) => {
    setSelected(key);
    const q = key.startsWith('tpl:') ? templates[Number(key.slice(4))] : saved.find((s) => `inc:${s.id}` === key);
    if (q) setDraft(queryFields(q));
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['overpassQueries', 'incident', incidentId] });
  const save = useMutation({
    mutationFn: () => {
      // Gleicher Name im Einsatz: überschreiben statt doppelt anlegen
      const same = saved.find((s) => s.name === draft.name.trim());
      return same ? api.saveIncidentOverpassQuery(same.id, draft) : api.addIncidentOverpassQuery(incidentId!, draft);
    },
    onSuccess: (q) => (void invalidate(), setSelected(`inc:${q.id}`), toast('success', `„${q.name}“ im Einsatz gespeichert`)),
    onError: (e) => toast('error', e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.removeIncidentOverpassQuery(id),
    onSuccess: () => (void invalidate(), setSelected(''), toast('success', 'Abfrage gelöscht')),
    onError: (e) => toast('error', e.message),
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="map-overlay map-overpass" role="dialog" aria-label="OpenStreetMap abfragen">
      <div className="map-overpass-head">
        <Database size={18} />
        <strong>OpenStreetMap abfragen</strong>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Schließen" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="map-overpass-row">
        <select aria-label="Vorlage" value={selected} onChange={(e) => pick(e.target.value)}>
          <option value="">Vorlage laden …</option>
          {templates.length > 0 && (
            <optgroup label="Vorlagen">
              {templates.map((q, i) => (
                <option key={i} value={`tpl:${i}`}>
                  {q.name}
                </option>
              ))}
            </optgroup>
          )}
          {saved.length > 0 && (
            <optgroup label="Im Einsatz gespeichert">
              {saved.map((q) => (
                <option key={q.id} value={`inc:${q.id}`}>
                  {q.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {savedId !== null && canEdit && (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Gespeicherte Abfrage löschen"
            title="Gespeicherte Abfrage löschen"
            disabled={remove.isPending}
            onClick={() => window.confirm(`Abfrage „${draft.name}“ aus dem Einsatz löschen?`) && remove.mutate(savedId)}
          >
            <Trash2 size={17} />
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => (setSelected(''), setDraft(NEW_OVERPASS_QUERY))}>
          <Plus size={14} /> Neu
        </button>
      </div>

      <OverpassQueryEditor value={draft} onChange={setDraft} />
      {problem && <p className="tone-alarm map-overpass-problem">{problem}</p>}

      <div className="map-overpass-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!!problem || runner.pending} onClick={() => runner.run(draft)}>
          <Search size={14} /> {runner.pending ? 'Abfrage läuft …' : 'Im Kartenausschnitt suchen'}
        </button>
        {canEdit && (
          <button type="button" className="btn btn-sm" disabled={!!problem || save.isPending} onClick={() => save.mutate()}>
            <Save size={14} /> Im Einsatz speichern
          </button>
        )}
        {hits && (
          <button type="button" className="btn btn-sm" onClick={onClear}>
            <X size={14} /> Treffer entfernen
          </button>
        )}
      </div>
      <div className="map-overpass-status muted" role="status">
        {runner.error ? (
          <p className="tone-alarm">{runner.error.message}</p>
        ) : hits ? (
          [`„${hits.query.name}“`, ...overpassResultText(hits.result)].map((l) => <p key={l}>{l}</p>)
        ) : (
          <p>{statusText(status)}</p>
        )}
      </div>
    </div>
  );
}

/** Treffer als Kartenobjekt: Fläche mit Umriss, Linie oder Punkt (mit Symbol und Schild der Abfrage); osm merkt sich das OSM-Objekt */
export function featureObject(f: OverpassFeature, query: OverpassQuery): NewMapObject {
  const base = { name: f.name, lat: f.lat, lon: f.lon, color: query.color };
  const g = f.geometry;
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') return { ...base, kind: 'area', data: { detail: f.detail, osm: f.id, outline: g } };
  if (g.type === 'LineString' || g.type === 'MultiLineString') return { ...base, kind: 'line', data: { detail: f.detail, osm: f.id, path: g } };
  return { ...base, kind: 'point', data: { detail: f.detail, osm: f.id, icon: query.icon, badge: overpassBadge(query.badge, f.tags) || null } };
}

const OSM_TYPES: Record<string, string> = { N: 'node', W: 'way', R: 'relation' };

function FeaturePopup({ feature: f, taken, adding, onAdd }: { feature: OverpassFeature; taken: boolean; adding: boolean; onAdd?: (f: OverpassFeature) => void }) {
  const tags = Object.entries(f.tags);
  return (
    <>
      <strong>{f.name}</strong>
      {f.detail && (
        <>
          <br />
          {f.detail}
        </>
      )}
      <br />
      <span className="mono">UTMREF {toMgrs(f.lat, f.lon)}</span>
      {tags.length > 0 && (
        <details className="map-overpass-tags">
          <summary>{tags.length} Tags</summary>
          <table>
            <tbody>
              {tags.map(([k, v]) => (
                <tr key={k}>
                  <th className="mono">{k}</th>
                  <td className="mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <span className="map-popup-actions">
        {onAdd && (
          <button type="button" className="btn btn-sm" disabled={adding || taken} onClick={() => onAdd(f)}>
            <ListPlus size={14} /> {taken ? 'In der Objektliste' : 'Zur Objektliste'}
          </button>
        )}
        <a className="btn btn-sm" href={`https://www.openstreetmap.org/${OSM_TYPES[f.id[0]!]}/${f.id.slice(1)}`} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> OSM
        </a>
      </span>
    </>
  );
}

/**
 * Overpass-Treffer in der Karte, wie Suchtreffer: Punkte als Kreis oder mit dem Symbol der Abfrage (samt Schild aus
 * den Tags), Flächen und Linien mit Verlauf (Flächen zusätzlich mit Punkt in der Mitte, damit sie auch klein
 * auffallen). Ein Klick öffnet das Popup mit „Zur Objektliste“.
 */
export function OverpassLayer({ hits, taken, adding, onAdd }: { hits: OverpassHits; taken: Set<string>; adding: boolean; onAdd?: (f: OverpassFeature) => void }) {
  const { query, result } = hits;
  const color = query.color ?? OVERPASS_COLOR;
  // Viele Punkte ohne Symbol: Canvas statt einzelner SVG-Elemente
  const renderer = useMemo(() => L.canvas({ padding: 0.5 }), []);
  const icons = useMapIcons(!!query.icon);
  const symbol = pointSymbol(icons, query.icon);
  const popup = (f: OverpassFeature) => (
    <Popup>
      <FeaturePopup feature={f} taken={taken.has(f.id)} adding={adding} onAdd={onAdd} />
    </Popup>
  );
  const dot = (f: OverpassFeature, radius: number) => {
    const badge = overpassBadge(query.badge, f.tags);
    if (symbol || badge)
      return (
        <Marker key={`${f.id}:dot`} position={[f.lat, f.lon]} icon={pointIcon(color, symbol, badge)}>
          {popup(f)}
        </Marker>
      );
    return (
      <CircleMarker key={`${f.id}:dot`} center={[f.lat, f.lon]} radius={radius} pathOptions={{ renderer, color: '#ffffff', weight: 2, fillColor: color, fillOpacity: 0.9 }}>
        {popup(f)}
      </CircleMarker>
    );
  };
  return (
    <>
      {result.features.map((f) => {
        const g = f.geometry;
        if (g.type === 'Point') return dot(f, 7);
        const area = g.type === 'Polygon' || g.type === 'MultiPolygon';
        return [
          <GeoJSON
            key={f.id}
            data={g}
            style={area ? { color, weight: 2, fillColor: color, fillOpacity: 0.15 } : { color, weight: 4, opacity: 0.85, lineCap: 'round' }}
          >
            {popup(f)}
          </GeoJSON>,
          area ? dot(f, 5) : null,
        ];
      })}
    </>
  );
}
