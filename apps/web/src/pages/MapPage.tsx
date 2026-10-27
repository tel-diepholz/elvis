import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GeoJSON, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L, { type LatLngBoundsExpression, type LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, History, ListPlus, MapPin, Plane, Printer, Ship, Trash2, Undo2, X } from 'lucide-react';
import { DEFAULT_GAUSS, DEFAULT_VEHICLE_SIGN, hasOutline, isTracked, toMgrs, type GeocodeResult, type MapObject, type NewMapObject, type OverpassFeature, type TacticalSign, type TrackedData, type TrafficHit, type Unit } from '@elvis/shared';
import { api } from '../lib/api';
import { useActiveIncident, useNow, useSettings } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { autoSource, printSource } from '../lib/mapSources';
import { loadMapView, saveMapView } from '../lib/mapView';
import { effectiveTheme, useTheme } from '../lib/theme';
import { useDevice } from '../lib/live';
import { tacticalIcon } from '../components/tactical/TacticalSign';
import { useToast } from '../lib/toast';
import { Modal } from '../components/ui';
import { AREA_STYLE, MapObjectsLayer, objectBounds, useMapObjects } from '../components/map/objects';
import { UnitsLayer, useMapUnits } from '../components/map/units';
import { Dv102Picker, GeneratorSignDialog, generatorName, generatorSign } from '../components/map/dv102';
import { ALTITUDE_LEGEND } from '../components/map/aircraftIcons';
import { RadarControl, RadarLayer, useRadar } from '../components/map/radar';
import { AircraftLayer, ShipLayer, readLayers, saveLayers, trafficObject, type TrafficLayers, type TrafficStatus } from '../components/map/traffic';
import { PrintDialog } from './map/PrintDialog';
import { MapSearch } from './map/search';
import { ObjectList } from './map/objectlist';
import { MapStylePicker, ObjectMenu, WindTile, ZoomControl, CursorPosition, type PlaceKind } from './map/toolbar';
import { TrafficSearch } from './map/trafficSearch';
import { TimelineBar, useSettled } from './map/timeline';
import {
  DrawLayer,
  EditLayer,
  SHAPE_LABELS,
  canFinish,
  canRemovePoint,
  drawHint,
  editHint,
  editPatch,
  isComplete,
  removePoint,
  shapeObject,
  startEdit,
  type Drawing,
  type ShapeEdit,
  type ShapeKind,
} from './map/draw';
import { OverpassLayer, OverpassPanel, featureObject, overpassResultText, useOverpassRun, type OverpassHits } from './map/overpass';

const VIEW_KEY = 'elvis.map.view';
/** Gewählter Kartenstil (pro Browser); fehlt die Quelle inzwischen, gilt wieder „Automatisch“ */
const SOURCE_KEY = 'elvis.map.source';
const readSource = () => {
  try {
    return localStorage.getItem(SOURCE_KEY);
  } catch {
    return null;
  }
};
const saveSource = (id: string | null) => {
  try {
    if (id === null) localStorage.removeItem(SOURCE_KEY);
    else localStorage.setItem(SOURCE_KEY, id);
  } catch {
    /* nur Komfort */
  }
};

const incidentIcon = L.divIcon({ className: 'map-marker incident', html: '<span>!</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
const searchIcon = L.divIcon({ className: 'map-marker search', html: '<span></span>', iconSize: [20, 20], iconAnchor: [10, 10] });

const PLACE_LABELS: Record<PlaceKind, string> = { incident: 'den Einsatzort', point: 'den Punkt', sign: 'das Zeichen', gauss: 'die Quelle der Gauß-Fahne', sector: 'den Ursprung des Sektors' };

type FlyTarget = { pos: LatLngExpression; bounds?: LatLngBoundsExpression; zoom?: number; n: number };

function ClickToPlace({ active, onPick }: { active: boolean; onPick: (lat: number, lon: number) => void }) {
  useMapEvents({ click: (e) => active && onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

/** Merkt sich den aktuellen Kartenausschnitt als Startwert für den Druck und für den nächsten Aufruf der Karte. */
function ViewTracker({ view }: { view: { current: { lat: number; lon: number; zoom: number } | null } }) {
  const map = useMapEvents({
    moveend: () => {
      const c = map.getCenter();
      view.current = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
      saveMapView(VIEW_KEY, view.current);
    },
  });
  // Startausschnitt gleich übernehmen (Ortssuche gewichtet nach der Kartenmitte, auch vor der ersten Bewegung)
  useEffect(() => {
    const c = map.getCenter();
    view.current ??= { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
  }, [map, view]);
  return null;
}

/** Umriss eines gefundenen Orts; ist er geladen, zeigt die Karte den ganzen Ort */
function SearchOutline({ osm }: { osm: string }) {
  const map = useMap();
  const { data } = useQuery({ queryKey: ['mapOutline', osm], queryFn: () => api.mapOutline(osm), staleTime: Infinity, retry: false });
  useEffect(() => {
    if (data) map.flyToBounds(L.geoJSON(data).getBounds(), { padding: [48, 48], maxZoom: 16 });
  }, [data, map]);
  if (!data) return null;
  return <GeoJSON key={osm} data={data} interactive={false} style={AREA_STYLE} />;
}

function FlyTo({ target }: { target: FlyTarget | null }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    if (target.bounds) map.flyToBounds(target.bounds, { maxZoom: target.zoom ?? 17, padding: [48, 48] });
    else map.flyTo(target.pos, Math.max(map.getZoom(), target.zoom ?? 16));
  }, [target, map]);
  return null;
}

export function MapPage() {
  const appSettings = useSettings().data;
  const vehicleName = appSettings?.vehicle.name ?? 'ELW';
  const vehicleIcon = useMemo(() => tacticalIcon(appSettings?.mapSign ?? DEFAULT_VEHICLE_SIGN), [appSettings?.mapSign]);
  const { user } = useAuth();
  const weather = useDevice('weather');
  const { data: incident } = useActiveIncident();
  const { data: liveObjects = [] } = useMapObjects(incident?.id);
  const { data: liveUnits = [] } = useMapUnits(incident?.id);
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  // Zeitstrahl: historyAt = gezeigter Zeitpunkt, null = live; geladen wird erst, wenn der Regler zur Ruhe kommt
  const [timeline, setTimeline] = useState(false);
  const [historyAt, setHistoryAt] = useState<string | null>(null);
  const settledAt = useSettled(historyAt);
  const historyQuery = useQuery({
    queryKey: ['mapHistory', incident?.id, settledAt],
    queryFn: () => api.mapHistory(incident!.id, settledAt!),
    enabled: !!incident && !!settledAt,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const history = historyAt && historyQuery.data ? historyQuery.data : null;
  /** Gezeigte Lage: live oder aus dem Verlauf */
  const objects = history ? history.objects : liveObjects;
  const units = history ? history.units : liveUnits;
  const shownIncident = incident && history ? { ...incident, ...history.incident } : incident;
  const [placing, setPlacing] = useState<PlaceKind | null>(null);
  /** Einheit der Kräfteübersicht, deren Position gerade gesetzt wird */
  const [placingUnit, setPlacingUnit] = useState<Unit | null>(null);
  /** Form, die gerade gezeichnet wird (Menü „Objekte“ → Zeichnen) */
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  /** Form, die gerade bearbeitet wird (Objektliste → Form bearbeiten); das Objekt selbst ist so lange ausgeblendet */
  const [shapeEdit, setShapeEdit] = useState<ShapeEdit | null>(null);
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [searchHit, setSearchHit] = useState<GeocodeResult | null>(null);
  /** Treffer der letzten Overpass-Abfrage (bleiben, bis sie entfernt werden) */
  const [overpassHits, setOverpassHits] = useState<OverpassHits | null>(null);
  const [overpassOpen, setOverpassOpen] = useState(false);
  const mapRef = useRef<L.Map | null>(null);
  const [printing, setPrinting] = useState(false);
  const [searchingTraffic, setSearchingTraffic] = useState(false);
  /** Auswahl eines Lagezeichens offen; das gewählte Zeichen wird danach in die Karte getippt */
  const [choosingSign, setChoosingSign] = useState(false);
  /** Gewähltes Zeichen: fertiges Lagezeichen oder Zeichen aus dem Generator (dessen Dialog: Grundzeichen der Kachel) */
  const [sign, setSign] = useState<{ sign: string } | { tactical: TacticalSign } | null>(null);
  const [generating, setGenerating] = useState<TacticalSign | null>(null);
  const placeSign = (s: { sign: string } | { tactical: TacticalSign }) => (setSign(s), setChoosingSign(false), setGenerating(null), setPlacingUnit(null), setDrawing(null), setShapeEdit(null), setPlacing('sign'));
  /** Ebenen Flugzeuge/Schiffe (pro Browser) und was sie gerade zeigen */
  const [layers, setLayers] = useState<TrafficLayers>(readLayers);
  const chooseLayers = (l: TrafficLayers) => (setLayers(l), saveLayers(l));
  const [aircraftStatus, setAircraftStatus] = useState<TrafficStatus | null>(null);
  const radar = useRadar(layers.radar);
  const [shipStatus, setShipStatus] = useState<TrafficStatus | null>(null);
  /** Offenes Kartenstil-Menü schiebt die Objektliste nach unten */
  const [styleMenuPx, setStyleMenuPx] = useState(0);
  const view = useRef<{ lat: number; lon: number; zoom: number } | null>(null);
  // Zuletzt eingestellter Ausschnitt (nur beim Aufbau gelesen); ohne ihn Einsatzort, Fahrzeug oder Deutschland
  const [saved] = useState(() => loadMapView(VIEW_KEY));
  const { data: sources = [] } = useQuery({ queryKey: ['mapSources'], queryFn: api.mapSources, staleTime: Infinity });
  // null = automatisch passend zum Design (dunkle Kacheln im Dunkelmodus)
  const [sourceId, setSourceId] = useState<string | null>(readSource);
  const chooseSource = (id: string | null) => (setSourceId(id), saveSource(id));
  const dark = effectiveTheme(useTheme()) === 'dark';
  const source = sources.find((s) => s.id === sourceId) ?? autoSource(sources, dark);

  const origin = useMemo(
    () => (shownIncident?.lat != null && shownIncident.lon != null ? { lat: shownIncident.lat, lon: shownIncident.lon } : null),
    [shownIncident?.lat, shownIncident?.lon],
  );
  // Für Ausbreitung nötig: Windgeschwindigkeit und -richtung
  const ws = weather?.state;
  const wind = ws && ws.windSpeedMs !== null && ws.windDirectionDeg !== null ? { windSpeedMs: ws.windSpeedMs, windDirectionDeg: ws.windDirectionDeg } : undefined;
  /** Objekte ändern: angemeldet, laufender Einsatz und die aktuelle Lage (nicht im Verlauf) */
  const canEdit = !!user && !!incident && !incident.closedAt && !historyAt;
  /** Zeitpunkt wählen; in der Vergangenheit enden Setzen, Zeichnen und Bearbeiten */
  const travel = (at: string | null) => {
    setHistoryAt(at);
    if (!at) return;
    setPlacing(null);
    setPlacingUnit(null);
    setDrawing(null);
    setShapeEdit(null);
  };

  const setLocation = useMutation({
    mutationFn: (pos: { lat: number; lon: number }) => api.updateIncident(incident!.id, pos),
    onSuccess: () => toast('success', 'Einsatzort gesetzt'),
    onError: (e) => toast('error', e.message),
  });
  const addObject = useMutation({
    mutationFn: (o: NewMapObject) => api.addMapObject(incident!.id, o),
    onSuccess: (o) => {
      void queryClient.invalidateQueries({ queryKey: ['mapObjects', incident!.id] });
      toast('success', `„${o.name}“ zur Objektliste hinzugefügt`);
    },
    onError: (e) => toast('error', e.message),
  });

  const moveUnit = useMutation({
    mutationFn: ({ unit, lat, lon }: { unit: Unit; lat: number; lon: number }) => api.patchUnit(unit.id, { lat, lon }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['units', incident!.id] }),
    onError: (e) => toast('error', e.message),
  });

  // Fahrzeugstandort aus dem GPS der Wetterstation (Airmar); ohne GPS kein Fahrzeugmarker
  const gps = weather?.state.position ?? null;
  const vPos: [number, number] | null = gps ? [gps.lat, gps.lon] : null;
  /** Mitte Deutschlands, falls weder Einsatzort noch Fahrzeugposition bekannt sind. */
  const fallback: [number, number] = [51.1657, 10.4515];
  const iPos: [number, number] | null = origin ? [origin.lat, origin.lon] : null;
  const fly = (pos: LatLngExpression, extra: Omit<FlyTarget, 'pos' | 'n'> = {}) => setFlyTarget((t) => ({ pos, ...extra, n: (t?.n ?? 0) + 1 }));
  /** Suchtreffer anfliegen: Straßen und Orte ganz zeigen, Adressen und Koordinaten nah heran */
  const showHit = (r: GeocodeResult) => {
    setSearchHit(r);
    const point = r.kind === 'house' || r.kind === 'coordinate' || !r.bounds;
    fly([r.lat, r.lon], point ? { zoom: 17 } : { bounds: r.bounds!, zoom: r.kind === 'street' ? 17 : 14 });
  };
  /** Bereits verfolgte Flugzeuge (ICAO) und Schiffe (MMSI) */
  const tracked = useMemo(() => new Set(objects.filter((o) => isTracked(o.kind)).map((o) => (o.data as TrackedData).id)), [objects]);
  /** Schon übernommene OSM-Objekte (Ortssuche, Overpass) */
  const takenOsm = useMemo(() => new Set(objects.map((o) => (o.data as { osm?: string | null }).osm).filter((x): x is string => !!x)), [objects]);
  const closeOverpass = useCallback(() => setOverpassOpen(false), []);
  const addFeature = (f: OverpassFeature) => overpassHits && addObject.mutate(featureObject(f, overpassHits.query));
  const mapBounds = () => {
    const b = mapRef.current?.getBounds();
    return b ? { s: b.getSouth(), w: Math.max(-180, b.getWest()), n: b.getNorth(), e: Math.min(180, b.getEast()) } : null;
  };
  // Vorlagen aus den Einstellungen erscheinen im Menü „Objekte“
  const { data: overpassTemplates = [] } = useQuery({ queryKey: ['overpassQueries', 'defaults'], queryFn: api.overpassDefaults, staleTime: 300_000 });
  const overpass = useOverpassRun(mapBounds, (h) => (setOverpassHits(h), toast('success', `„${h.query.name}“: ${overpassResultText(h.result)[0]}`)));
  const addTraffic = (h: TrafficHit) => addObject.mutate(trafficObject(h), { onSuccess: () => (setSearchingTraffic(false), fly([h.lat, h.lon], { zoom: 12 })) });

  const searchFocus = () => view.current ?? (vPos ? { lat: vPos[0], lon: vPos[1] } : origin);

  // Im Einsatz lässt sich das eigene Fahrzeug in der Objektliste ausblenden
  // Im Verlauf fehlt seine Position (das GPS wird nicht mitgeschrieben)
  const showVehicle = !!vPos && !historyAt && (incident?.vehicleVisible ?? true);

  const flyToObject = (target: MapObject | Unit | 'incident' | 'vehicle') => {
    if (target === 'incident') return iPos && fly(iPos, { zoom: 16 });
    if (target === 'vehicle') return vPos && fly(vPos, { zoom: 16 });
    if ('status' in target) return target.lat !== null && target.lon !== null && fly([target.lat, target.lon], { zoom: 17 });
    const b = objectBounds(target);
    if (target.kind === 'area' || target.kind === 'line') fly(b.getCenter(), { bounds: b, zoom: 16 });
    else fly([target.lat, target.lon], { zoom: target.kind === 'point' ? 17 : isTracked(target.kind) ? 12 : 14 });
  };

  /** Suchtreffer übernehmen: mit Umriss als Fläche, sonst als Punkt */
  const addHit = async (r: GeocodeResult) => {
    const base = { name: r.name, lat: r.lat, lon: r.lon };
    const outline = hasOutline(r)
      ? await queryClient.fetchQuery({ queryKey: ['mapOutline', r.osm], queryFn: () => api.mapOutline(r.osm!), staleTime: Infinity }).catch(() => null)
      : null;
    addObject.mutate(
      outline ? { ...base, kind: 'area', data: { detail: r.detail, osm: r.osm, outline } } : { ...base, kind: 'point', data: { detail: r.detail, osm: r.osm } },
      { onSuccess: () => setSearchHit(null) },
    );
  };

  const startDrawing = (kind: ShapeKind) => (setPlacing(null), setPlacingUnit(null), setShapeEdit(null), setDrawing({ kind, points: [] }));
  const saveShape = useMutation({
    mutationFn: (e: ShapeEdit) => api.patchMapObject(e.id, editPatch(e)),
    onSuccess: () => (setShapeEdit(null), void queryClient.invalidateQueries({ queryKey: ['mapObjects', incident!.id] })),
    onError: (e) => toast('error', e.message),
  });
  const editShape = (o: MapObject) => {
    setPlacing(null);
    setPlacingUnit(null);
    setDrawing(null);
    setShapeEdit(startEdit(o));
    flyToObject(o);
  };
  // Beim Bearbeiten: Enter speichert, Esc bricht ab, Entf entfernt den gewählten Punkt
  useEffect(() => {
    if (!shapeEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape') setShapeEdit(null);
      else if (e.key === 'Enter' && !saveShape.isPending) saveShape.mutate(shapeEdit);
      else if (e.key === 'Delete' || e.key === 'Backspace') setShapeEdit(removePoint(shapeEdit));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const finishDrawing = (d: Drawing) => (setDrawing(null), addObject.mutate(shapeObject(d)));
  const addDrawPoint = (p: [number, number]) => {
    if (!drawing) return;
    const next = { ...drawing, points: [...drawing.points, p] };
    if (isComplete(next)) finishDrawing(next);
    else setDrawing(next);
  };
  const undoDrawPoint = () => setDrawing((d) => d && { ...d, points: d.points.slice(0, -1) });
  // Beim Zeichnen: Enter schließt ab, Esc bricht ab, Strg+Z nimmt den letzten Punkt zurück
  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape') setDrawing(null);
      else if (e.key === 'Enter' && canFinish(drawing)) finishDrawing(drawing);
      else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), undoDrawPoint());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const place = (kind: PlaceKind | Unit, lat: number, lon: number) => {
    setPlacing(null);
    setPlacingUnit(null);
    if (typeof kind === 'object') return moveUnit.mutate({ unit: kind, lat, lon });
    if (kind === 'incident') setLocation.mutate({ lat, lon });
    else if (kind === 'point') addObject.mutate({ kind: 'point', name: 'Punkt', lat, lon, data: { detail: '' } });
    // Name wie in der Auswahl (Dateiname des Zeichens ohne Unterstriche) bzw. Grundzeichen mit Text
    else if (kind === 'sign' && sign)
      addObject.mutate({ kind: 'sign', name: 'sign' in sign ? sign.sign.split('/')[1]!.replace(/_/g, ' ') : generatorName(sign.tactical), lat, lon, data: { detail: '', ...sign } });
    else if (kind === 'gauss') addObject.mutate({ kind: 'gauss', name: 'Gauß-Fahne', lat, lon, data: DEFAULT_GAUSS });
    else addObject.mutate({ kind: 'sector', name: 'Sektor 60°', lat, lon, data: { sectorM: 1000 } });
  };

  return (
    <div className={`map-page ${timeline ? 'with-timeline' : ''} ${historyAt ? 'in-past' : ''}`}>
      <MapContainer
        center={saved ? [saved.lat, saved.lon] : iPos ?? vPos ?? fallback}
        zoom={saved?.zoom ?? (iPos ? 14 : vPos ? 16 : 6)}
        className={`map ${placing || placingUnit || drawing ? 'placing' : ''}`}
        zoomControl={false}
        ref={mapRef}
      >
        {source && <TileLayer key={source.id} url={api.tileUrl(source.id)} attribution={source.attribution} maxZoom={source.maxZoom} />}
        {layers.radar && <RadarLayer radar={radar} />}
        {layers.aircraft && !historyAt && <AircraftLayer tracked={tracked} onAdd={canEdit ? addTraffic : undefined} onStatus={setAircraftStatus} />}
        {layers.ships && !historyAt && <ShipLayer tracked={tracked} onAdd={canEdit ? addTraffic : undefined} onStatus={setShipStatus} />}
        <MapObjectsLayer objects={shapeEdit ? objects.filter((o) => o.id !== shapeEdit.id) : objects} wind={wind} now={now} links />
        {overpassHits && <OverpassLayer hits={overpassHits} taken={takenOsm} adding={addObject.isPending} onAdd={canEdit ? addFeature : undefined} />}
        <UnitsLayer units={units} movable={placingUnit?.id} onMove={canEdit ? (unit, lat, lon) => place(unit, lat, lon) : undefined} />
        {showVehicle && (
          <Marker position={vPos!} icon={vehicleIcon}>
            <Popup>
              <strong>{vehicleName}</strong>
              <br />
              {vPos![0].toFixed(5)}, {vPos![1].toFixed(5)}
            </Popup>
          </Marker>
        )}
        {iPos && (
          <Marker position={iPos} icon={incidentIcon}>
            <Popup>
              <strong>{incident?.keyword || 'Einsatzort'}</strong>
              <br />
              {incident?.title}
              {incident?.location && (
                <>
                  <br />
                  {incident.location}
                </>
              )}
            </Popup>
          </Marker>
        )}
        <ClickToPlace active={!!placing || !!placingUnit} onPick={(lat, lon) => (placingUnit ?? placing) && place((placingUnit ?? placing)!, lat, lon)} />
        {searchHit && hasOutline(searchHit) && <SearchOutline osm={searchHit.osm!} />}
        {searchHit && (
          <Marker position={[searchHit.lat, searchHit.lon]} icon={searchIcon} eventHandlers={{ add: (e) => e.target.openPopup() }}>
            <Popup>
              <strong>{searchHit.name}</strong>
              {searchHit.detail && searchHit.kind !== 'coordinate' && (
                <>
                  <br />
                  {searchHit.detail}
                </>
              )}
              <br />
              <span className="mono">UTMREF {toMgrs(searchHit.lat, searchHit.lon)}</span>
              <span className="map-popup-actions">
                {canEdit && (
                  <button type="button" className="btn btn-sm" disabled={addObject.isPending} onClick={() => void addHit(searchHit)}>
                    <ListPlus size={14} /> Zur Objektliste
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={setLocation.isPending}
                    onClick={() => setLocation.mutate({ lat: searchHit.lat, lon: searchHit.lon }, { onSuccess: () => setSearchHit(null) })}
                  >
                    <MapPin size={14} /> Als Einsatzort setzen
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => setSearchHit(null)}>
                  <X size={14} /> Entfernen
                </button>
              </span>
            </Popup>
          </Marker>
        )}
        {shapeEdit && <EditLayer edit={shapeEdit} onChange={setShapeEdit} />}
        {drawing && <DrawLayer drawing={drawing} onPoint={addDrawPoint} onFinish={() => canFinish(drawing) && finishDrawing(drawing)} />}
        <FlyTo target={flyTarget} />
        <ViewTracker view={view} />
        <ZoomControl aboveWind={!!weather} />
        <CursorPosition />
      </MapContainer>

      <div className="map-overlay map-tools">
        <MapSearch focus={searchFocus} onSelect={showHit} />
        <ObjectMenu
          loggedIn={!!user}
          enabled={canEdit}
          reason={!incident ? 'Objekte gehören zu einem Einsatz – erst einen Einsatz auflegen' : 'Zum Bearbeiten anmelden'}
          hasLocation={!!iPos}
          onPlace={(k) => (setPlacingUnit(null), setDrawing(null), setShapeEdit(null), setPlacing(k))}
          onDraw={startDrawing}
          onSign={() => setChoosingSign(true)}
          templates={overpassTemplates}
          overpass={overpassHits && { name: overpassHits.query.name, count: overpassHits.result.features.length }}
          overpassRunning={overpass.running?.name ?? null}
          onSearchTraffic={() => setSearchingTraffic(true)}
          onTemplate={overpass.run}
          onOverpass={() => setOverpassOpen(true)}
          onClearOverpass={() => setOverpassHits(null)}
        />
        {incident && (
          <button
            className={`btn ${timeline ? 'active' : ''}`}
            onClick={() => (timeline ? (setTimeline(false), travel(null)) : setTimeline(true))}
            aria-pressed={timeline}
            title="Lage zu einem früheren Zeitpunkt zeigen"
          >
            <History size={18} /> Verlauf
          </button>
        )}
        {user && (
          <button className="btn" onClick={() => setPrinting(true)} disabled={!source}>
            <Printer size={18} /> Drucken
          </button>
        )}
      </div>

      <OverpassPanel
        open={overpassOpen}
        onClose={closeOverpass}
        incident={incident}
        loggedIn={!!user}
        canEdit={canEdit}
        templates={overpassTemplates}
        runner={overpass}
        hits={overpassHits}
        onClear={() => setOverpassHits(null)}
      />

      {shapeEdit && (
        <div className="map-overlay map-placing" role="status">
          <span>
            {objects.find((o) => o.id === shapeEdit.id)?.name}: {editHint(shapeEdit)}
          </span>
          {canRemovePoint(shapeEdit) && (
            <button type="button" className="btn btn-sm" onClick={() => setShapeEdit(removePoint(shapeEdit))} title="Gewählten Punkt entfernen (Entf)">
              <Trash2 size={14} /> Punkt entfernen
            </button>
          )}
          <button type="button" className="btn btn-sm btn-primary" disabled={saveShape.isPending} onClick={() => saveShape.mutate(shapeEdit)} title="Form speichern (Enter)">
            <Check size={14} /> Speichern
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setShapeEdit(null)} title="Abbrechen (Esc)">
            Abbrechen
          </button>
        </div>
      )}

      {drawing && (
        <div className="map-overlay map-placing" role="status">
          <span>
            {SHAPE_LABELS[drawing.kind]}: {drawHint(drawing)}
          </span>
          {drawing.points.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={undoDrawPoint} title="Letzten Punkt entfernen (Strg+Z)">
              <Undo2 size={14} /> Rückgängig
            </button>
          )}
          {(drawing.kind === 'polygon' || drawing.kind === 'line') && (
            <button type="button" className="btn btn-sm btn-primary" disabled={!canFinish(drawing)} onClick={() => finishDrawing(drawing)} title="Form speichern (Enter)">
              <Check size={14} /> Fertig
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => setDrawing(null)} title="Abbrechen (Esc)">
            Abbrechen
          </button>
        </div>
      )}

      {(placing || placingUnit) && (
        <div className="map-overlay map-placing" role="status">
          <span>In die Karte tippen, um {placingUnit ? placingUnit.name : PLACE_LABELS[placing!]} zu setzen</span>
          {placing !== 'incident' && iPos && (
            <button type="button" className="btn btn-sm" onClick={() => place((placingUnit ?? placing)!, iPos[0], iPos[1])}>
              Am Einsatzort
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => (setPlacing(null), setPlacingUnit(null))}>
            Abbrechen
          </button>
        </div>
      )}

      <MapStylePicker
        sources={sources}
        value={sources.some((s) => s.id === sourceId) ? sourceId : null}
        auto={autoSource(sources, dark)}
        onChange={chooseSource}
        layers={layers}
        onLayers={chooseLayers}
        onMenuHeight={setStyleMenuPx}
      />

      {layers.radar && <RadarControl radar={radar} />}

      {timeline && incident && (
        <TimelineBar startedAt={incident.startedAt} now={now} at={historyAt} loading={!!historyAt && historyQuery.isFetching} onChange={travel} onClose={() => (setTimeline(false), travel(null))} />
      )}

      {(layers.aircraft || layers.ships) && !historyAt && (
        <div className={`map-overlay map-traffic-status ${layers.radar ? 'above-radar' : ''}`} role="status">
          {layers.aircraft && aircraftStatus && (
            <span title={aircraftStatus.problem ?? undefined}>
              <Plane size={15} />
              {aircraftStatus.tooFar ? 'zum Anzeigen hineinzoomen' : aircraftStatus.problem && !aircraftStatus.count ? aircraftStatus.problem : `${aircraftStatus.count} Flugzeuge`}
            </span>
          )}
          {layers.aircraft && (
            <span className="altitude-legend" title="Farbe nach Flughöhe (wie tar1090)">
              <span className="muted">0</span>
              <span className="altitude-legend-bar" style={{ background: `linear-gradient(to right, ${ALTITUDE_LEGEND.map((l) => l.color).join(', ')})` }} />
              <span className="muted">FL400</span>
            </span>
          )}
          {layers.ships && shipStatus && (
            <span title={shipStatus.problem ?? undefined}>
              <Ship size={15} />
              {shipStatus.tooFar ? 'zum Anzeigen hineinzoomen' : shipStatus.problem && !shipStatus.count ? shipStatus.problem : `${shipStatus.count} Schiffe`}
            </span>
          )}
        </div>
      )}

      {incident && (
        <ObjectList
          incident={shownIncident!}
          vehicle={{ name: vehicleName, pos: vPos }}
          objects={objects}
          units={units}
          wind={wind}
          now={now}
          canEdit={canEdit}
          onPlaceUnit={(u) => (setPlacing(null), setDrawing(null), setShapeEdit(null), setPlacingUnit(u))}
          onEditShape={editShape}
          shiftPx={styleMenuPx}
          onFly={flyToObject}
          onMoveIncident={() => (setDrawing(null), setPlacing('incident'))}
        />
      )}

      {weather && <WindTile speedMs={weather.state.windSpeedMs} directionDeg={weather.state.windDirectionDeg} gustMs={weather.state.windGustMs} />}

      <Modal open={choosingSign} title="Zeichen einfügen" onClose={() => setChoosingSign(false)}>
        {choosingSign && (
          <Dv102Picker value={sign && 'sign' in sign ? sign.sign : null} onPick={(id) => placeSign({ sign: id })} onGenerator={(base) => (setChoosingSign(false), setGenerating(generatorSign(base)))} />
        )}
      </Modal>
      <GeneratorSignDialog
        open={!!generating}
        initial={generating ?? generatorSign()}
        action="In die Karte setzen"
        onClose={() => setGenerating(null)}
        onDone={(tactical) => placeSign({ tactical })}
      />

      <Modal open={searchingTraffic} title="Flugzeug oder Schiff suchen" onClose={() => setSearchingTraffic(false)}>
        {searchingTraffic && <TrafficSearch tracked={tracked} onPick={addTraffic} />}
      </Modal>

      <Modal open={printing} title="Lagekarte drucken" onClose={() => setPrinting(false)} wide>
        {source && (
          <PrintDialog
            sources={sources}
            initialSourceId={printSource(sources, source)!.id}
            initialCenter={view.current ?? (() => { const c = iPos ?? vPos ?? fallback; return { lat: c[0], lon: c[1] }; })()}
            initialZoom={view.current?.zoom ?? (iPos ? 14 : 16)}
            vehicle={vPos ? { lat: vPos[0], lon: vPos[1], name: vehicleName } : null}
            incident={shownIncident ?? null}
            objects={objects}
            units={units}
            wind={wind}
            weatherGustMs={ws?.windGustMs ?? null}
            onDone={() => setPrinting(false)}
          />
        )}
      </Modal>
    </div>
  );
}
