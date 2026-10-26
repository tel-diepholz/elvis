import { useEffect, useState } from 'react';
import { Pane, TileLayer } from 'react-leaflet';
import { useQuery } from '@tanstack/react-query';
import { CloudRain, Info, Pause, Play } from 'lucide-react';
import type { RadarFrames } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtTime } from '../../lib/format';

/** Abdeckung des DWD-Radarverbunds (Deutschland mit Randgebieten); außerhalb keine Abrufe */
const RADAR_BOUNDS: [[number, number], [number, number]] = [
  [45.5, 1.5],
  [56.5, 19],
];
/** Das 1-km-Raster reicht für Zoomstufe 8; darüber vergrößert Leaflet die Kacheln */
const NATIVE_ZOOM = 8;
const OPACITY = 0.65;
const STEP_MS = 500;
/** Am Ende der Vorhersage kurz stehen bleiben, dann von vorn */
const END_PAUSE_MS = 1500;

export interface RadarState {
  data: RadarFrames | undefined;
  error: Error | null;
  frames: string[];
  index: number;
  /** Index der letzten Messung; danach Vorhersage */
  reference: number;
  playing: boolean;
  /** Alle Zeitschritte laden, sobald jemand abspielt oder den Regler bewegt */
  preload: boolean;
  select: (i: number) => void;
  toggle: () => void;
  now: () => void;
}

/** Zeitschritte des Regenradars und Abspielen; ohne Auswahl folgt die Anzeige der letzten Messung */
export function useRadar(enabled: boolean): RadarState {
  const { data, error } = useQuery({ queryKey: ['radar'], queryFn: api.radarFrames, enabled, refetchInterval: 60_000, staleTime: 30_000, retry: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [preload, setPreload] = useState(false);
  const frames = data?.frames ?? [];
  const reference = data ? frames.indexOf(data.reference) : -1;
  const chosen = selected ? frames.indexOf(selected) : -1;
  const index = chosen >= 0 ? chosen : reference >= 0 ? reference : frames.length - 1;

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const last = index >= frames.length - 1;
    const t = setTimeout(() => setSelected(frames[last ? 0 : index + 1]!), last ? END_PAUSE_MS : STEP_MS);
    return () => clearTimeout(t);
  }, [playing, index, frames]);

  useEffect(() => {
    if (!enabled) setPlaying(false);
  }, [enabled]);

  return {
    data,
    error,
    frames,
    index,
    reference,
    playing,
    preload,
    select: (i) => (setPreload(true), setPlaying(false), setSelected(frames[i] ?? null)),
    toggle: () => (setPreload(true), setPlaying((p) => !p)),
    now: () => (setPlaying(false), setSelected(null)),
  };
}

/** Radarbilder als Kachelebenen; beim Abspielen liegen alle Zeitschritte unsichtbar bereit, damit nichts ruckelt */
export function RadarLayer({ radar }: { radar: RadarState }) {
  const { data, frames, index, preload } = radar;
  if (!data || !frames.length) return null;
  return (
    <Pane name="radar" style={{ zIndex: 250 }}>
      {frames.map((time, i) =>
        i === index || preload ? (
          <TileLayer
            key={time}
            url={api.radarTileUrl(time)}
            attribution={data.attribution}
            opacity={i === index ? OPACITY : 0}
            maxNativeZoom={NATIVE_ZOOM}
            bounds={RADAR_BOUNDS}
          />
        ) : null,
      )}
    </Pane>
  );
}

function relative(time: string, reference: string): string {
  const min = Math.round((Date.parse(time) - Date.parse(reference)) / 60_000);
  if (min === 0) return 'letzte Messung';
  return min > 0 ? `Vorhersage +${min} min` : `vor ${-min} min`;
}

/** Bedienleiste unten: Abspielen, Zeitregler, Rücksprung zur letzten Messung und Legende */
export function RadarControl({ radar }: { radar: RadarState }) {
  const [legend, setLegend] = useState(false);
  const { data, error, frames, index, reference, playing } = radar;
  if (!data || !frames.length) {
    return (
      <div className="map-overlay map-radar" role="status">
        <CloudRain size={16} />
        <span className="muted">{error ? `Regenradar nicht verfügbar – ${error.message}` : 'Regenradar wird geladen …'}</span>
      </div>
    );
  }
  const time = frames[index]!;
  const forecast = index > reference;
  return (
    <div className="map-overlay map-radar" role="group" aria-label="Regenradar">
      <button type="button" className="btn btn-sm btn-icon" onClick={radar.toggle} aria-label={playing ? 'Anhalten' : 'Abspielen'} title={playing ? 'Anhalten' : 'Abspielen'}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <input
        type="range"
        className="map-radar-slider"
        min={0}
        max={frames.length - 1}
        value={index}
        list="radar-reference"
        aria-label="Zeitpunkt"
        aria-valuetext={`${fmtTime(time)}, ${relative(time, data.reference)}`}
        onChange={(e) => radar.select(Number(e.target.value))}
      />
      <datalist id="radar-reference">
        <option value={reference} />
      </datalist>
      <span className={`map-radar-time ${forecast ? 'forecast' : ''}`}>
        <strong>{fmtTime(time)}</strong> <span>{relative(time, data.reference)}</span>
      </span>
      <button type="button" className="btn btn-sm" onClick={radar.now} disabled={index === reference && !playing}>
        Jetzt
      </button>
      <button type="button" className="btn btn-sm btn-icon btn-ghost" onClick={() => setLegend((l) => !l)} aria-expanded={legend} aria-label="Legende" title="Legende (mm/h)">
        <Info size={16} />
      </button>
      {legend && (
        <div className="map-radar-legend">
          <img src={api.radarLegendUrl} alt="Legende Niederschlag in mm/h" />
        </div>
      )}
    </div>
  );
}
