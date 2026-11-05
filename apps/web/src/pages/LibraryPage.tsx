import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MapContainer, Marker, TileLayer, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileText, MapPinned, Paperclip, Plus, Search, Trash2 } from 'lucide-react';
import {
  formatProp,
  objectBadge,
  toMgrs,
  type GeocodeResult,
  type LibraryObject,
  type LibraryObjectDetail,
  type LibraryObjectInput,
  type ObjectField,
  type ObjectProps,
  type ObjectType,
} from '@elvis/shared';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { useVehiclePosition } from '../lib/hooks';
import { autoSource } from '../lib/mapSources';
import { effectiveTheme, useTheme } from '../lib/theme';
import { fmtBytes } from '../lib/format';
import { Badge, EmptyState, Field, Loading, Modal, PageHeader } from '../components/ui';
import { pointIcon, pointSymbol } from '../components/map/objects';
import { MapIcon, useMapIcons } from '../components/map/mapIcons';
import { useLibraryTypes } from '../components/map/library';
import { MapSearch } from './map/search';

const FALLBACK: [number, number] = [51.16, 10.45];
/** So viele Objekte zeigt die Liste auf einmal; den Rest findet die Suche */
const SHOWN = 300;

function useCenter(): [number, number] {
  const { position } = useVehiclePosition();
  return position ? [position.lat, position.lon] : FALLBACK;
}

function Tiles() {
  const { data: sources = [] } = useQuery({ queryKey: ['mapSources'], queryFn: api.mapSources, staleTime: Infinity });
  const source = autoSource(sources, effectiveTheme(useTheme()) === 'dark');
  return source ? <TileLayer url={api.tileUrl(source.id)} maxZoom={20} maxNativeZoom={source.maxZoom} /> : null;
}

/** Im Dialog kennt Leaflet die Größe erst nach dem Einblenden; danach neu vermessen */
function useResize(map: L.Map | null, center?: [number, number]) {
  useEffect(() => {
    if (!map) return;
    const t = setTimeout(() => {
      map.invalidateSize();
      if (center) map.setView(center, map.getZoom(), { animate: false });
    }, 250);
    return () => clearTimeout(t);
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps
}

function ClickToPlace({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

/** Eingabe eines Feldes je nach Art */
function FieldInput({ field: f, value, onChange }: { field: ObjectField; value: ObjectProps[string] | undefined; onChange: (v: ObjectProps[string] | undefined) => void }) {
  const str = value === undefined ? '' : String(value);
  switch (f.type) {
    case 'bool':
      return (
        <select value={value === undefined ? '' : value ? 'ja' : 'nein'} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'ja')}>
          <option value="">–</option>
          <option value="ja">ja</option>
          <option value="nein">nein</option>
        </select>
      );
    case 'select':
      return (
        <select value={str} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">–</option>
          {f.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'longtext':
      return <textarea rows={3} maxLength={2000} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input inputMode="decimal" value={str.replace('.', ',')} onChange={(e) => onChange(e.target.value)} />;
    case 'url':
      return <input type="url" placeholder="https://" value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'phone':
      return <input type="tel" value={str} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input maxLength={2000} value={str} onChange={(e) => onChange(e.target.value)} />;
  }
}

function ObjectEditor({ initial, types, onDone }: { initial: LibraryObjectDetail | { typeId: number }; types: ObjectType[]; onDone: () => void }) {
  const toast = useToast();
  const existing = 'id' in initial ? initial : null;
  const center = useCenter();
  const icons = useMapIcons();
  const [typeId, setTypeId] = useState(initial.typeId);
  const [name, setName] = useState(existing?.name ?? '');
  const [address, setAddress] = useState(existing?.address ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [props, setProps] = useState<Record<string, ObjectProps[string] | undefined>>(existing?.props ?? {});
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(existing ? { lat: existing.lat, lon: existing.lon } : null);
  const [map, setMap] = useState<L.Map | null>(null);
  useResize(map, pos ? [pos.lat, pos.lon] : center);
  const type = types.find((t) => t.id === typeId) ?? types[0]!;
  const { data: detail } = useQuery({ queryKey: ['library', 'object', existing?.id], queryFn: () => api.libraryObject(existing!.id), enabled: !!existing, initialData: existing ?? undefined });
  const err = (e: Error) => toast('error', e.message);

  const save = useMutation({
    mutationFn: (input: LibraryObjectInput) => (existing ? api.updateLibraryObject(existing.id, input) : api.createLibraryObject(input)),
    onSuccess: (o) => {
      toast('success', `${o.name} gespeichert`);
      if (existing) onDone();
      else setSaved(o);
    },
    onError: err,
  });
  // Neues Objekt: nach dem Speichern im Editor bleiben, damit sich Dateien anhängen lassen
  const [saved, setSaved] = useState<LibraryObjectDetail | null>(null);
  const objectId = existing?.id ?? saved?.id ?? null;
  const { data: files = [] } = useQuery({
    queryKey: ['library', 'object', objectId],
    queryFn: () => api.libraryObject(objectId!),
    enabled: objectId !== null,
    select: (o) => o.files,
    initialData: detail ?? saved ?? undefined,
  });
  const upload = useMutation({ mutationFn: (file: File) => api.uploadLibraryFile(objectId!, file), onError: err });
  const removeFile = useMutation({ mutationFn: api.removeLibraryFile, onError: err });
  const remove = useMutation({ mutationFn: () => api.removeLibraryObject(objectId!), onSuccess: onDone, onError: err });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pos) return toast('error', 'Bitte die Position in der Karte setzen');
    const clean: ObjectProps = {};
    for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== '') clean[k] = typeof v === 'string' && type.fields.find((f) => f.key === k)?.type === 'number' ? v.replace(',', '.') : v;
    save.mutate({ typeId, name, address, notes, lat: pos.lat, lon: pos.lon, props: clean });
  };
  const pick = (r: GeocodeResult) => {
    setPos({ lat: r.lat, lon: r.lon });
    if (!address) setAddress([r.name, r.detail.split(' · ')[0]].filter(Boolean).join(', '));
    map?.setView([r.lat, r.lon], Math.max(map.getZoom(), 17));
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Typ">
          <select value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name *">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus={!existing} placeholder={type.builtin === 'water' ? 'z. B. Hydrant Lange Straße 12' : 'z. B. Klinikum Diepholz'} />
        </Field>
        <Field label="Adresse">
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
        </Field>
      </div>
      <Field label="Position *" hint={pos ? `UTMREF ${toMgrs(pos.lat, pos.lon)} · in die Karte klicken oder Markierung ziehen` : 'In die Karte klicken oder oben eine Adresse suchen'}>
        <MapSearch focus={() => pos ?? { lat: center[0], lon: center[1] }} onSelect={pick} id="library-search-results" placeholder="Adresse suchen" label="Adresse suchen" />
        <div className="library-minimap">
          <MapContainer ref={setMap} center={pos ? [pos.lat, pos.lon] : center} zoom={pos ? 17 : 13} maxZoom={20} className="map" attributionControl={false}>
            <Tiles />
            <ClickToPlace onPick={(lat, lon) => setPos({ lat, lon })} />
            {pos && (
              <Marker
                position={[pos.lat, pos.lon]}
                draggable
                icon={pointIcon(type.color, pointSymbol(icons, type.icon), objectBadge(type, props as ObjectProps))}
                eventHandlers={{ dragend: (e) => setPos({ lat: (e.target as L.Marker).getLatLng().lat, lon: (e.target as L.Marker).getLatLng().lng }) }}
              />
            )}
          </MapContainer>
        </div>
      </Field>
      {type.fields.length > 0 && (
        <div className="form-grid">
          {type.fields.map((f) => (
            <Field key={f.key} label={f.unit ? `${f.label} (${f.unit})` : f.label}>
              <FieldInput field={f} value={props[f.key]} onChange={(v) => setProps((p) => ({ ...p, [f.key]: v }))} />
            </Field>
          ))}
        </div>
      )}
      <Field label="Bemerkung">
        <textarea rows={3} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field label="Dateien" hint={objectId === null ? 'Dateien lassen sich nach dem Speichern anhängen' : 'z. B. Feuerwehrplan, Objektinformation (höchstens 50 MB je Datei)'}>
        {files.length > 0 && (
          <ul className="simple-list">
            {files.map((f) => (
              <li key={f.id}>
                <FileText size={16} />
                <div className="grow">
                  <a href={api.libraryFileUrl(f.id)} target="_blank" rel="noreferrer">
                    {f.filename}
                  </a>
                  <div className="cell-sub">
                    {fmtBytes(f.sizeBytes)} · {f.uploadedBy}
                  </div>
                </div>
                <a className="btn btn-ghost btn-icon" href={api.libraryFileUrl(f.id, true)} aria-label={`${f.filename} herunterladen`}>
                  <Download size={16} />
                </a>
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`${f.filename} entfernen`} onClick={() => window.confirm(`„${f.filename}“ entfernen?`) && removeFile.mutate(f.id)}>
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {objectId !== null && (
          <label className="btn btn-sm library-upload">
            <Paperclip size={16} /> {upload.isPending ? 'Lädt hoch …' : 'Datei anhängen'}
            <input
              type="file"
              hidden
              multiple
              disabled={upload.isPending}
              onChange={(e) => {
                for (const f of Array.from(e.target.files ?? [])) upload.mutate(f);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </Field>
      <div className="form-actions spread">
        <span>
          {objectId !== null && (
            <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => window.confirm(`„${name}“ aus der Objektbibliothek löschen?`) && remove.mutate()}>
              <Trash2 size={16} /> Löschen
            </button>
          )}
        </span>
        <span className="form-actions">
          {saved && (
            <button type="button" className="btn" onClick={onDone}>
              Fertig
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            Speichern
          </button>
        </span>
      </div>
    </form>
  );
}

/** Wasserentnahmestellen im Kartenausschnitt aus OpenStreetMap übernehmen */
function OsmImport({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const center = useCenter();
  const [map, setMap] = useState<L.Map | null>(null);
  useResize(map, center);
  const run = useMutation({
    mutationFn: () => {
      const b = map!.getBounds();
      return api.importOsmWater({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() });
    },
    onSuccess: (r) => {
      toast('success', `${r.added} Wasserentnahmestellen übernommen${r.skipped ? `, ${r.skipped} waren schon da` : ''}${r.truncated ? ' – nicht alle, bitte kleineren Ausschnitt wählen' : ''}`);
      onDone();
    },
    onError: (e: Error) => toast('error', e.message),
  });
  return (
    <div className="form">
      <p className="muted">
        Übernimmt Hydranten, Saugstellen, Löschteiche und Löschwasserbehälter aus OpenStreetMap im gezeigten Ausschnitt als Wasserentnahmestellen. Schon übernommene bleiben
        unverändert. Die Daten in OSM sind nicht immer vollständig – bitte mit den Plänen des Wasserversorgers abgleichen.
      </p>
      <div className="library-minimap">
        <MapContainer ref={setMap} center={center} zoom={13} maxZoom={20} className="map" attributionControl={false}>
          <Tiles />
        </MapContainer>
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={!map || run.isPending} onClick={() => run.mutate()}>
          <Download size={16} /> {run.isPending ? 'Fragt OpenStreetMap ab …' : 'Im Ausschnitt übernehmen'}
        </button>
      </div>
    </div>
  );
}

/** Objektbibliothek: Wasserentnahmestellen, Einsatzobjekte und eigene Typen, unabhängig von einer Lage */
export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const { data: types } = useLibraryTypes();
  const [typeFilter, setTypeFilter] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const { data: objects, isLoading } = useQuery({
    queryKey: ['library', 'list', typeFilter, query.trim()],
    queryFn: () => api.libraryObjects({ types: typeFilter === null ? undefined : [typeFilter], q: query.trim() || undefined }),
  });
  const editId = Number(params.get('id')) || null;
  const { data: editing } = useQuery({ queryKey: ['library', 'object', editId], queryFn: () => api.libraryObject(editId!), enabled: editId !== null });
  const byId = useMemo(() => new Map((types ?? []).map((t) => [t.id, t])), [types]);
  const close = () => (setParams({}), setCreating(null));
  useEffect(() => {
    if (editId !== null) setCreating(null);
  }, [editId]);

  if (!types) return <Loading />;
  const water = types.find((t) => t.builtin === 'water');
  const shown = (objects ?? []).slice(0, SHOWN);

  return (
    <>
      <PageHeader
        title="Objektbibliothek"
        subtitle="Wasserentnahmestellen, Einsatzobjekte und eigene Typen – auf der Karte unter „Ebenen“ einblendbar"
        actions={
          <>
            {water && (
              <button className="btn" onClick={() => setImporting(true)}>
                <MapPinned size={16} /> Aus OpenStreetMap
              </button>
            )}
            <button className="btn btn-primary" onClick={() => setCreating(typeFilter ?? types[0]!.id)}>
              <Plus size={16} /> Neues Objekt
            </button>
          </>
        }
      />
      <div className="library-toolbar">
        <select aria-label="Typ" value={typeFilter ?? ''} onChange={(e) => setTypeFilter(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Alle Typen ({types.reduce((n, t) => n + t.count, 0)})</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.count})
            </option>
          ))}
        </select>
        <label className="search-field">
          <Search size={16} aria-hidden />
          <input type="search" aria-label="Objekte durchsuchen" placeholder="Name, Adresse, Feldwerte" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {isLoading ? (
        <Loading />
      ) : !shown.length ? (
        <EmptyState title={query || typeFilter !== null ? 'Keine Treffer' : 'Noch keine Objekte'}>
          <p>Objekte lassen sich hier anlegen{water ? ' oder Wasserentnahmestellen aus OpenStreetMap übernehmen' : ''}.</p>
        </EmptyState>
      ) : (
        <ul className="simple-list library-list">
          {shown.map((o: LibraryObject) => {
            const t = byId.get(o.typeId);
            const badge = t && objectBadge(t, o.props);
            const summary = t?.fields
              .filter((f) => !f.badge && f.type !== 'longtext')
              .map((f) => (f.type === 'bool' ? (o.props[f.key] === true ? f.label : '') : formatProp(f, o.props[f.key])))
              .filter(Boolean)
              .slice(0, 3)
              .join(' · ');
            return (
              <li key={o.id}>
                {t && (
                  <span style={{ color: t.color, display: 'inline-flex' }}>
                    <MapIcon name={t.icon} size={20} />
                  </span>
                )}
                <Link className="grow" to={`/objekte?id=${o.id}`}>
                  <div className="cell-title">
                    {o.name} {badge && <Badge>{badge}</Badge>}
                  </div>
                  <div className="cell-sub">{[t?.name, o.address, summary].filter(Boolean).join(' · ')}</div>
                </Link>
                {o.fileCount > 0 && (
                  <span className="muted" title={`${o.fileCount} Dateien`}>
                    <Paperclip size={14} /> {o.fileCount}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(objects?.length ?? 0) > SHOWN && <p className="muted">Es werden {SHOWN} von {objects!.length} Objekten gezeigt – die Suche grenzt ein.</p>}

      <Modal open={creating !== null || (editId !== null && !!editing)} title={editId !== null ? 'Objekt bearbeiten' : 'Neues Objekt'} onClose={close} wide>
        {editId !== null && editing ? (
          <ObjectEditor key={editing.id} initial={editing} types={types} onDone={close} />
        ) : creating !== null ? (
          <ObjectEditor key="new" initial={{ typeId: creating }} types={types} onDone={close} />
        ) : null}
      </Modal>
      <Modal open={importing} title="Wasserentnahmestellen aus OpenStreetMap" onClose={() => setImporting(false)} wide>
        {importing && <OsmImport onDone={() => setImporting(false)} />}
      </Modal>
    </>
  );
}
