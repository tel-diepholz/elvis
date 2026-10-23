import { useEffect, useMemo, useRef, useState } from 'react';
import { GeoJSON, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L, { type LatLngBoundsExpression, type LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListPlus, MapPin, Printer, X } from 'lucide-react';
import { DEFAULT_GAUSS, DEFAULT_VEHICLE_SIGN, hasOutline, toMgrs, type GeocodeResult, type MapObject, type NewMapObject } from '@elvis/shared';
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
import { PrintDialog } from './map/PrintDialog';
import { MapSearch } from './map/search';
import { ObjectList } from './map/objectlist';
import { MapStylePicker, ObjectMenu, WindTile, type PlaceKind } from './map/toolbar';

const VIEW_KEY = 'elvis.map.view';

const incidentIcon = L.divIcon({ className: 'map-marker incident', html: '<span>!</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
const searchIcon = L.divIcon({ className: 'map-marker search', html: '<span></span>', iconSize: [20, 20], iconAnchor: [10, 10] });

const PLACE_LABELS: Record<PlaceKind, string> = { incident: 'den Einsatzort', gauss: 'die Quelle der Gauß-Fahne', sector: 'den Ursprung des Sektors' };

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
  const { data: objects = [] } = useMapObjects(incident?.id);
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [placing, setPlacing] = useState<PlaceKind | null>(null);
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [searchHit, setSearchHit] = useState<GeocodeResult | null>(null);
  const [printing, setPrinting] = useState(false);
  /** Offenes Kartenstil-Menü schiebt die Objektliste nach unten */
  const [styleMenuPx, setStyleMenuPx] = useState(0);
  const view = useRef<{ lat: number; lon: number; zoom: number } | null>(null);
  // Zuletzt eingestellter Ausschnitt (nur beim Aufbau gelesen); ohne ihn Einsatzort, Fahrzeug oder Deutschland
  const [saved] = useState(() => loadMapView(VIEW_KEY));
  const { data: sources = [] } = useQuery({ queryKey: ['mapSources'], queryFn: api.mapSources, staleTime: Infinity });
  // null = automatisch passend zum Design (dunkle Kacheln im Dunkelmodus)
  const [sourceId, setSourceId] = useState<string | null>(null);
  const dark = effectiveTheme(useTheme()) === 'dark';
  const source = sources.find((s) => s.id === sourceId) ?? autoSource(sources, dark);

  const origin = useMemo(
    () => (incident?.lat != null && incident.lon != null ? { lat: incident.lat, lon: incident.lon } : null),
    [incident?.lat, incident?.lon],
  );
  // Für Ausbreitung nötig: Windgeschwindigkeit und -richtung
  const ws = weather?.state;
  const wind = ws && ws.windSpeedMs !== null && ws.windDirectionDeg !== null ? { windSpeedMs: ws.windSpeedMs, windDirectionDeg: ws.windDirectionDeg } : undefined;
  /** Objekte ändern: angemeldet und laufender Einsatz */
  const canEdit = !!user && !!incident && !incident.closedAt;

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
  const searchFocus = () => view.current ?? (vPos ? { lat: vPos[0], lon: vPos[1] } : origin);

  // Im Einsatz lässt sich das eigene Fahrzeug in der Objektliste ausblenden
  const showVehicle = !!vPos && (incident?.vehicleVisible ?? true);

  const flyToObject = (target: MapObject | 'incident' | 'vehicle') => {
    if (target === 'incident') return iPos && fly(iPos, { zoom: 16 });
    if (target === 'vehicle') return vPos && fly(vPos, { zoom: 16 });
    const b = objectBounds(target);
    if (target.kind === 'area') fly(b.getCenter(), { bounds: b, zoom: 16 });
    else fly([target.lat, target.lon], { zoom: target.kind === 'point' ? 17 : 14 });
  };

  /** Suchtreffer übernehmen: mit Umriss als Fläche, sonst als Punkt */
  const addHit = async (r: GeocodeResult) => {
    const base = { name: r.name, lat: r.lat, lon: r.lon };
    const outline = hasOutline(r)
      ? await queryClient.fetchQuery({ queryKey: ['mapOutline', r.osm], queryFn: () => api.mapOutline(r.osm!), staleTime: Infinity }).catch(() => null)
      : null;
    addObject.mutate(
      outline ? { ...base, kind: 'area', data: { detail: r.detail, osm: r.osm, outline } } : { ...base, kind: 'point', data: { detail: r.detail } },
      { onSuccess: () => setSearchHit(null) },
    );
  };

  const place = (kind: PlaceKind, lat: number, lon: number) => {
    setPlacing(null);
    if (kind === 'incident') setLocation.mutate({ lat, lon });
    else if (kind === 'gauss') addObject.mutate({ kind: 'gauss', name: 'Gauß-Fahne', lat, lon, data: DEFAULT_GAUSS });
    else addObject.mutate({ kind: 'sector', name: 'Sektor 60°', lat, lon, data: { sectorM: 1000 } });
  };

  return (
    <div className="map-page">
      <MapContainer
        center={saved ? [saved.lat, saved.lon] : iPos ?? vPos ?? fallback}
        zoom={saved?.zoom ?? (iPos ? 14 : vPos ? 16 : 6)}
        className={`map ${placing ? 'placing' : ''}`}
        zoomControl={false}
      >
        {source && <TileLayer key={source.id} url={api.tileUrl(source.id)} attribution={source.attribution} maxZoom={source.maxZoom} />}
        <MapObjectsLayer objects={objects} wind={wind} now={now} />
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
        <ClickToPlace active={!!placing} onPick={(lat, lon) => placing && place(placing, lat, lon)} />
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
        <FlyTo target={flyTarget} />
        <ViewTracker view={view} />
      </MapContainer>

      <div className="map-overlay map-tools">
        <MapSearch focus={searchFocus} onSelect={showHit} />
        <ObjectMenu
          enabled={canEdit}
          reason={!incident ? 'Objekte gehören zu einem Einsatz – erst einen Einsatz auflegen' : 'Zum Bearbeiten anmelden'}
          hasLocation={!!iPos}
          onPlace={setPlacing}
        />
        {user && (
          <button className="btn" onClick={() => setPrinting(true)} disabled={!source}>
            <Printer size={18} /> Drucken
          </button>
        )}
      </div>

      {placing && (
        <div className="map-overlay map-placing" role="status">
          <span>In die Karte tippen, um {PLACE_LABELS[placing]} zu setzen</span>
          {placing !== 'incident' && iPos && (
            <button type="button" className="btn btn-sm" onClick={() => place(placing, iPos[0], iPos[1])}>
              Am Einsatzort
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => setPlacing(null)}>
            Abbrechen
          </button>
        </div>
      )}

      <MapStylePicker sources={sources} value={sourceId} auto={autoSource(sources, dark)} onChange={setSourceId} onMenuHeight={setStyleMenuPx} />

      {incident && (
        <ObjectList
          incident={incident}
          vehicle={{ name: vehicleName, pos: vPos }}
          objects={objects}
          wind={wind}
          now={now}
          canEdit={canEdit}
          shiftPx={styleMenuPx}
          onFly={flyToObject}
          onMoveIncident={() => setPlacing('incident')}
        />
      )}

      {weather && <WindTile speedMs={weather.state.windSpeedMs} directionDeg={weather.state.windDirectionDeg} gustMs={weather.state.windGustMs} />}

      <Modal open={printing} title="Lagekarte drucken" onClose={() => setPrinting(false)} wide>
        {source && (
          <PrintDialog
            sources={sources}
            initialSourceId={printSource(sources, source)!.id}
            initialCenter={view.current ?? (() => { const c = iPos ?? vPos ?? fallback; return { lat: c[0], lon: c[1] }; })()}
            initialZoom={view.current?.zoom ?? (iPos ? 14 : 16)}
            vehicle={vPos ? { lat: vPos[0], lon: vPos[1], name: vehicleName } : null}
            incident={incident ?? null}
            objects={objects}
            wind={wind}
            weatherGustMs={ws?.windGustMs ?? null}
            onDone={() => setPrinting(false)}
          />
        )}
      </Modal>
    </div>
  );
}
