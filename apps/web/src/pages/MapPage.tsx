import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polygon, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L, { type LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Crosshair, MapPin, Printer, Truck, Wind } from 'lucide-react';
import { api } from '../lib/api';
import { compass, fmtOpt } from '../lib/format';
import { useActiveIncident, useMediaQuery, useNow, useSettings } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { autoSource, printSource } from '../lib/mapSources';
import { loadMapView, saveMapView } from '../lib/mapView';
import { effectiveTheme, useTheme } from '../lib/theme';
import { useDevice } from '../lib/live';
import { tacticalIcon } from '../components/tactical/TacticalSign';
import { DEFAULT_VEHICLE_SIGN } from '@elvis/shared';
import { useToast } from '../lib/toast';
import { WindCompass } from '../components/WindCompass';
import { Modal } from '../components/ui';
import { PrintDialog } from './map/PrintDialog';
import { DEFAULT_SETTINGS, DispersionControls, dispersionSector, usePlume, type DispersionSettings } from './map/dispersion';

const VIEW_KEY = 'elvis.map.view';

const incidentIcon = L.divIcon({ className: 'map-marker incident', html: '<span>!</span>', iconSize: [30, 30], iconAnchor: [15, 15] });

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
  return null;
}

function FlyTo({ target }: { target: { pos: LatLngExpression; n: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target.pos, Math.max(map.getZoom(), 16));
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
  const toast = useToast();
  const now = useNow();
  const compact = useMediaQuery('(max-width: 900px)');
  const [placing, setPlacing] = useState(false);
  const [settings, setSettings] = useState<DispersionSettings>(DEFAULT_SETTINGS);
  const [panelOpen, setPanelOpen] = useState(!compact);
  const [flyTarget, setFlyTarget] = useState<{ pos: LatLngExpression; n: number } | null>(null);
  const [printing, setPrinting] = useState(false);
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
  const plume = usePlume(settings, origin, wind, now);

  const setLocation = useMutation({
    mutationFn: (pos: { lat: number; lon: number }) => api.updateIncident(incident!.id, pos),
    onSuccess: () => toast('success', 'Einsatzort gesetzt'),
    onError: (e) => toast('error', e.message),
  });

  // Fahrzeugstandort aus dem GPS der Wetterstation (Airmar); ohne GPS kein Fahrzeugmarker
  const gps = weather?.state.position ?? null;
  const vPos: [number, number] | null = gps ? [gps.lat, gps.lon] : null;
  /** Mitte Deutschlands, falls weder Einsatzort noch Fahrzeugposition bekannt sind. */
  const fallback: [number, number] = [51.1657, 10.4515];
  const iPos: [number, number] | null = origin ? [origin.lat, origin.lon] : null;
  const fly = (pos: LatLngExpression) => setFlyTarget((t) => ({ pos, n: (t?.n ?? 0) + 1 }));

  return (
    <div className="map-page">
      <MapContainer
        center={saved ? [saved.lat, saved.lon] : iPos ?? vPos ?? fallback}
        zoom={saved?.zoom ?? (iPos ? 14 : vPos ? 16 : 6)}
        className={`map ${placing ? 'placing' : ''}`}
        zoomControl={false}
      >
        {source && <TileLayer key={source.id} url={api.tileUrl(source.id)} attribution={source.attribution} maxZoom={source.maxZoom} />}
        {plume?.contours.map(({ level, polygon }) => (
          <Polygon key={level.threshold} positions={polygon} pathOptions={level.path} interactive={false} />
        ))}
        {iPos && wind && settings.mode === 'sector' && (
          <Polygon
            positions={dispersionSector(iPos[0], iPos[1], wind.windDirectionDeg, settings.sectorM)}
            pathOptions={{ color: '#e3a008', fillColor: '#e3a008', fillOpacity: 0.22, weight: 2, dashArray: '6 4' }}
            interactive={false}
          />
        )}
        {vPos && (
        <Marker position={vPos} icon={vehicleIcon}>
          <Popup>
            <strong>{vehicleName}</strong>
            <br />
            {vPos[0].toFixed(5)}, {vPos[1].toFixed(5)}
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
        <ClickToPlace
          active={placing}
          onPick={(lat, lon) => {
            setPlacing(false);
            setLocation.mutate({ lat, lon });
          }}
        />
        <FlyTo target={flyTarget} />
        <ViewTracker view={view} />
      </MapContainer>

      <div className="map-overlay map-tools">
        {vPos && (
          <button className="btn" onClick={() => fly(vPos)}>
            <Truck size={18} /> Fahrzeug
          </button>
        )}
        {iPos && (
          <button className="btn" onClick={() => fly(iPos)}>
            <Crosshair size={18} /> Einsatzort
          </button>
        )}
        {incident && (
          <button className={`btn ${placing ? 'btn-primary' : ''}`} onClick={() => setPlacing((p) => !p)}>
            <MapPin size={18} /> {placing ? 'In Karte tippen …' : iPos ? 'Einsatzort ändern' : 'Einsatzort setzen'}
          </button>
        )}
        {user && (
          <button className="btn" onClick={() => setPrinting(true)} disabled={!source}>
            <Printer size={18} /> Drucken
          </button>
        )}
        {sources.length > 1 && (
          <select value={sourceId ?? ''} onChange={(e) => setSourceId(e.target.value || null)} aria-label="Kartenstil" className="map-style-select">
            <option value="">Automatisch ({autoSource(sources, dark)?.name})</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {weather && (
        <div className="map-overlay map-panel">
          <button className="map-panel-head" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen}>
            <WindCompass directionDeg={weather.state.windDirectionDeg} size={64} />
            <div className="map-panel-wind">
              <div className="map-wind-value">
                <Wind size={16} /> {fmtOpt(weather.state.windSpeedMs)} m/s
              </div>
              <div className="muted">
                {weather.state.windDirectionDeg === null ? 'Richtung unbekannt' : `aus ${compass(weather.state.windDirectionDeg)}`} · Böen {fmtOpt(weather.state.windGustMs)}
              </div>
            </div>
            {panelOpen ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
          </button>
          {panelOpen &&
            (iPos ? (
              <DispersionControls settings={settings} onChange={setSettings} result={plume} noWind={!wind} />
            ) : (
              <p className="muted dispersion-note">
                {incident ? 'Einsatzort auf der Karte setzen, um die Ausbreitung darzustellen.' : 'Die Ausbreitung wird angezeigt, sobald ein Einsatz mit Einsatzort aufgelegt ist.'}
              </p>
            ))}
        </div>
      )}

      <Modal open={printing} title="Lagekarte drucken" onClose={() => setPrinting(false)} wide>
        {source && (
          <PrintDialog
            sources={sources}
            initialSourceId={printSource(sources, source)!.id}
            initialCenter={view.current ?? (() => { const c = iPos ?? vPos ?? fallback; return { lat: c[0], lon: c[1] }; })()}
            initialZoom={view.current?.zoom ?? (iPos ? 14 : 16)}
            vehicle={vPos ? { lat: vPos[0], lon: vPos[1], name: vehicleName } : null}
            incident={incident ?? null}
            wind={wind}
            weatherGustMs={ws?.windGustMs ?? null}
            settings={settings}
            plume={plume}
            onDone={() => setPrinting(false)}
          />
        )}
      </Modal>
    </div>
  );
}
