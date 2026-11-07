import { useEffect, useMemo, useState } from 'react';
import { CircleMarker, GeoJSON, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FileText, ListPlus, Pencil } from 'lucide-react';
import { LIBRARY_MAP_MAX_OBJECTS, formatProp, objectBadge, toMgrs, type LibraryObject, type NewMapObject, type ObjectType, type OverpassBounds } from '@elvis/shared';
import { api } from '../../lib/api';
import { pointIcon, pointSymbol } from './objects';
import { useMapIcons } from './mapIcons';

/** Was die Ebene gerade zeigt (für die Statuszeile der Karte) */
export interface LibraryStatus {
  /** Limit erreicht: im Ausschnitt gibt es mehr Objekte, als angezeigt werden */
  limited: boolean;
}
/** Ab hier Symbole mit Schild statt einfacher Punkte */
const SYMBOL_ZOOM = 15;

/** Typen der Objektbibliothek; live aktualisiert über das Thema „library“ */
export function useLibraryTypes(enabled = true) {
  return useQuery({ queryKey: ['library', 'types'], queryFn: api.libraryTypes, enabled, staleTime: 60_000 });
}

/** Kopie eines Bibliotheksobjekts für die Lage (Punkt mit Symbol und Schild) */
export function libraryMapObject(o: LibraryObject, type: ObjectType): NewMapObject {
  const detail = [type.name, o.address].filter(Boolean).join(' · ').slice(0, 300);
  return { kind: 'point', name: o.name.slice(0, 120), lat: o.lat, lon: o.lon, color: type.color, data: { detail, icon: type.icon, badge: objectBadge(type, o.props) } };
}

function padded(b: L.LatLngBounds): OverpassBounds {
  const p = b.pad(0.25);
  // Auf ein Raster runden, damit kleine Verschiebungen dieselbe Abfrage treffen
  const r = (v: number, up: boolean) => (up ? Math.ceil(v * 100) : Math.floor(v * 100)) / 100;
  return { s: r(p.getSouth(), false), w: r(p.getWest(), false), n: r(p.getNorth(), true), e: r(p.getEast(), true) };
}

function ObjectPopup({ object: o, type, onAdopt }: { object: LibraryObject; type: ObjectType; onAdopt?: (o: NewMapObject) => void }) {
  const { data: detail } = useQuery({ queryKey: ['library', 'object', o.id], queryFn: () => api.libraryObject(o.id), enabled: o.fileCount > 0 });
  const values = type.fields.map((f) => [f, formatProp(f, o.props[f.key])] as const).filter(([, v]) => v);
  return (
    <div className="library-popup">
      <strong>{o.name}</strong>
      <div className="muted">{type.name}</div>
      {o.address && <div>{o.address}</div>}
      {values.length > 0 && (
        <dl className="library-props">
          {values.map(([f, v]) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>{f.type === 'url' ? <a href={v} target="_blank" rel="noreferrer noopener">{v}</a> : f.type === 'phone' ? <a href={`tel:${v.replace(/\s/g, '')}`}>{v}</a> : v}</dd>
            </div>
          ))}
        </dl>
      )}
      {o.notes && <p className="library-notes">{o.notes}</p>}
      {detail && detail.files.length > 0 && (
        <ul className="library-files">
          {detail.files.map((f) => (
            <li key={f.id}>
              <a href={api.libraryFileUrl(f.id)} target="_blank" rel="noreferrer">
                <FileText size={14} /> {f.filename}
              </a>
            </li>
          ))}
        </ul>
      )}
      <span className="mono">UTMREF {toMgrs(o.lat, o.lon)}</span>
      <div className="library-popup-actions">
        {onAdopt && (
          <button type="button" className="btn btn-sm" onClick={() => onAdopt(libraryMapObject(o, type))}>
            <ListPlus size={14} /> In Lage übernehmen
          </button>
        )}
        <Link className="btn btn-sm btn-ghost" to={`/objekte?id=${o.id}`}>
          <Pencil size={14} /> Bearbeiten
        </Link>
      </div>
    </div>
  );
}

/**
 * Objektbibliothek als Kartenebene: lädt die Objekte im (etwas vergrößerten) Ausschnitt, ab Zoom 15 mit Symbol und
 * Schild, darunter als Punkte auf dem Canvas (schnell auch bei vielen Hydranten). Höchstens LIBRARY_MAP_MAX_OBJECTS
 * (die zur Mitte nächsten); ist das Limit erreicht, meldet die Karte das.
 */
export function LibraryLayer({
  hidden,
  onAdopt,
  onStatus,
}: {
  hidden: number[];
  onAdopt?: (o: NewMapObject) => void;
  onStatus?: (s: LibraryStatus) => void;
}) {
  const map = useMap();
  const [view, setView] = useState(() => ({ zoom: map.getZoom(), bbox: padded(map.getBounds()) }));
  useMapEvents({ moveend: () => setView({ zoom: map.getZoom(), bbox: padded(map.getBounds()) }) });
  const { data: types = [] } = useLibraryTypes();
  const shown = types.filter((t) => !hidden.includes(t.id));
  const typeIds = shown.map((t) => t.id);
  const active = typeIds.length > 0;
  const { data: objects = [] } = useQuery({
    queryKey: ['library', 'map', view.bbox, typeIds],
    queryFn: () => api.libraryObjects({ bbox: view.bbox, types: typeIds }),
    enabled: active,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const limited = active && objects.length >= LIBRARY_MAP_MAX_OBJECTS;
  useEffect(() => onStatus?.({ limited }), [onStatus, limited]);
  const byId = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const renderer = useMemo(() => L.canvas({ padding: 0.5 }), []);
  const icons = useMapIcons(view.zoom >= SYMBOL_ZOOM);
  if (!active) return null;
  return (
    <>
      {objects.map((o) => {
        const type = byId.get(o.typeId);
        if (!type || hidden.includes(type.id)) return null;
        const popup = (
          // Abstand oben, damit die Werkzeugleiste das Popup nicht verdeckt
          <Popup autoPanPaddingTopLeft={[20, 90]} autoPanPaddingBottomRight={[20, 20]}>
            <ObjectPopup object={o} type={type} onAdopt={onAdopt} />
          </Popup>
        );
        const outline = o.geometry && view.zoom >= 13 && (
          <GeoJSON
            key={`${o.id}:g`}
            data={o.geometry}
            style={o.geometry.type.includes('Polygon') ? { color: type.color, weight: 2, fillColor: type.color, fillOpacity: 0.15 } : { color: type.color, weight: 4, opacity: 0.8 }}
          />
        );
        const dot =
          view.zoom >= SYMBOL_ZOOM ? (
            <Marker key={o.id} position={[o.lat, o.lon]} icon={pointIcon(type.color, pointSymbol(icons, type.icon), objectBadge(type, o.props))} title={o.name}>
              {popup}
            </Marker>
          ) : (
            <CircleMarker key={o.id} center={[o.lat, o.lon]} radius={6} pathOptions={{ renderer, color: '#ffffff', weight: 2, fillColor: type.color, fillOpacity: 0.95 }}>
              {popup}
            </CircleMarker>
          );
        return [outline, dot];
      })}
    </>
  );
}
