import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleMarker, ImageOverlay, MapContainer, Marker, Polygon, Polyline, Rectangle, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { ArrowLeft, Building2, Crosshair, Eraser, Layers, Map as MapIcon, Pipette, Scissors, Trash2, Undo2 } from 'lucide-react';
import {
  GEOREF_DEFAULT_TOLERANCE,
  GEOREF_ORDER2_MIN_GCPS,
  applyAffine,
  fitAffine,
  type GeocodeResult,
  type Gcp,
  type GeorefCut,
  type GeorefJob,
  type GeorefPoint,
  type GeorefStroke,
  type GeorefPage,
  type Incident,
  type IncidentDocument,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { autoSource } from '../../lib/mapSources';
import { saveMapView } from '../../lib/mapView';
import { effectiveTheme, useTheme } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { EmptyState, Field, Loading, Modal, Segmented } from '../ui';
import { MapSearch } from '../../pages/map/search';
import { pickColor, preparePage, type PagePrep } from './pagePrep';

/** Vorgabe ohne Einsatzort: Mitte Deutschlands */
const FALLBACK: [number, number] = [51.16, 10.45];

/** Nummerierter Passpunkt (zwischengespeichert, sonst legt Leaflet ihn bei jedem Rendern neu an) */
const gcpIcons = new Map<string, L.DivIcon>();
function gcpIcon(n: number, pending = false): L.DivIcon {
  const key = `${n}:${pending}`;
  let icon = gcpIcons.get(key);
  if (!icon)
    gcpIcons.set(
      key,
      (icon = L.divIcon({
        className: `georef-gcp ${pending ? 'pending' : ''}`,
        html: `<span>${n}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      })),
    );
  return icon;
}

/** Lauf auf dem Server verfolgen (Websocket-Thema „georef“, zur Sicherheit zusätzlich jede Sekunde) */
function useJob(id: string | null) {
  return useQuery({
    queryKey: ['georef', 'job', id],
    queryFn: () => api.georefJob(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && (q.state.data.state === 'done' || q.state.data.state === 'failed') ? false : 1000),
  });
}

function JobProgress({ job, label }: { job: GeorefJob | undefined; label: string }) {
  if (!job) return <Loading />;
  return (
    <div className="georef-progress">
      <strong>{label}</strong>
      <progress max={100} value={job.percent ?? undefined} />
      <span className="muted">{job.state === 'queued' ? 'Wartet auf einen laufenden Auftrag …' : job.message}</span>
    </div>
  );
}

/** Seitenbild in Pixelkoordinaten (CRS.Simple: Breite = −y, Länge = x) */
const toImage = (ll: L.LatLng) => ({
  x: Math.max(0, ll.lng),
  y: Math.max(0, -ll.lat),
});
const fromImage = (p: { x: number; y: number }): [number, number] => [-p.y, p.x];

function ImageClicks({ onClick, onMove }: { onClick: (p: { x: number; y: number }) => void; onMove?: (p: { x: number; y: number }) => void }) {
  useMapEvents({ click: (e) => onClick(toImage(e.latlng)), mousemove: (e) => onMove?.(toImage(e.latlng)) });
  return null;
}

/** Rechteck aus zwei Ecken, auf die Seite begrenzt und auf ganze Pixel gerundet */
function cutOf(a: { x: number; y: number }, b: { x: number; y: number }, page: GeorefPage): GeorefCut {
  const clampX = (v: number) => Math.round(Math.min(page.width, Math.max(0, v)));
  const clampY = (v: number) => Math.round(Math.min(page.height, Math.max(0, v)));
  return [clampX(Math.min(a.x, b.x)), clampY(Math.min(a.y, b.y)), clampX(Math.max(a.x, b.x)), clampY(Math.max(a.y, b.y))];
}
const cutBounds = ([x0, y0, x1, y1]: GeorefCut): [[number, number], [number, number]] => [fromImage({ x: x0, y: y1 }), fromImage({ x: x1, y: y0 })];
const CUT_STYLE = { color: '#e53935', weight: 1, fillColor: '#e53935', fillOpacity: 0.45 };

function MapClicks({ onClick }: { onClick: (p: { lat: number; lon: number }) => void }) {
  useMapEvents({
    click: (e) => onClick({ lat: e.latlng.lat, lon: e.latlng.lng }),
  });
  return null;
}

function FitImage({ page }: { page: GeorefPage }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds([fromImage({ x: 0, y: page.height }), fromImage({ x: page.width, y: 0 })]);
  }, [map, page.width, page.height]);
  return null;
}

/**
 * Fertig vorbereitetes Bild als Ebene: ein eigenes <canvas> im Pane mit CSS-Matrix aus drei Ecken – links im Plan
 * (CRS.Simple) deckungsgleich, rechts affin entzerrt (in Web-Mercator lokal linear genug für die Vorschau). Leaflet
 * selbst kann Bilder nur achsparallel legen.
 */
function CanvasLayer({
  source,
  page,
  at,
  opacity,
  pane = 'overlayPane',
  zIndex,
}: {
  source: HTMLCanvasElement | null;
  page: GeorefPage;
  at: (x: number, y: number) => L.LatLngExpression;
  opacity: number;
  pane?: string;
  zIndex?: number;
}) {
  const map = useMap();
  const [el] = useState(() => L.DomUtil.create('canvas', 'georef-preview leaflet-zoom-hide') as HTMLCanvasElement);
  useEffect(() => {
    if (!source) return;
    el.width = source.width;
    el.height = source.height;
    el.getContext('2d')!.drawImage(source, 0, 0);
  }, [el, source]);
  useEffect(() => {
    // Eigene Ebene zwischen Seitenbild (tilePane) und Umriss/Markierungen (overlayPane)
    const target = map.getPane(pane) ?? map.createPane(pane);
    if (zIndex !== undefined) target.style.zIndex = String(zIndex);
    target.appendChild(el);
    return () => el.remove();
  }, [map, el, pane, zIndex]);
  useEffect(() => {
    el.style.opacity = String(opacity);
  }, [el, opacity]);
  useEffect(() => {
    const place = () => {
      const p0 = map.latLngToLayerPoint(at(0, 0));
      const p1 = map.latLngToLayerPoint(at(page.width, 0));
      const p2 = map.latLngToLayerPoint(at(0, page.height));
      el.style.width = `${page.width}px`;
      el.style.height = `${page.height}px`;
      el.style.transform = `matrix(${(p1.x - p0.x) / page.width}, ${(p1.y - p0.y) / page.width}, ${(p2.x - p0.x) / page.height}, ${(p2.y - p0.y) / page.height}, ${p0.x}, ${p0.y})`;
    };
    place();
    map.on('zoomend viewreset', place);
    return () => void map.off('zoomend viewreset', place);
  }, [map, el, at, page.width, page.height]);
  return null;
}

/** Radierer: Strich mit gedrückter Maus ziehen (die Karte verschiebt sich solange nicht) */
function EraserInput({ active, width, onStroke }: { active: boolean; width: number; onStroke: (s: GeorefStroke) => void }) {
  const map = useMap();
  const [points, setPoints] = useState<GeorefPoint[] | null>(null);
  useEffect(() => {
    if (active) map.dragging.disable();
    else map.dragging.enable();
  }, [map, active]);
  const at = (ll: L.LatLng): GeorefPoint => {
    const p = toImage(ll);
    return [Math.round(p.x), Math.round(p.y)];
  };
  useMapEvents({
    mousedown: (e) => active && setPoints([at(e.latlng)]),
    mousemove: (e) => {
      if (!points) return;
      const p = at(e.latlng);
      const last = points.at(-1)!;
      // Nur Punkte mit etwas Abstand – sonst wird der Strich unnötig lang
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= Math.max(2, width / 4)) setPoints([...points, p]);
    },
    mouseup: () => {
      if (points) onStroke({ width, points: points.slice(0, 5000) });
      setPoints(null);
    },
  });
  if (!points) return null;
  // Leaflet misst Linienbreiten in Bildschirmpixeln; CRS.Simple: 1 Bildpixel = 2^Zoom Bildschirmpixel
  return (
    <Polyline
      positions={points.map(([x, y]) => fromImage({ x, y }))}
      pathOptions={{ color: '#141820', opacity: 0.85, weight: width * 2 ** map.getZoom(), lineCap: 'round', lineJoin: 'round' }}
      interactive={false}
    />
  );
}

/** Eckpunkt des Gebäudeumrisses */
const vertexIcon = L.divIcon({ className: 'georef-vertex', iconSize: [12, 12], iconAnchor: [6, 6] });
const OUTLINE_STYLE = { color: '#1e88e5', weight: 2, fillColor: '#1e88e5', fillOpacity: 0.08 };

type Tool = 'gcp' | 'building' | 'erase' | 'cut' | 'pick';
type Pending = { x: number; y: number } | { lat: number; lon: number } | null;

/** Schritt 3: Passpunkte setzen (Bild links, Karte rechts), Seite vorbereiten, Vorschau und Restfehler */
function GcpEditor({
  incident,
  doc,
  page,
  pages,
  onBack,
  onDone,
}: {
  incident: Incident;
  doc: IncidentDocument;
  page: GeorefPage;
  pages: number;
  onBack: () => void;
  onDone: (job: GeorefJob) => void;
}) {
  const toast = useToast();
  const { data: sources = [] } = useQuery({ queryKey: ['mapSources'], queryFn: api.mapSources, staleTime: Infinity });
  const source = autoSource(sources, effectiveTheme(useTheme()) === 'dark');
  const stem = doc.filename.replace(/\.pdf$/i, '');
  const [name, setName] = useState(pages > 1 ? `${stem} S. ${page.page}` : stem);
  const [gcps, setGcps] = useState<Gcp[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const [order, setOrder] = useState<1 | 2>(1);
  const [preview, setPreview] = useState(0.6);
  const [tool, setTool] = useState<Tool>('gcp');
  const [cuts, setCuts] = useState<GeorefCut[]>([]);
  /** Erste Ecke des Rechtecks, das gerade aufgezogen wird, und die Mausposition dazu */
  const [cutStart, setCutStart] = useState<{ x: number; y: number } | null>(null);
  const [cutHover, setCutHover] = useState<{ x: number; y: number } | null>(null);
  const [outline, setOutline] = useState<GeorefPoint[]>([]);
  /** Hintergrund (Papierfarbe) außerhalb des Gebäudes entfernen */
  const [bgOn, setBgOn] = useState(false);
  const [bgColor, setBgColor] = useState('#ffffff');
  const [tolerance, setTolerance] = useState(GEOREF_DEFAULT_TOLERANCE);
  const [strokes, setStrokes] = useState<GeorefStroke[]>([]);
  const [brush, setBrush] = useState(40);
  const [geoMap, setGeoMap] = useState<L.Map | null>(null);
  const [hit, setHit] = useState<GeocodeResult | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const fit = useMemo(() => fitAffine(gcps), [gcps]);
  const imageUrl = api.pdfPageUrl(doc.id, page.page);
  const center: [number, number] = incident.lat != null && incident.lon != null ? [incident.lat, incident.lon] : FALLBACK;

  useEffect(() => {
    const el = new Image();
    el.onload = () => setImage(el);
    el.src = imageUrl;
  }, [imageUrl]);
  const prep = useMemo<PagePrep>(
    () => ({ cuts, outline: outline.length >= 3 ? outline : null, background: bgOn ? { color: bgColor, tolerance } : null, erase: strokes }),
    [cuts, outline, bgOn, bgColor, tolerance, strokes],
  );
  const prepared = useMemo(() => (image ? preparePage(image, page.width, page.height, prep) : null), [image, page.width, page.height, prep]);
  const onPage = useCallback((x: number, y: number) => fromImage({ x, y }), []);
  const onMap = useCallback(
    (x: number, y: number): [number, number] => {
      const p = applyAffine(fit!.t, x, y);
      return [p.lat, p.lon];
    },
    [fit],
  );

  const add = (p: NonNullable<Pending>) => {
    const other = pending;
    if (other && 'x' in other !== 'x' in p) {
      const img = 'x' in p ? p : (other as { x: number; y: number });
      const geo = 'lat' in p ? p : (other as { lat: number; lon: number });
      setGcps((g) => [...g, { x: Math.round(img.x * 10) / 10, y: Math.round(img.y * 10) / 10, lat: geo.lat, lon: geo.lon }]);
      setPending(null);
    } else setPending(p);
  };
  const cutClick = (p: { x: number; y: number }) => {
    if (!cutStart) return setCutStart(p);
    const c = cutOf(cutStart, p, page);
    if (c[2] > c[0] && c[3] > c[1]) setCuts((cs) => [...cs, c]);
    setCutStart(null);
    setCutHover(null);
  };
  const pageClick = (p: { x: number; y: number }) => {
    if (tool === 'gcp') add(p);
    else if (tool === 'cut') cutClick(p);
    else if (tool === 'building') setOutline((o) => [...o, [Math.round(p.x), Math.round(p.y)]]);
    else if (tool === 'pick' && image) {
      setBgColor(pickColor(image, p.x, p.y));
      setBgOn(true);
      setTool('building');
    }
  };
  const switchTool = (t: Tool) => (setTool(t), setPending(null), setCutStart(null), setCutHover(null));
  const showHit = (r: GeocodeResult) => {
    setHit(r);
    const point = r.kind === 'house' || r.kind === 'coordinate' || !r.bounds;
    if (point) geoMap?.flyTo([r.lat, r.lon], 18);
    else geoMap?.flyToBounds(r.bounds!, { maxZoom: r.kind === 'street' ? 18 : 16, padding: [24, 24] });
  };
  const move = (i: number, p: Partial<Gcp>) => setGcps((g) => g.map((q, j) => (j === i ? { ...q, ...p } : q)));
  const remove = (i: number) => setGcps((g) => g.filter((_, j) => j !== i));

  const create = useMutation({
    mutationFn: () =>
      api.createOverlay(doc.id, {
        page: page.page,
        name: name.trim(),
        gcps,
        ...prep,
        order: gcps.length >= GEOREF_ORDER2_MIN_GCPS ? order : 1,
      }),
    onSuccess: onDone,
    onError: (e) => toast('error', e.message),
  });

  const pendingImg = pending && 'x' in pending ? pending : null;
  const pendingGeo = pending && 'lat' in pending ? pending : null;
  const hint = {
    gcp: pendingImg
      ? `Punkt ${gcps.length + 1}: jetzt dieselbe Stelle rechts in der Karte anklicken`
      : pendingGeo
        ? `Punkt ${gcps.length + 1}: jetzt dieselbe Stelle links im Plan anklicken`
        : 'Markante Stelle (Kreuzung, Gebäudeecke) im Plan links anklicken, danach dieselbe Stelle in der Karte rechts – mindestens 3 Punkte, gut verteilt',
    building: 'Ecken des Gebäudes nacheinander anklicken (Punkte lassen sich verschieben) – außerhalb wird der Hintergrund entfernt, das Gebäude bleibt vollständig',
    erase: 'Mit gedrückter Maus über Inhalte außerhalb des Gebäudes fahren – im Gebäude radiert der Radierer nicht',
    cut: cutStart
      ? 'Gegenüberliegende Ecke des Rechtecks anklicken'
      : 'Rechteck mit zwei Klicks auf gegenüberliegende Ecken markieren – entfernt auch im Gebäude; Klick auf eine rote Fläche nimmt sie zurück',
    pick: 'Hintergrund (Papier) im Plan anklicken, um seine Farbe zu übernehmen',
  }[tool];

  return (
    <div className="georef-editor">
      <p className="muted georef-hint">{hint}</p>
      <div className="georef-maps">
        <div className="georef-col">
          <div className="georef-col-head">
            <Segmented
              label="Werkzeug im Plan"
              value={tool === 'pick' ? 'building' : tool}
              onChange={switchTool}
              options={[
                {
                  value: 'gcp',
                  label: (
                    <>
                      <Crosshair size={16} /> Passpunkte
                    </>
                  ),
                },
                {
                  value: 'building',
                  label: (
                    <>
                      <Building2 size={16} /> Gebäude
                    </>
                  ),
                },
                {
                  value: 'erase',
                  label: (
                    <>
                      <Eraser size={16} /> Radierer
                    </>
                  ),
                },
                {
                  value: 'cut',
                  label: (
                    <>
                      <Scissors size={16} /> Rechteck
                    </>
                  ),
                },
              ]}
            />
          </div>
          {(tool === 'building' || tool === 'pick') && (
            <div className="georef-tool-options">
              <span className="muted">{outline.length < 3 ? `Umriss: ${outline.length} von mind. 3 Ecken` : `Umriss: ${outline.length} Ecken`}</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!outline.length} onClick={() => setOutline((o) => o.slice(0, -1))}>
                <Undo2 size={16} /> Ecke
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!outline.length} onClick={() => setOutline([])}>
                <Trash2 size={16} /> Umriss
              </button>
              <label className="georef-check">
                <input type="checkbox" checked={bgOn} onChange={(e) => setBgOn(e.target.checked)} /> Hintergrund außerhalb entfernen
              </label>
              <input type="color" value={bgColor} onChange={(e) => (setBgColor(e.target.value), setBgOn(true))} aria-label="Hintergrundfarbe" title="Hintergrundfarbe" />
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${tool === 'pick' ? 'active' : ''}`}
                onClick={() => switchTool(tool === 'pick' ? 'building' : 'pick')}
                title="Farbe im Plan aufnehmen"
              >
                <Pipette size={16} />
              </button>
              <label className="georef-range" title="Wie stark eine Farbe vom Hintergrund abweichen darf, um noch entfernt zu werden">
                Toleranz
                <input type="range" min={0} max={120} step={5} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} disabled={!bgOn} />
              </label>
            </div>
          )}
          {tool === 'erase' && (
            <div className="georef-tool-options">
              <label className="georef-range">
                Pinsel {brush} px
                <input type="range" min={5} max={300} step={5} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
              </label>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!strokes.length} onClick={() => setStrokes((st) => st.slice(0, -1))}>
                <Undo2 size={16} /> Strich zurück
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!strokes.length} onClick={() => setStrokes([])}>
                <Trash2 size={16} /> Alle {strokes.length || ''}
              </button>
              {!outline.length && <span className="muted">Ohne Gebäudeumriss radiert der Radierer überall</span>}
            </div>
          )}
          {tool === 'cut' && cuts.length > 0 && (
            <div className="georef-tool-options">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCuts((cs) => cs.slice(0, -1))}>
                <Undo2 size={16} /> {cuts.length === 1 ? '1 Rechteck' : `${cuts.length} Rechtecke`}
              </button>
            </div>
          )}
          <div className={`georef-map tool-${tool}`}>
            <MapContainer crs={L.CRS.Simple} center={[0, 0]} zoom={0} minZoom={-6} maxZoom={4} zoomSnap={0.25} className="map" attributionControl={false}>
              <FitImage page={page} />
              <ImageOverlay url={imageUrl} pane="tilePane" className="georef-paper" bounds={[fromImage({ x: 0, y: page.height }), fromImage({ x: page.width, y: 0 })]} />
              <CanvasLayer source={prepared?.removed ?? null} page={page} at={onPage} opacity={1} pane="georef-removed" zIndex={350} />
              <ImageClicks onClick={pageClick} onMove={cutStart ? setCutHover : undefined} />
              <EraserInput active={tool === 'erase'} width={brush} onStroke={(st) => setStrokes((s) => [...s, st])} />
              {outline.length >= 3 ? (
                <Polygon positions={outline.map(([x, y]) => fromImage({ x, y }))} pathOptions={OUTLINE_STYLE} interactive={false} />
              ) : (
                outline.length > 1 && <Polyline positions={outline.map(([x, y]) => fromImage({ x, y }))} pathOptions={OUTLINE_STYLE} interactive={false} />
              )}
              {tool === 'building' &&
                outline.map(([x, y], i) => (
                  <Marker
                    key={i}
                    position={fromImage({ x, y })}
                    icon={vertexIcon}
                    draggable
                    eventHandlers={{
                      dragend: (e) => {
                        const p = toImage((e.target as L.Marker).getLatLng());
                        setOutline((o) => o.map((q, j): GeorefPoint => (j === i ? [Math.round(p.x), Math.round(p.y)] : q)));
                      },
                    }}
                  />
                ))}
              {cuts.map((c, i) => (
                <Rectangle
                  key={`${c.join(',')}:${tool}`}
                  bounds={cutBounds(c)}
                  pathOptions={CUT_STYLE}
                  interactive={tool === 'cut'}
                  eventHandlers={{
                    click: (e) => {
                      L.DomEvent.stopPropagation(e);
                      setCuts((cs) => cs.filter((_, j) => j !== i));
                    },
                  }}
                />
              ))}
              {cutStart && cutHover && <Rectangle bounds={cutBounds(cutOf(cutStart, cutHover, page))} pathOptions={{ ...CUT_STYLE, dashArray: '4 4' }} interactive={false} />}
              {tool === 'gcp' &&
                gcps.map((g, i) => (
                  <Marker
                    key={i}
                    position={fromImage(g)}
                    icon={gcpIcon(i + 1)}
                    draggable
                    eventHandlers={{ dragend: (e) => move(i, toImage((e.target as L.Marker).getLatLng())) }}
                  />
                ))}
              {tool !== 'gcp' && gcps.map((g, i) => <Marker key={i} position={fromImage(g)} icon={gcpIcon(i + 1)} interactive={false} />)}
              {pendingImg && <Marker position={fromImage(pendingImg)} icon={gcpIcon(gcps.length + 1, true)} />}
            </MapContainer>
          </div>
        </div>
        <div className="georef-col">
          <div className="georef-col-head">
            <MapSearch
              id="georef-search-results"
              label="Ort in der Karte suchen"
              focus={() => {
                const c = geoMap?.getCenter();
                return c ? { lat: c.lat, lon: c.lng } : null;
              }}
              onSelect={showHit}
            />
          </div>
          <div className="georef-map">
            <MapContainer ref={setGeoMap} center={center} zoom={incident.lat != null ? 16 : 6} maxZoom={20} className="map" attributionControl={false}>
              {source && <TileLayer url={api.tileUrl(source.id)} maxZoom={20} maxNativeZoom={source.maxZoom} />}
              {fit && preview > 0 && <CanvasLayer source={prepared?.result ?? null} page={page} at={onMap} opacity={preview} />}
              {hit && <CircleMarker center={[hit.lat, hit.lon]} radius={7} pathOptions={{ color: '#4ea1ff', weight: 3, fillOpacity: 0.2 }} interactive={false} />}
              {/* Klick in die Karte heißt Passpunkt – auch wenn links gerade ein anderes Werkzeug aktiv ist */}
              <MapClicks onClick={(p) => (tool !== 'gcp' && switchTool('gcp'), add(p))} />
              {gcps.map((g, i) => (
                <Marker
                  key={i}
                  position={[g.lat, g.lon]}
                  icon={gcpIcon(i + 1)}
                  draggable
                  eventHandlers={{
                    dragend: (e) => {
                      const ll = (e.target as L.Marker).getLatLng();
                      move(i, { lat: ll.lat, lon: ll.lng });
                    },
                  }}
                />
              ))}
              {pendingGeo && <Marker position={[pendingGeo.lat, pendingGeo.lon]} icon={gcpIcon(gcps.length + 1, true)} />}
            </MapContainer>
          </div>
        </div>
      </div>

      <div className="georef-side">
        <div>
          {gcps.length > 0 && (
            <table className="table georef-gcps">
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Plan (px)</th>
                  <th>Karte</th>
                  <th>Abweichung</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {gcps.map((g, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td className="mono">
                      {Math.round(g.x)}, {Math.round(g.y)}
                    </td>
                    <td className="mono">
                      {g.lat.toFixed(5)}, {g.lon.toFixed(5)}
                    </td>
                    <td className="mono">{fit && gcps.length > 3 ? `${fit.residualsM[i]!.toFixed(1)} m` : '–'}</td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-icon" onClick={() => remove(i)} aria-label={`Passpunkt ${i + 1} entfernen`}>
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">
            {gcps.length < 3
              ? `${gcps.length} von mindestens 3 Passpunkten`
              : !fit
                ? 'Die Passpunkte liegen auf einer Linie – bitte weiter verteilt setzen'
                : gcps.length === 3
                  ? 'Mit einem 4. Punkt lässt sich die Genauigkeit prüfen'
                  : `Mittlere Abweichung ${fit.rmsM.toFixed(1)} m`}
          </p>
        </div>
        <div className="georef-form">
          <div className="georef-options">
            <Field label="Name">
              <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={`Vorschau ${Math.round(preview * 100)} %`}>
              <input type="range" min={0} max={1} step={0.05} value={preview} onChange={(e) => setPreview(Number(e.target.value))} disabled={!fit} />
            </Field>
            {gcps.length >= GEOREF_ORDER2_MIN_GCPS && (
              <Field label="Entzerrung">
                <select value={order} onChange={(e) => setOrder(Number(e.target.value) as 1 | 2)}>
                  <option value={1}>Affin (Plan ist maßstabstreu)</option>
                  <option value={2}>2. Ordnung (verzogene Scans)</option>
                </select>
              </Field>
            )}
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={onBack}>
              <ArrowLeft size={16} /> Andere Seite
            </button>
            <button type="button" className="btn btn-primary" disabled={!fit || !name.trim() || create.isPending} onClick={() => create.mutate()}>
              <Layers size={16} /> Overlay erzeugen
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Dokumente → Tools → „PDF in Karte integrieren“: PDF wählen, der Server rendert die Seiten (GDAL im Docker), eine Seite
 * mit Passpunkten georeferenzieren; der Server kachelt sie und legt ein Overlay in der Objektliste der Karte an.
 */
export function PdfToMapDialog({
  incident,
  documents,
  initial,
  onClose,
}: {
  incident: Incident;
  documents: IncidentDocument[];
  initial: IncidentDocument | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pdfs = documents.filter((d) => d.mimeType === 'application/pdf' || /\.pdf$/i.test(d.filename));
  const [doc, setDoc] = useState<IncidentDocument | null>(initial);
  const [page, setPage] = useState<GeorefPage | null>(null);
  const [renderJob, setRenderJob] = useState<string | null>(null);
  const [overlayJob, setOverlayJob] = useState<string | null>(null);
  const { data: status } = useQuery({
    queryKey: ['georef', 'status'],
    queryFn: api.georefStatus,
  });
  const pages = useQuery({
    queryKey: ['georef', 'pages', doc?.id, doc?.version],
    queryFn: () => api.pdfPages(doc!.id),
    enabled: !!doc,
  });
  const render = useJob(renderJob);
  const overlay = useJob(overlayJob);

  const startRender = useMutation({
    mutationFn: (d: IncidentDocument) => api.renderPdfPages(d.id),
    onSuccess: (job) => setRenderJob(job.id),
    onError: (e) => toast('error', e.message),
  });

  // Noch nicht gerendert: gleich beim Server anstoßen
  useEffect(() => {
    if (doc && status?.available && pages.data && !pages.data.length && !renderJob && !startRender.isPending) startRender.mutate(doc);
  }, [doc, status?.available, pages.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (render.data?.state === 'done') void pages.refetch();
    if (render.data?.state === 'failed') toast('error', `Seiten konnten nicht gerendert werden: ${render.data.message}`);
  }, [render.data?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // Einseitiges PDF: Seitenwahl überspringen
  useEffect(() => {
    if (pages.data?.length === 1 && !page) setPage(pages.data[0]!);
  }, [pages.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const job = overlay.data;
  useEffect(() => {
    if (job?.state === 'failed') {
      toast('error', `Overlay konnte nicht erzeugt werden: ${job.message}`);
      setOverlayJob(null);
    }
    if (job?.state === 'done')
      void queryClient.invalidateQueries({
        queryKey: ['mapObjects', incident.id],
      });
  }, [job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const showOnMap = async () => {
    const objects = await api.mapObjects(incident.id);
    const o = objects.find((x) => x.id === job?.objectId);
    if (o?.kind === 'overlay') {
      const [[s, w], [n, e]] = o.data.bounds;
      saveMapView('elvis.map.view', {
        lat: (s + n) / 2,
        lon: (w + e) / 2,
        zoom: Math.max(o.data.minZoom, o.data.maxZoom - 3),
      });
    }
    navigate('/karte');
  };

  const choose = (d: IncidentDocument) => {
    setDoc(d);
    setPage(null);
    setRenderJob(null);
  };

  let body;
  if (status && !status.available) {
    body = (
      <EmptyState icon={<MapIcon size={32} />} title="Werkzeug nicht verfügbar">
        {status.reason} – das Rendern und Kacheln läuft mit GDAL in einem Docker-Container.
      </EmptyState>
    );
  } else if (job?.state === 'done') {
    body = (
      <div className="georef-done">
        <p>
          Das Overlay steht jetzt in der Objektliste der Karte und ist auf allen Arbeitsplätzen und Bildschirmen sichtbar. Deckkraft und Sichtbarkeit lassen sich dort einstellen.
        </p>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Schließen
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void showOnMap()}>
            <MapIcon size={16} /> Auf Karte zeigen
          </button>
        </div>
      </div>
    );
  } else if (overlayJob) {
    body = <JobProgress job={job} label="Overlay wird erzeugt" />;
  } else if (!doc) {
    body = pdfs.length ? (
      <ul className="georef-docs">
        {pdfs.map((d) => (
          <li key={d.id}>
            <button type="button" className="btn btn-ghost" onClick={() => choose(d)}>
              {d.filename}
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <EmptyState title="Keine PDFs im Einsatz">Zuerst einen Plan als PDF hochladen.</EmptyState>
    );
  } else if (!pages.data?.length) {
    body =
      render.data?.state === 'failed' ? <p className="muted">{render.data.message}</p> : <JobProgress job={render.data} label={`Seiten von „${doc.filename}“ werden gerendert`} />;
  } else if (!page) {
    body = (
      <div className="georef-pages">
        {pages.data.map((p) => (
          <button key={p.page} type="button" className="georef-page" onClick={() => setPage(p)}>
            <img src={api.pdfPageUrl(doc.id, p.page, true)} alt={`Seite ${p.page}`} loading="lazy" />
            <span>Seite {p.page}</span>
          </button>
        ))}
      </div>
    );
  } else {
    body = (
      <GcpEditor
        incident={incident}
        doc={doc}
        page={page}
        pages={pages.data.length}
        onBack={() => (pages.data.length > 1 ? setPage(null) : (setDoc(null), setPage(null)))}
        onDone={(j) => setOverlayJob(j.id)}
      />
    );
  }

  const title = doc ? `PDF in Karte integrieren – ${doc.filename}${page ? `, Seite ${page.page}` : ''}` : 'PDF in Karte integrieren';
  return (
    <Modal open title={title} onClose={onClose} wide>
      {doc && !page && !overlayJob && !initial && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDoc(null)}>
          <ArrowLeft size={16} /> Anderes PDF
        </button>
      )}
      {body}
    </Modal>
  );
}
