import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useQuery } from '@tanstack/react-query';
import { Bell, Cctv, Clock, CloudSun, Map as MapIcon, Network, Type, Video } from 'lucide-react';
import { DEFAULT_VEHICLE_SIGN, DISPLAY_TILE_TYPES, formatDtg, type DisplayTile, type DisplayTileType } from '@elvis/shared';
import { api } from '../../lib/api';
import { compass, fmtOpt } from '../../lib/format';
import { useNow, useSettings } from '../../lib/hooks';
import { autoSource } from '../../lib/mapSources';
import { useAlerts, useDevice } from '../../lib/live';
import { AlertList } from '../AlertPanel';
import { CameraImage } from '../camera/CameraImage';
import { tacticalIcon } from '../tactical/TacticalSign';
import { WindCompass } from '../WindCompass';
import { WebRtcPlayer } from './WebRtcPlayer';

export const TILE_ICONS: Record<DisplayTileType, typeof MapIcon> = { map: MapIcon, camera: Cctv, video: Video, weather: CloudSun, clock: Clock, alerts: Bell, network: Network, text: Type };

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
  const source = sources.find((s) => s.id === tile.config.sourceId) ?? autoSource(sources, true);
  const gps = weather?.state.position;
  const vPos: [number, number] | null = gps ? [gps.lat, gps.lon] : null;
  const iPos: [number, number] | null = incident?.lat != null && incident.lon != null ? [incident.lat, incident.lon] : null;
  const zoom = Number(tile.config.zoom) || 15;
  const center = (tile.config.center === 'incident' ? iPos ?? vPos : vPos ?? iPos) ?? [51.1657, 10.4515];
  return (
    <MapContainer center={center} zoom={vPos || iPos ? zoom : 6} className="tile-map" zoomControl={false} attributionControl={false}>
      {source && <TileLayer key={source.id} url={api.tileUrl(source.id)} maxZoom={source.maxZoom} />}
      {vPos && <Marker position={vPos} icon={icon} />}
      {iPos && <Marker position={iPos} icon={incidentIcon} />}
      <Follow pos={tile.config.center === 'incident' ? iPos : vPos} enabled={tile.config.follow !== false} />
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
    default:
      return <TileEmpty text={`Unbekannte Kachel ${DISPLAY_TILE_TYPES[tile.type as DisplayTileType]?.label ?? tile.type}`} />;
  }
}
