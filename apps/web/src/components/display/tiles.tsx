import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useQuery } from '@tanstack/react-query';
import { Bell, Cctv, Clock, CloudSun, ListChecks, Map as MapIcon, Network, Repeat, Type, Users, Video, Wifi } from 'lucide-react';
import {
  DEFAULT_VEHICLE_SIGN,
  DISPLAY_TILE_TYPES,
  UNIT_STATUS,
  fmtInterval,
  formatDtg,
  formatStrength,
  isOnScene,
  sumStrength,
  taskDueAt,
  taskIsDue,
  unitChildren,
  unitDescendants,
  type DisplayMapView,
  type DisplayTile,
  type DisplayTileType,
  type Unit,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { compass, fmtDate, fmtOpt, fmtTime } from '../../lib/format';
import { useNow, useSettings } from '../../lib/hooks';
import { autoSource } from '../../lib/mapSources';
import { DISPLAY_MAP_VIEW_EVENT, useAlerts, useDevice } from '../../lib/live';
import { loadMapView, sameMapView, saveMapView } from '../../lib/mapView';
import { AlertList } from '../AlertPanel';
import { CameraImage } from '../camera/CameraImage';
import { TacticalSignImage, tacticalIcon } from '../tactical/TacticalSign';
import { WindCompass } from '../WindCompass';
import { WebRtcPlayer } from './WebRtcPlayer';
import { MapObjectsLayer, useMapObjects } from '../map/objects';
import { UnitsLayer, useMapUnits } from '../map/units';
import { WifiQr } from '../WifiQr';
import { fmtRelative } from '../tasks/taskActions';

export const TILE_ICONS: Record<DisplayTileType, typeof MapIcon> = { map: MapIcon, camera: Cctv, video: Video, weather: CloudSun, clock: Clock, alerts: Bell, network: Network, text: Type, guestWifi: Wifi, tasks: ListChecks, forces: Users };

const date = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ClockTile() {
  const now = useNow();
  return (
    <div className="tile-clock">
      <div className="tile-clock-dtg">{formatDtg(now)}</div>
      <div className="tile-clock-time">{time.format(now)}</div>
      <div className="tile-clock-date">{date.format(now)}</div>
    </div>
  );
}

function WeatherTile() {
  const w = useDevice('weather')?.state;
  if (!w) return <TileEmpty text="Wetterstation nicht aktiviert" />;
  const dir = w.windDirectionDeg;
  return (
    <div className="tile-weather">
      <WindCompass directionDeg={dir} size={160} />
      <dl>
        <dt>Wind</dt>
        <dd>
          {fmtOpt(w.windSpeedMs)} <small>m/s</small>
        </dd>
        <dt>Böen</dt>
        <dd>
          {fmtOpt(w.windGustMs)} <small>m/s</small>
        </dd>
        <dt>aus / nach</dt>
        <dd>{dir === null ? '–' : `${compass(dir)} → ${compass((dir + 180) % 360)}`}</dd>
        <dt>Temperatur</dt>
        <dd>
          {fmtOpt(w.temperatureC)} <small>°C</small>
        </dd>
      </dl>
    </div>
  );
}

function AlertsTile() {
  const alerts = useAlerts();
  return (
    <div className="tile-scroll">
      <AlertList alerts={alerts} compact />
    </div>
  );
}

function NetworkTile() {
  const router = useDevice('router');
  if (!router) return <TileEmpty text="ELW-Router nicht aktiviert" />;
  const s = router.state;
  const active = s.failover.members.find((m) => m.active);
  return (
    <div className="tile-network">
      <div className={`tile-network-main ${!router.online || !s.internet ? 'tone-alarm' : s.failover.onBackup ? 'tone-warn' : 'tone-ok'}`}>
        {!router.online ? 'Router nicht erreichbar' : s.internet ? `Internet über ${active?.label ?? '–'}` : 'Kein Internet'}
      </div>
      <ul>
        {s.failover.members.map((m) => (
          <li key={m.id} className={m.active ? 'active' : undefined}>
            <span className={`dot tone-bg-${m.status === 'online' ? 'ok' : m.status === 'offline' ? 'alarm' : 'muted'}`} /> {m.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CameraTile({ tile }: { tile: DisplayTile }) {
  const cams = useDevice('cameras')?.state.cameras ?? [];
  const cam = cams.find((c) => c.id === tile.config.cameraId) ?? (tile.config.cameraId ? undefined : cams[0]);
  if (!cam) return <TileEmpty text={cams.length ? 'Kamera nicht gefunden' : 'Keine Kamera eingerichtet'} />;
  return (
    <div className="tile-camera">
      <CameraImage cam={cam} kind="live" />
      <span className="tile-camera-label">{cam.name}</span>
    </div>
  );
}

// wie auf der Lagekarte
/** Videostrom eines Gateways (z. B. NDI) über den WebRTC-Player von MediaMTX */
function VideoTile({ tile }: { tile: DisplayTile }) {
  const { data } = useQuery({ queryKey: ['videoSources'], queryFn: api.videoSources });
  if (!data) return <TileEmpty text="Lade Videoquellen …" />;
  const stream = tile.config.streamId ? data.streams.find((s) => s.id === tile.config.streamId) : data.streams[0];
  if (!stream) {
    const problem = data.providers.find((p) => p.problem)?.problem;
    if (!data.providers.length) return <TileEmpty text="Kein Video-Gateway installiert (Addon „NDI-Gateway“)" />;
    return <TileEmpty text={problem ?? (tile.config.streamId ? 'Quelle derzeit nicht verfügbar' : 'Keine NDI-Quelle gefunden')} />;
  }
  if (stream.state === 'error') return <TileEmpty text={`${stream.name}: ${stream.error ?? 'Störung'}`} />;
  return (
    <div className="tile-camera">
      <WebRtcPlayer key={stream.url} url={stream.url} audio={tile.config.audio === true} />
      <span className="tile-camera-label">{stream.name}</span>
    </div>
  );
}

const incidentIcon = L.divIcon({ className: 'map-marker incident', html: '<span>!</span>', iconSize: [30, 30], iconAnchor: [15, 15] });

/** Karte bei Positionsänderung des Fahrzeugs mitführen */
function Follow({ pos, enabled }: { pos: [number, number] | null; enabled: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (enabled && pos) map.panTo(pos, { animate: true });
  }, [map, enabled, pos?.[0], pos?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * Abgleich der Kartenausschnitte zwischen Bildschirm und ELVIS. Auf dem Bildschirm meldet onMove den Ausschnitt an den
 * Server; in der Vorschau unter „Bildschirme“ kommen die gemeldeten Ausschnitte als views herein und onMove steuert den
 * Bildschirm fern. Nur ohne Mitführen – mitgeführte Karten stehen überall gleich. Ohne Kontext (z. B. im Editor) bleibt die Karte für sich.
 */
export interface MapSync {
  views?: Record<string, DisplayMapView>;
  onMove: (tileId: string, view: DisplayMapView) => void;
}

export const MapSyncContext = createContext<MapSync | null>(null);

const currentView = (map: L.Map): DisplayMapView => {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
};

/** Bildschirm: Ausschnitt nach Verschieben/Zoomen merken (übersteht ein Neuladen) und an ELVIS melden */
function ReportView({ tileId, sync }: { tileId: string; sync: MapSync }) {
  const map = useMapEvents({
    moveend: () => {
      const view = currentView(map);
      saveMapView(mapViewKey(tileId), view);
      sync.onMove(tileId, view);
    },
  });
  // Einmal beim Start melden, damit die Vorschau auch nach einem Neustart von ELVIS stimmt
  useEffect(() => sync.onMove(tileId, currentView(map)), [map, tileId]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Bildschirm: Ausschnitt aus ELVIS übernehmen (Fernsteuerung) */
function RemoteTarget({ tileId }: { tileId: string }) {
  const map = useMap();
  useEffect(() => {
    const onView = (e: Event) => {
      const { tileId: id, view } = (e as CustomEvent<{ tileId: string; view: DisplayMapView }>).detail;
      if (id === tileId) map.setView([view.lat, view.lon], view.zoom);
    };
    window.addEventListener(DISPLAY_MAP_VIEW_EVENT, onView);
    return () => window.removeEventListener(DISPLAY_MAP_VIEW_EVENT, onView);
  }, [map, tileId]);
  return null;
}

/**
 * Vorschau in ELVIS: zeigt den Ausschnitt des Bildschirms und schickt eigene Eingaben dorthin. Nur Bewegungen kurz
 * nach einer Eingabe zählen – Mitführen, Größenänderung und übernommene Ausschnitte lösen nichts aus.
 */
function RemoteControl({ tileId, view, onMove }: { tileId: string; view: DisplayMapView | undefined; onMove: MapSync['onMove'] }) {
  const lastInput = useRef(0);
  const map = useMapEvents({
    moveend: () => {
      if (Date.now() - lastInput.current < 2_000) onMove(tileId, currentView(map));
    },
  });
  useEffect(() => {
    const el = map.getContainer();
    const input = () => (lastInput.current = Date.now());
    const events = ['pointerdown', 'pointerup', 'wheel', 'dblclick'] as const;
    events.forEach((ev) => el.addEventListener(ev, input, { passive: true }));
    return () => events.forEach((ev) => el.removeEventListener(ev, input));
  }, [map]);
  useEffect(() => {
    // Während eigener Eingaben nicht dazwischenfunken (Rückmeldungen älterer Ausschnitte)
    if (view && Date.now() - lastInput.current > 2_000 && !sameMapView(view, currentView(map))) map.setView([view.lat, view.lon], view.zoom, { animate: false });
  }, [map, view?.lat, view?.lon, view?.zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const mapViewKey = (tileId: string) => `elvis.display.mapView.${tileId}`;

/**
 * Bedienung der Karte: ohne Mitführen frei verschieben und zoomen, mit Mitführen gesperrt – dann folgt der Ausschnitt
 * nur Fahrzeug bzw. Einsatzort. Die Klasse map-locked lässt in der Vorschau die Eingaben durch die Karte hindurch.
 */
function Interaction({ enabled }: { enabled: boolean }) {
  const map = useMap();
  useEffect(() => {
    const handlers = [map.dragging, map.touchZoom, map.doubleClickZoom, map.scrollWheelZoom, map.boxZoom, map.keyboard];
    handlers.forEach((h) => (enabled ? h.enable() : h.disable()));
    map.getContainer().classList.toggle('map-locked', !enabled);
  }, [map, enabled]);
  return null;
}

/** Größenänderung der Kachel an Leaflet weitergeben */
function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

function MapTile({ tile }: { tile: DisplayTile }) {
  const settings = useSettings().data;
  const weather = useDevice('weather');
  const { data: sources = [] } = useQuery({ queryKey: ['mapSources'], queryFn: api.mapSources, staleTime: Infinity });
  // Einsatzort: Bildschirme und angemeldete Benutzer dürfen ihn lesen, sonst bleibt er weg
  const { data: incident } = useQuery({ queryKey: ['incident', 'active', 'display'], queryFn: () => api.activeIncident().catch(() => null) });
  const icon = useMemo(() => tacticalIcon(settings?.mapSign ?? DEFAULT_VEHICLE_SIGN), [settings?.mapSign]);
  // Kartenobjekte des Einsatzes (Flächen, Punkte, Ausbreitungen) wie auf der Karte in ELVIS
  const { data: objects = [] } = useMapObjects(incident?.id);
  const { data: units = [] } = useMapUnits(incident?.id);
  const now = useNow();
  const ws = weather?.state;
  const wind = ws && ws.windSpeedMs !== null && ws.windDirectionDeg !== null ? { windSpeedMs: ws.windSpeedMs, windDirectionDeg: ws.windDirectionDeg } : undefined;
  const source = sources.find((s) => s.id === tile.config.sourceId) ?? autoSource(sources, true);
  const gps = weather?.state.position;
  const vPos: [number, number] | null = gps ? [gps.lat, gps.lon] : null;
  const iPos: [number, number] | null = incident?.lat != null && incident.lon != null ? [incident.lat, incident.lon] : null;
  const follow = tile.config.follow !== false;
  const sync = useContext(MapSyncContext);
  const preview = !!sync?.views;
  // Startausschnitt (nur beim Aufbau gelesen): in der Vorschau der des Bildschirms, auf dem Bildschirm ohne Mitführen
  // der zuletzt eingestellte
  const saved = useMemo(
    () => (preview ? sync.views![tile.id] : sync && !follow ? loadMapView(mapViewKey(tile.id)) : null) ?? null,
    [tile.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const zoom = Number(tile.config.zoom) || 15;
  const center = (tile.config.center === 'incident' ? iPos ?? vPos : vPos ?? iPos) ?? [51.1657, 10.4515];
  return (
    <MapContainer
      center={saved ? [saved.lat, saved.lon] : center}
      zoom={saved ? saved.zoom : vPos || iPos ? zoom : 6}
      className="tile-map"
      zoomControl={false}
      attributionControl={false}
    >
      {source && <TileLayer key={source.id} url={api.tileUrl(source.id)} maxZoom={source.maxZoom} />}
      <MapObjectsLayer objects={objects} wind={wind} now={now} />
      <UnitsLayer units={units} />
      {vPos && (incident?.vehicleVisible ?? true) && <Marker position={vPos} icon={icon} />}
      {iPos && <Marker position={iPos} icon={incidentIcon} />}
      <Follow pos={tile.config.center === 'incident' ? iPos : vPos} enabled={follow} />
      <Interaction enabled={!follow} />
      {sync && preview && !follow && <RemoteControl tileId={tile.id} view={sync.views![tile.id]} onMove={sync.onMove} />}
      {sync && !preview && !follow && <RemoteTarget tileId={tile.id} />}
      {sync && !preview && !follow && <ReportView tileId={tile.id} sync={sync} />}
      <AutoResize />
    </MapContainer>
  );
}

/**
 * Größte Schrift, bei der der Text vollständig in die Kachel passt (Halbierungssuche, neu bei Größen-/Textänderung).
 * Zeilen bleiben möglichst ganz: ohne automatischen Umbruch gewinnt, solange die Schrift höchstens 30 % kleiner ist –
 * bei Text mit eigenen Zeilenumbrüchen (Listen wie Funkkanäle) sogar bis zur halben Größe. Kurze Sätze dürfen groß umbrechen.
 */
function FitText({ text, align }: { text: string; align: 'left' | 'center' }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const content = inner.current;
    if (!el || !content) return;
    const largest = (wrap: boolean) => {
      content.style.whiteSpace = wrap ? 'pre-wrap' : 'pre';
      let lo = 8;
      let hi = 400;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        content.style.fontSize = `${mid}px`;
        if (content.scrollHeight <= el.clientHeight && content.scrollWidth <= el.clientWidth) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const fit = () => {
      const wrapped = largest(true);
      const lines = largest(false);
      const keepLines = lines >= wrapped * (text.includes('\n') ? 0.5 : 0.7);
      content.style.whiteSpace = keepLines ? 'pre' : 'pre-wrap';
      content.style.fontSize = `${keepLines ? lines : wrapped}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div ref={box} className={`tile-text-box align-${align}`}>
      <div ref={inner} className="tile-text-content">
        {text}
      </div>
    </div>
  );
}

function TextTile({ tile }: { tile: DisplayTile }) {
  const text = String(tile.config.text ?? '').trim();
  const tone = String(tile.config.tone ?? 'normal');
  return (
    <div className={`tile-text tile-text-${tone}`}>
      {text ? <FitText text={text} align={tile.config.align === 'left' ? 'left' : 'center'} /> : <TileEmpty text="Kein Text hinterlegt" />}
    </div>
  );
}

/** Gastnetz des laufenden Einsatzes zum Abscannen */
function GuestWifiTile({ tile }: { tile: DisplayTile }) {
  const { data } = useQuery({ queryKey: ['wifi', 'guest'], queryFn: api.wifiGuest });
  if (!data) return <TileEmpty text="Lade Gastnetz …" />;
  if (!data.active) return <TileEmpty text={data.reason} />;
  const title = String(tile.config.title ?? '').trim();
  return (
    <div className="tile-wifi">
      <WifiQr ssid={data.ssid} password={data.password} className="tile-wifi-qr" />
      <dl>
        {title && <div className="tile-wifi-title">{title}</div>}
        <dt>WLAN</dt>
        <dd>{data.ssid}</dd>
        <dt>Passwort</dt>
        <dd>{data.password}</dd>
      </dl>
    </div>
  );
}

/** Offene Aufgaben des Einsatzes nach Fälligkeit; persönliche (einem Benutzer zugewiesene) nur auf Wunsch */
function TasksTile({ tile }: { tile: DisplayTile }) {
  const now = useNow();
  const { data: incident } = useQuery({ queryKey: ['incident', 'active', 'display'], queryFn: () => api.activeIncident().catch(() => null) });
  const { data: tasks } = useQuery({ queryKey: ['tasks', incident?.id ?? 0, 'display'], queryFn: () => api.tasks(incident!.id), enabled: !!incident });
  if (!incident) return <TileEmpty text="Kein Einsatz aufgelegt" />;
  if (!tasks) return <TileEmpty text="Lade Aufgaben …" />;
  const personal = tile.config.personal === true;
  const open = tasks.filter((t) => !t.doneAt && (personal || t.assignee.kind !== 'user'));
  if (!open.length) return <TileEmpty text="Keine offenen Aufgaben" />;
  const dueCount = open.filter((t) => taskIsDue(t, now)).length;
  return (
    <div className="tile-tasks">
      <div className="tile-tasks-head">
        {open.length} offen{dueCount > 0 && <span className="tone-alarm"> · {dueCount} fällig</span>}
      </div>
      <ul>
        {open.map((t) => {
          const due = taskDueAt(t);
          const today = due && new Date(due).toDateString() === now.toDateString();
          return (
            <li key={t.id} className={taskIsDue(t, now) ? 'due' : undefined}>
              <span className="tile-task-time">{due ? (today ? fmtTime(due) : `${fmtDate(due).slice(0, 6)} ${fmtTime(due)}`) : '–'}</span>
              <span className="tile-task-main">
                <span className="tile-task-summary">{t.summary}</span>
                <span className="tile-task-meta">
                  {[due && fmtRelative(due, now), t.assigneeName ?? 'Alle', t.snoozedUntil && 'geschoben'].filter(Boolean).join(' · ')}
                  {t.intervalMinutes !== null && (
                    <>
                      {' · '}
                      <Repeat size="1em" /> {fmtInterval(t.intervalMinutes)}
                    </>
                  )}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const NO_SECTION = 'Ohne Abschnitt';

/** Kräfte des Einsatzes nach Abschnitten als Baum; entlassene nie, geplante und Untereinheiten nach Einstellung */
function ForcesTile({ tile }: { tile: DisplayTile }) {
  const { data: incident } = useQuery({ queryKey: ['incident', 'active', 'display'], queryFn: () => api.activeIncident().catch(() => null) });
  const { data: units } = useMapUnits(incident?.id);
  if (!incident) return <TileEmpty text="Kein Einsatz aufgelegt" />;
  if (!units) return <TileEmpty text="Lade Kräfte …" />;
  const subunits = tile.config.subunits !== false;
  const planned = tile.config.planned === true;
  const shown = units.filter((u) => u.status !== 'entlassen' && (planned || u.status !== 'geplant'));
  if (!shown.length) return <TileEmpty text="Keine Kräfte im Einsatz" />;

  const children = unitChildren(shown);
  const groups = new Map<string, Unit[]>();
  for (const u of children.get(null) ?? []) groups.set(u.section || NO_SECTION, [...(groups.get(u.section || NO_SECTION) ?? []), u]);
  const sections = [...groups.entries()].sort(([a], [b]) => (a === NO_SECTION ? 1 : b === NO_SECTION ? -1 : a.localeCompare(b)));
  const subtree = (u: Unit) => [u, ...unitDescendants(shown, u.id)];
  const onScene = shown.filter((u) => isOnScene(u.status));
  const approaching = shown.filter((u) => u.status === 'alarmiert' || u.status === 'anmarsch');

  const row = (u: Unit, depth: number): JSX.Element[] => {
    const kids = children.get(u.id) ?? [];
    return [
      <li key={u.id} style={{ paddingLeft: `${0.4 + depth * 1.2}em` }}>
        <span className={`tile-unit-sign ${depth ? 'sub' : ''}`}>
          <TacticalSignImage sign={u.sign} />
        </span>
        <span className="tile-unit-main">
          <span className="tile-unit-name">{u.name}</span>
          {u.role && <span className="tile-unit-meta">{u.role}</span>}
        </span>
        <span className="tile-unit-strength">{formatStrength(kids.length ? sumStrength(subtree(u)) : u.strength)}</span>
        <span className={`unit-status unit-status-${u.status}`}>{UNIT_STATUS[u.status]}</span>
      </li>,
      ...(subunits ? kids.flatMap((k) => row(k, depth + 1)) : []),
    ];
  };

  return (
    <div className="tile-forces">
      <div className="tile-tasks-head">
        Vor Ort <span className="mono">{formatStrength(sumStrength(onScene))}</span>
        {approaching.length > 0 && (
          <>
            {' · '}Anmarsch <span className="mono">{formatStrength(sumStrength(approaching))}</span>
          </>
        )}
      </div>
      <div className="tile-forces-list">
        {sections.map(([section, roots]) => (
          <section key={section}>
            <h3>
              {section} <span className="mono">{formatStrength(sumStrength(roots.flatMap(subtree)))}</span>
            </h3>
            <ul>{roots.flatMap((u) => row(u, 0))}</ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function TileEmpty({ text }: { text: string }) {
  return <div className="tile-empty">{text}</div>;
}

/** Inhalt einer Kachel */
export function TileView({ tile }: { tile: DisplayTile }) {
  switch (tile.type) {
    case 'clock':
      return <ClockTile />;
    case 'weather':
      return <WeatherTile />;
    case 'alerts':
      return <AlertsTile />;
    case 'network':
      return <NetworkTile />;
    case 'camera':
      return <CameraTile tile={tile} />;
    case 'video':
      return <VideoTile tile={tile} />;
    case 'map':
      return <MapTile tile={tile} />;
    case 'text':
      return <TextTile tile={tile} />;
    case 'guestWifi':
      return <GuestWifiTile tile={tile} />;
    case 'tasks':
      return <TasksTile tile={tile} />;
    case 'forces':
      return <ForcesTile tile={tile} />;
    default:
      return <TileEmpty text={`Unbekannte Kachel ${DISPLAY_TILE_TYPES[tile.type as DisplayTileType]?.label ?? tile.type}`} />;
  }
}
