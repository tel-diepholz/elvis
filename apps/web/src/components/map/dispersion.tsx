import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  KLUG_MANIER,
  MIN_WIND_MS,
  TERRAIN_LABELS,
  estimateStability,
  plumeContour,
  plumeToLatLon,
  sunElevationDeg,
  type GaussSettings,
  type KlugManierClass,
  type PlumeContour,
  type Terrain,
} from '@elvis/shared';
import { fmtNum } from '../../lib/format';
import { Field } from '../ui';

export type Wind = { windSpeedMs: number; windDirectionDeg: number };

/** c/Q-Stufen in s/m³ – von außen (gering) nach innen (hoch) gezeichnet. */
export const LEVELS = [
  { threshold: 1e-5, label: 'gering', className: 'plume-low', path: { color: '#fbc02d', fillColor: '#fdd835', fillOpacity: 0.22, weight: 2, dashArray: '6 4' } },
  { threshold: 1e-4, label: 'mittel', className: 'plume-mid', path: { color: '#f57c00', fillColor: '#f57c00', fillOpacity: 0.25, weight: 2 } },
  { threshold: 1e-3, label: 'hoch', className: 'plume-high', path: { color: '#e53935', fillColor: '#e53935', fillOpacity: 0.35, weight: 2 } },
] as const;

const KM_CLASSES = Object.keys(KLUG_MANIER) as KlugManierClass[];

/** Destination point from start, bearing and distance (spherical earth). */
export function destination(lat: number, lon: number, bearingDeg: number, meters: number): [number, number] {
  const R = 6371e3;
  const δ = meters / R;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [(φ2 * 180) / Math.PI, (λ2 * 180) / Math.PI];
}

/** Schematischer Sektor (±30°) in Windrichtung, wie in der Feuerwehr-Praxis üblich. */
export function dispersionSector(lat: number, lon: number, windFromDeg: number, meters: number): [number, number][] {
  const towards = (windFromDeg + 180) % 360;
  const points: [number, number][] = [[lat, lon]];
  for (let a = -30; a <= 30; a += 5) points.push(destination(lat, lon, towards + a, meters));
  return points;
}


export const fmtExp = (v: number) => `1·10${String(Math.round(Math.log10(v))).replace('-', '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]!)}`;

export const fmtDistance = (m: number) => (m >= 1000 ? `${fmtNum(m / 1000)} km` : `${Math.round(m / 10) * 10} m`);

export interface PlumeResult {
  stability: KlugManierClass;
  autoStability: boolean;
  sunDeg: number;
  calm: boolean;
  contours: { level: (typeof LEVELS)[number]; contour: PlumeContour; polygon: [number, number][] }[];
}

/** Gauß-Fahne am Ursprung für den aktuellen Wind; null ohne Winddaten */
export function computePlume(settings: GaussSettings, origin: { lat: number; lon: number }, weather: Wind | undefined, at: Date): PlumeResult | null {
  if (!weather) return null;
  const sunDeg = sunElevationDeg(at, origin.lat, origin.lon);
  const autoStability = settings.stability === 'auto';
  const stability = autoStability
    ? estimateStability({ windSpeedMs: weather.windSpeedMs, cloudOktas: settings.cloudOktas, sunElevationDeg: sunDeg })
    : (settings.stability as KlugManierClass);
  const params = {
    stability,
    terrain: settings.terrain,
    windSpeed10mMs: weather.windSpeedMs,
    sourceHeightM: settings.sourceHeightM,
  };
  const contours = LEVELS.flatMap((level) => {
    const contour = plumeContour(params, level.threshold);
    if (!contour) return [];
    const polygon = contour.outline.map((pt) => plumeToLatLon(origin, weather.windDirectionDeg, pt));
    return [{ level, contour, polygon }];
  });
  return { stability, autoStability, sunDeg, calm: weather.windSpeedMs < MIN_WIND_MS, contours };
}

export function usePlume(settings: GaussSettings, origin: { lat: number; lon: number }, weather: Wind | undefined, now: Date): PlumeResult | null {
  // Sonnenstand ändert sich langsam – minutengenau genügt und vermeidet Neuberechnung im Sekundentakt.
  const minute = Math.floor(now.getTime() / 60_000);
  return useMemo(
    () => computePlume(settings, origin, weather, new Date(minute * 60_000)),
    [settings, origin.lat, origin.lon, weather?.windSpeedMs, weather?.windDirectionDeg, minute], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** Warnhinweis, solange die Wetterstation keinen Wind liefert */
export function NoWindWarning() {
  return (
    <p className="dispersion-warning">
      <AlertTriangle size={16} /> Keine Winddaten von der Wetterstation – Ausbreitung kann nicht dargestellt werden.
    </p>
  );
}

/** Einstellungen einer Gauß-Fahne mit Legende und Hinweisen (in der Objektliste) */
export function GaussControls({
  settings,
  onChange,
  result,
  noWind,
  disabled,
}: {
  settings: GaussSettings;
  onChange: (s: Partial<GaussSettings>) => void;
  result: PlumeResult | null;
  /** Wetterstation liefert (noch) keine Windgeschwindigkeit/-richtung. */
  noWind?: boolean;
  disabled?: boolean;
}) {
  const set = <K extends keyof GaussSettings>(k: K, v: GaussSettings[K]) => onChange({ [k]: v });
  const rate = settings.releaseRateKgS;

  return (
    <div className="dispersion-panel">
      {noWind && <NoWindWarning />}
      <fieldset disabled={disabled} className="dispersion-fields">
        <>
          <div className="dispersion-grid">
            <Field label="Ausbreitungsklasse">
              <select value={settings.stability} onChange={(e) => set('stability', e.target.value as GaussSettings['stability'])}>
                <option value="auto">
                  Auto{result?.autoStability ? ` (${result.stability})` : ''}
                </option>
                {KM_CLASSES.map((k) => (
                  <option key={k} value={k}>
                    {k} – {KLUG_MANIER[k].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Bewölkung">
              <select value={settings.cloudOktas} onChange={(e) => set('cloudOktas', Number(e.target.value))} disabled={settings.stability !== 'auto'}>
                {Array.from({ length: 9 }, (_, i) => (
                  <option key={i} value={i}>
                    {i}/8{i === 0 ? ' klar' : i === 8 ? ' bedeckt' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Gelände">
              <select value={settings.terrain} onChange={(e) => set('terrain', e.target.value as Terrain)}>
                {(Object.keys(TERRAIN_LABELS) as Terrain[]).map((t) => (
                  <option key={t} value={t}>
                    {TERRAIN_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quellhöhe (m)">
              <input
                type="number"
                min={0}
                max={200}
                value={settings.sourceHeightM}
                onChange={(e) => set('sourceHeightM', Math.min(200, Math.max(0, Number(e.target.value) || 0)))}
              />
            </Field>
            <Field label="Freisetzung (kg/s)" hint="optional, für mg/m³">
              <input
                type="number"
                min={0}
                step="any"
                value={rate ?? ''}
                placeholder="–"
                onChange={(e) => set('releaseRateKgS', e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
              />
            </Field>
          </div>

          {result?.calm && (
            <p className="dispersion-warning">
              <AlertTriangle size={16} /> Windstille: Das Gaußmodell ist unter {MIN_WIND_MS} m/s nicht belastbar – Gefährdung rundum annehmen.
            </p>
          )}

          {result && (
            <ul className="plume-legend">
              {LEVELS.slice()
                .reverse()
                .map((level) => {
                  const hit = result.contours.find((c) => c.level === level);
                  return (
                    <li key={level.threshold}>
                      <span className={`swatch ${level.className}`} />
                      <span className="plume-legend-label">
                        <strong>{level.label}</strong> ≥ {rate ? `${fmtNum(level.threshold * rate * 1e6, 0)} mg/m³` : `${fmtExp(level.threshold)} s/m³`}
                      </span>
                      <span className="mono">
                        {hit ? `${hit.contour.truncated ? '> ' : ''}${fmtDistance(hit.contour.maxDistanceM)} · ${fmtDistance(2 * hit.contour.maxHalfWidthM)} breit` : 'nicht erreicht'}
                      </span>
                    </li>
                  );
                })}
            </ul>
          )}

          {result && (
            <p className="dispersion-note">
              Klasse {result.stability} ({KLUG_MANIER[result.stability].label}){result.autoStability && `, Sonnenhöhe ${Math.round(result.sunDeg)}°`}.
              {!rate && ' c/Q-Werte: bei 1 kg/s entspricht 1·10⁻⁴ s/m³ = 100 mg/m³.'} Stationäre Gauß-Fahne (Ansatz VDI 3783 Bl. 1, Parameter nach Briggs),
              ebenes Gelände, kein Schwergas/Auftrieb. <strong>Nur Orientierung – keine Grundlage für Grenzwertentscheidungen; Messungen haben Vorrang.</strong>
            </p>
          )}
        </>
      </fieldset>
    </div>
  );
}
