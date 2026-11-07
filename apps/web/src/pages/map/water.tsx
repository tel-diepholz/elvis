import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CircleMarker, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Droplets, FileDown, Loader2, Plus, Printer, RotateCcw, Trash2, X } from 'lucide-react';
import {
  DEFAULT_HYDRAULICS,
  belowBar,
  HOSE_TYPES,
  WATER_SUPPLY_DEFAULT_COUNT,
  WATER_SUPPLY_MAX_COUNT,
  computeSupply,
  flatProfile,
  formatDistance,
  hoseCount,
  pointAt,
  pressureLossPer100m,
  projectOnProfile,
  suggestPumps,
  type HoseType,
  type HydraulicsInput,
  type MapSource,
  type ProfilePoint,
  type SupplyResult,
  type WaterSupplyCandidate,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { Field, Segmented } from '../../components/ui';
import { useToast } from '../../lib/toast';
import { PrinterSettings, downloadBlob, mediaFor, usePrintForm, usePrintStatus } from '../../components/print/PrinterSettings';
import { thinPath } from './routing';

/** Farbe des gewählten Schlauchwegs; die übrigen Wege blass */
export const WATER_COLOR = '#0277bd';
const OTHER_COLOR = '#5c8fc4';

const num = (v: number, digits = 1) => v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const bar = (p: number) => `${num(p)} bar`;
const km = (d: number) => `km ${num(d / 1000, 2)}`;
const EMPTY: number[] = [];

/** Kurzangaben einer Entnahmestelle aus der Objektbibliothek: „Hydrant Unterflur · DN 100 · 1600 l/min“ */
function waterInfo(c: WaterSupplyCandidate): string {
  const p = c.object.props;
  return [p.art, p.dn !== undefined && `DN ${p.dn}`, p.leistung !== undefined && `${p.leistung} l/min`, p.volumen !== undefined && `${p.volumen} m³`].filter(Boolean).join(' · ');
}

/**
 * Zustand der Wasserversorgung (Menü „Objekte“): nächste Entnahmestellen zum Einsatzort, gewählter Schlauchweg mit
 * Höhenschnitt, Hydraulik und Verstärkerpumpen. Panel und Kartenebene teilen sich diesen Zustand.
 */
export function useWaterSupply(origin: { lat: number; lon: number } | null, open: boolean) {
  const [count, setCount] = useState(WATER_SUPPLY_DEFAULT_COUNT);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hydraulics, setHydraulics] = useState<HydraulicsInput>(DEFAULT_HYDRAULICS);
  /** Von Hand gesetzte Pumpen (Strecke ab Entnahmestelle); null = Vorschlag */
  const [manualPumps, setManualPumps] = useState<number[] | null>(null);
  /** Hervorgehobene Stelle (Höhenschnitt ↔ Karte) */
  const [hover, setHover] = useState<number | null>(null);

  const query = useQuery({
    queryKey: ['waterSupply', origin?.lat, origin?.lon, count],
    queryFn: () => api.waterSupply({ lat: origin!.lat, lon: origin!.lon, count }),
    enabled: open && !!origin,
    staleTime: 300_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const candidates = query.data?.candidates ?? [];
  const chosen = candidates.find((c) => c.object.id === selectedId && c.route) ?? candidates.find((c) => c.route) ?? null;
  const path = chosen?.route?.path;
  const elevation = useQuery({
    queryKey: ['elevation', chosen?.object.id, origin?.lat, origin?.lon, chosen?.route?.distanceM],
    queryFn: () => api.elevation(path!),
    enabled: open && !!path,
    staleTime: Infinity,
    retry: false,
  });
  // Ohne Höhendaten (offline) rechnet die Hydraulik nur mit der Reibung
  const flat = elevation.isError;
  const profile = useMemo<ProfilePoint[] | null>(() => elevation.data?.points ?? (flat && path ? flatProfile(path) : null), [elevation.data, flat, path]);

  useEffect(() => setManualPumps(null), [chosen?.object.id, origin?.lat, origin?.lon]);

  const suggestion = useMemo(() => (profile ? suggestPumps(profile, hydraulics) : null), [profile, hydraulics]);
  const pumpDs = manualPumps ?? suggestion?.pumpDs ?? EMPTY;
  const result = useMemo<SupplyResult | null>(() => (profile ? computeSupply(profile, pumpDs, hydraulics) : null), [profile, pumpDs, hydraulics]);
  const lengthM = profile?.[profile.length - 1]?.d ?? 0;

  /** Pumpe i (ohne die an der Entnahmestelle) verschieben; bleibt zwischen ihren Nachbarn */
  const movePump = (i: number, d: number) => {
    const list = [...pumpDs];
    const lo = (i > 0 ? list[i - 1]! : 0) + 1;
    const hi = (i < list.length - 1 ? list[i + 1]! : lengthM) - 1;
    list[i] = Math.round(Math.max(lo, Math.min(hi, d)));
    setManualPumps(list);
  };
  /** Neue Pumpe in die Mitte des längsten Abschnitts */
  const addPump = () => {
    const stops = [0, ...pumpDs, lengthM];
    let best = 0;
    for (let i = 1; i < stops.length - 1; i++) if (stops[i + 1]! - stops[i]! > stops[best + 1]! - stops[best]!) best = i;
    const d = Math.round((stops[best]! + stops[best + 1]!) / 2);
    setManualPumps([...pumpDs, d].sort((a, b) => a - b));
  };
  const removePump = (i: number) => setManualPumps(pumpDs.filter((_, j) => j !== i));
  /** Schlauchgröße wechseln: übliche Fördermenge dazu */
  const setHose = (hose: HoseType) => setHydraulics((h) => ({ ...h, hose, flowLpm: HOSE_TYPES[hose].defaultFlowLpm }));

  return {
    origin,
    count,
    setCount,
    query,
    candidates,
    chosen,
    select: setSelectedId,
    elevation,
    flat,
    profile,
    hydraulics,
    setHydraulics,
    setHose,
    suggestion,
    pumpDs,
    result,
    manual: manualPumps !== null,
    movePump,
    addPump,
    removePump,
    resetPumps: () => setManualPumps(null),
    hover,
    setHover,
  };
}
export type WaterSupplyState = ReturnType<typeof useWaterSupply>;

const toLatLng = (path: [number, number][]) => path.map(([lon, lat]) => [lat, lon] as [number, number]);

const sourceIcon = (rank: number, chosen: boolean) =>
  L.divIcon({ className: `map-marker water-source ${chosen ? 'chosen' : ''}`, html: `<span>${rank}</span>`, iconSize: chosen ? [28, 28] : [22, 22], iconAnchor: chosen ? [14, 14] : [11, 11] });
const pumpIcon = (n: number, bad: boolean) => L.divIcon({ className: `map-marker water-pump ${bad ? 'bad' : ''}`, html: `<span>P${n}</span>`, iconSize: [30, 22], iconAnchor: [15, 11] });

/** Schlauchwege, Entnahmestellen und Verstärkerpumpen auf der Karte; Pumpen lassen sich entlang des Wegs ziehen */
export function WaterLayer({ ws }: { ws: WaterSupplyState }) {
  const map = useMap();
  const { candidates, chosen, result, profile, hydraulics } = ws;
  /** Gezogene Pumpe: Marker folgt dem Zeiger, der Druck rechnet mit dem Fußpunkt auf dem Weg */
  const [drag, setDrag] = useState<{ i: number; pos: [number, number] } | null>(null);

  // Neue Ergebnisse ganz zeigen (Einsatzort und alle Wege)
  useEffect(() => {
    const pts: [number, number][] = [];
    if (ws.origin) pts.push([ws.origin.lat, ws.origin.lon]);
    for (const c of ws.query.data?.candidates ?? []) {
      pts.push([c.object.lat, c.object.lon]);
      if (c.route) pts.push(...toLatLng(c.route.path));
    }
    if (pts.length > 1) map.flyToBounds(L.latLngBounds(pts), { padding: [64, 64], maxZoom: 17 });
  }, [ws.query.data, map]); // eslint-disable-line react-hooks/exhaustive-deps

  const hoverPoint = ws.hover !== null && profile ? pointAt(profile, ws.hover) : null;

  return (
    <>
      {candidates.map((c) =>
        c.route && c !== chosen ? (
          <Polyline
            key={`w${c.object.id}`}
            positions={toLatLng(c.route.path)}
            pathOptions={{ color: OTHER_COLOR, weight: 4, opacity: 0.55, dashArray: '6 7', lineCap: 'round' }}
            eventHandlers={{ click: () => ws.select(c.object.id) }}
          >
            <Tooltip sticky>
              {c.object.name} · {formatDistance(c.route.distanceM)}
            </Tooltip>
          </Polyline>
        ) : null,
      )}
      {chosen?.route && (
        <>
          <Polyline positions={toLatLng(chosen.route.path)} interactive={false} pathOptions={{ color: '#ffffff', weight: 10, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }} />
          <Polyline positions={toLatLng(chosen.route.path)} interactive={false} pathOptions={{ color: WATER_COLOR, weight: 6, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }} />
        </>
      )}
      {candidates.map((c, i) => (
        <Marker key={`s${c.object.id}`} position={[c.object.lat, c.object.lon]} icon={sourceIcon(i + 1, c === chosen)} zIndexOffset={c === chosen ? 600 : 400} eventHandlers={{ click: () => ws.select(c.object.id) }}>
          <Tooltip direction="top" offset={[0, -12]}>
            <strong>{c.object.name}</strong>
            <br />
            {waterInfo(c)}
            <br />
            {c.route ? `${formatDistance(c.route.distanceM)} Schlauchweg` : (c.error ?? 'kein Weg')} · {formatDistance(c.airDistanceM)} Luftlinie
          </Tooltip>
        </Marker>
      ))}
      {profile &&
        result?.pumps.slice(1).map((p, i) => {
          const bad = p.inBar !== null && belowBar(p.inBar, hydraulics.minInBar);
          return (
            <Marker
              key={`p${i}`}
              position={drag?.i === i ? drag.pos : [p.lat, p.lon]}
              icon={pumpIcon(i + 2, bad)}
              draggable
              zIndexOffset={800}
              eventHandlers={{
                drag: (e) => {
                  const ll = (e.target as L.Marker).getLatLng();
                  setDrag({ i, pos: [ll.lat, ll.lng] });
                  const d = projectOnProfile(profile, ll.lat, ll.lng);
                  ws.movePump(i, d);
                  ws.setHover(d);
                },
                dragend: () => (setDrag(null), ws.setHover(null)),
              }}
            >
              <Tooltip direction="top" offset={[0, -12]}>
                <strong>Pumpe {i + 2}</strong> · {km(p.d)} · {Math.round(p.h)} m ü. NN
                <br />
                Eingang {bar(p.inBar ?? 0)} → Ausgang {bar(p.outBar)}
                <br />
                <span className="muted">Entlang des Wegs ziehen</span>
              </Tooltip>
            </Marker>
          );
        })}
      {hoverPoint && <CircleMarker center={[hoverPoint.lat, hoverPoint.lon]} radius={7} interactive={false} pathOptions={{ color: '#ffffff', weight: 3, fillColor: WATER_COLOR, fillOpacity: 1 }} />}
    </>
  );
}

/**
 * Höhenschnitt mit Druckverlauf: Gelände als Fläche (Höhe links), Druck als Linie mit Sprüngen an den Pumpen (rechts),
 * Mindesteingangsdruck gestrichelt. Zeigen hebt die Stelle auch auf der Karte hervor.
 */
export function ElevationChart({
  profile,
  result,
  hydraulics,
  hover,
  onHover,
  width = 360,
  height = 180,
}: {
  profile: ProfilePoint[];
  result: SupplyResult;
  hydraulics: HydraulicsInput;
  hover?: number | null;
  onHover?: (d: number | null) => void;
  width?: number;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const m = { l: 40, r: 40, t: 14, b: 24 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const total = Math.max(1, result.lengthM);
  const hs = profile.map((p) => p.h);
  let hMin = Math.min(...hs);
  let hMax = Math.max(...hs);
  if (hMax - hMin < 10) {
    const mid = (hMax + hMin) / 2;
    hMin = mid - 5;
    hMax = mid + 5;
  }
  const hPad = (hMax - hMin) * 0.1;
  hMin = Math.floor(hMin - hPad);
  hMax = Math.ceil(hMax + hPad);
  const ps = result.points.map((p) => p.p);
  const pMin = Math.min(0, ...ps);
  const pMax = Math.max(hydraulics.pumpOutBar, ...ps) * 1.05;
  const x = (d: number) => m.l + (d / total) * w;
  const yh = (v: number) => m.t + h - ((v - hMin) / (hMax - hMin)) * h;
  const yp = (v: number) => m.t + h - ((v - pMin) / (pMax - pMin)) * h;

  const terrain = `M${x(0)},${m.t + h} ${profile.map((p) => `L${x(p.d).toFixed(1)},${yh(p.h).toFixed(1)}`).join(' ')} L${x(total)},${m.t + h} Z`;
  const pressure = result.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${yp(p.p).toFixed(1)}`).join(' ');
  const hoverPt = hover != null ? pointAt(profile, hover) : null;
  const hoverP = hover != null ? pressureAtD(result, hover) : null;

  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!onHover || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    onHover(Math.max(0, Math.min(total, ((px - m.l) / w) * total)));
  };

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * total);
  return (
    <svg
      ref={svgRef}
      className="water-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Höhenschnitt: ${formatDistance(total)}, Höhe ${Math.round(Math.min(...hs))}–${Math.round(Math.max(...hs))} m, Druck am Einsatzort ${bar(result.endBar)}`}
      onPointerMove={move}
      onPointerLeave={() => onHover?.(null)}
    >
      <path className="water-chart-terrain" d={terrain} />
      {pMin < 0 && <line className="water-chart-zero" x1={m.l} x2={m.l + w} y1={yp(0)} y2={yp(0)} />}
      <line className="water-chart-min" x1={m.l} x2={m.l + w} y1={yp(hydraulics.minInBar)} y2={yp(hydraulics.minInBar)} />
      {result.pumps.map((p, i) => (
        <g key={i}>
          <line className="water-chart-pump" x1={x(p.d)} x2={x(p.d)} y1={m.t} y2={m.t + h} />
          <text className="water-chart-pump-label" x={x(p.d) + 2} y={m.t + 9}>
            P{i + 1}
          </text>
        </g>
      ))}
      <path className="water-chart-pressure" d={pressure} />
      <line className="water-chart-axis" x1={m.l} x2={m.l + w} y1={m.t + h} y2={m.t + h} />
      {xTicks.map((d, i) => (
        <text key={i} className="water-chart-tick" x={x(d)} y={height - 8} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
          {num(d / 1000, 2)}
        </text>
      ))}
      <text className="water-chart-tick" x={m.l - 4} y={m.t + 4} textAnchor="end">
        {hMax} m
      </text>
      <text className="water-chart-tick" x={m.l - 4} y={m.t + h} textAnchor="end">
        {hMin} m
      </text>
      <text className="water-chart-tick pressure" x={m.l + w + 4} y={yp(hydraulics.pumpOutBar) + 4}>
        {num(hydraulics.pumpOutBar, 0)} bar
      </text>
      <text className="water-chart-tick min" x={m.l + w + 4} y={yp(hydraulics.minInBar) + 4}>
        {num(hydraulics.minInBar)}
      </text>
      <text className="water-chart-tick" x={width - 2} y={height - 8} textAnchor="end" dy={-12}>
        km
      </text>
      {hoverPt && hoverP !== null && (
        <g className="water-chart-hover">
          <line x1={x(hoverPt.d)} x2={x(hoverPt.d)} y1={m.t} y2={m.t + h} />
          <circle cx={x(hoverPt.d)} cy={yp(hoverP)} r={3.5} />
          <text x={Math.min(x(hoverPt.d) + 5, m.l + w - 120)} y={m.t + h - 6}>
            {km(hoverPt.d)} · {Math.round(hoverPt.h)} m · {bar(hoverP)}
          </text>
        </g>
      )}
    </svg>
  );
}

/** Druck an der Stelle d (hinter einer Pumpe an genau dieser Stelle zählt der Ausgangsdruck) */
function pressureAtD(r: SupplyResult, d: number): number | null {
  const pts = r.points;
  if (!pts.length) return null;
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (a.d <= d && d <= b.d) return b.d > a.d ? a.p + ((b.p - a.p) * (d - a.d)) / (b.d - a.d) : b.p;
  }
  return pts[0]!.p;
}

function NumberField({ label, unit, value, min, max, step, onChange }: { label: string; unit: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="water-num">
      <span className="field-label">{label}</span>
      <span className="water-num-input">
        <input type="number" inputMode="decimal" value={value} min={min} max={max} step={step} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(Math.max(min, Math.min(max, e.target.valueAsNumber)))} />
        <span className="muted">{unit}</span>
      </span>
    </label>
  );
}

/** Kennzahlen der gewählten Förderstrecke (Panel und Ausdruck) */
function SupplyFacts({ ws }: { ws: WaterSupplyState }) {
  const { result, hydraulics, chosen } = ws;
  if (!result || !chosen) return null;
  const leistung = Number(chosen.object.props.leistung);
  return (
    <dl className="water-facts">
      <dt>Schlauchweg</dt>
      <dd>
        <strong>{formatDistance(result.lengthM)}</strong> · {hoseCount(result.lengthM, hydraulics.hose)} × {HOSE_TYPES[hydraulics.hose].lengthM} m {hydraulics.hose} <span className="muted">(+10 %)</span>
      </dd>
      <dt>Höhe</dt>
      <dd>
        {ws.flat ? (
          <span className="muted">ohne Höhendaten</span>
        ) : (
          <>
            {result.climbM >= 0 ? '+' : '−'}
            {Math.abs(Math.round(result.climbM))} m bis Einsatzort · höchster Punkt +{Math.round(result.maxRiseM)} m
          </>
        )}
      </dd>
      <dt>Reibung</dt>
      <dd>
        {bar(pressureLossPer100m(hydraulics.hose, hydraulics.flowLpm))} je 100 m bei {hydraulics.flowLpm} l/min
      </dd>
      <dt>Pumpen</dt>
      <dd>
        {result.pumps.length} ({result.pumps.length - 1} Verstärker) · am Einsatzort <strong>{bar(result.endBar)}</strong>
      </dd>
      {Number.isFinite(leistung) && leistung > 0 && leistung < hydraulics.flowLpm && (
        <dd className="water-facts-warn tone-warn">
          Entnahmestelle liefert laut Bibliothek nur {leistung} l/min
        </dd>
      )}
    </dl>
  );
}

function PumpTable({ ws, editable }: { ws: WaterSupplyState; editable: boolean }) {
  const { result } = ws;
  if (!result) return null;
  return (
    <table className="water-pumps">
      <thead>
        <tr>
          <th>Pumpe</th>
          <th>Strecke</th>
          <th>Höhe</th>
          <th>Eingang</th>
          <th>Ausgang</th>
          {editable && <th aria-label="Aktionen" />}
        </tr>
      </thead>
      <tbody>
        {result.pumps.map((p, i) => {
          const bad = p.inBar !== null && belowBar(p.inBar, ws.hydraulics.minInBar);
          return (
            <tr key={i} onPointerEnter={() => ws.setHover(p.d)} onPointerLeave={() => ws.setHover(null)}>
              <td>P{i + 1}</td>
              <td>{i === 0 ? 'Entnahme' : km(p.d)}</td>
              <td>{ws.flat ? '–' : `${Math.round(p.h)} m`}</td>
              <td className={bad ? 'tone-warn' : undefined}>{p.inBar === null ? '–' : bar(p.inBar)}</td>
              <td>{bar(p.outBar)}</td>
              {editable && (
                <td>
                  {i > 0 && (
                    <button type="button" className="icon-btn" onClick={() => ws.removePump(i - 1)} aria-label={`Pumpe ${i + 1} entfernen`} title="Entfernen">
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              )}
            </tr>
          );
        })}
        <tr className="water-pumps-end">
          <td colSpan={2}>Einsatzort</td>
          <td>{ws.flat || !ws.profile ? '–' : `${Math.round(ws.profile[ws.profile.length - 1]!.h)} m`}</td>
          <td className={belowBar(result.endBar, ws.hydraulics.endBar) ? 'tone-warn' : undefined}>{bar(result.endBar)}</td>
          <td />
          {editable && <td />}
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Box „Wasserversorgung“ unter der Werkzeugleiste: Anzahl der Entnahmestellen (Slider), Rangliste nach Schlauchweg,
 * Hydraulik, Höhenschnitt mit Druckverlauf und Verstärkerpumpen; Drucken über den Druckdialog von ELVIS.
 */
export function WaterPanel({ ws, top, onPrint, onClose }: { ws: WaterSupplyState; top: number; onPrint: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState(ws.count);
  // Slider erst nach kurzer Pause abfragen (jede Anzahl ist eine eigene Abfrage)
  useEffect(() => {
    if (draft === ws.count) return;
    const t = setTimeout(() => ws.setCount(draft), 350);
    return () => clearTimeout(t);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const { query, candidates, chosen, result, profile, hydraulics } = ws;
  const setH = (patch: Partial<HydraulicsInput>) => ws.setHydraulics((h) => ({ ...h, ...patch }));
  const warnings = [...(ws.manual ? [] : (ws.suggestion?.warnings ?? [])), ...(result?.warnings ?? [])];

  return (
    <div className="map-overlay map-route map-water" style={{ top }} role="dialog" aria-label="Wasserversorgung">
      <div className="map-route-head">
        <Droplets size={18} />
        <strong>Wasserversorgung</strong>
        {(query.isFetching || ws.elevation.isFetching) && <Loader2 size={16} className="spin" aria-label="lädt" />}
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Wasserversorgung schließen" title="Schließen">
          <X size={16} />
        </button>
      </div>

      {!ws.origin ? (
        <p className="muted map-route-hint">Erst den Einsatzort setzen.</p>
      ) : (
        <>
          <label className="water-count">
            <span>
              Nächste <strong>{draft}</strong> Entnahmestellen
            </span>
            <input type="range" min={1} max={WATER_SUPPLY_MAX_COUNT} value={draft} onChange={(e) => setDraft(Number(e.target.value))} aria-label="Anzahl der Entnahmestellen" />
          </label>

          {query.error ? (
            <p className="tone-warn map-route-hint">{(query.error as Error).message}</p>
          ) : query.data && !candidates.length ? (
            <p className="muted map-route-hint">Keine Wasserentnahmestellen im Umkreis von 10 km in der Objektbibliothek.</p>
          ) : (
            <ol className={`water-list ${query.isPlaceholderData ? 'stale' : ''}`}>
              {candidates.map((c, i) => (
                <li key={c.object.id}>
                  <button type="button" className={c === chosen ? 'active' : ''} disabled={!c.route} onClick={() => ws.select(c.object.id)} aria-pressed={c === chosen}>
                    <span className="water-rank">{i + 1}</span>
                    <span className="water-name">
                      {c.object.name}
                      <span className="muted">{waterInfo(c) || 'Wasserentnahmestelle'}</span>
                    </span>
                    <span className="water-dist">
                      {c.route ? <strong>{formatDistance(c.route.distanceM)}</strong> : <span className="tone-warn">kein Weg</span>}
                      <span className="muted">{formatDistance(c.airDistanceM)} Luftl.</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {chosen && (
            <>
              <Segmented<HoseType>
                label="Schlauch"
                value={hydraulics.hose}
                onChange={ws.setHose}
                options={(Object.keys(HOSE_TYPES) as HoseType[]).map((k) => ({ value: k, label: `${k}-Schlauch`, title: HOSE_TYPES[k].label }))}
              />
              <div className="water-params">
                <NumberField label="Fördermenge" unit="l/min" value={hydraulics.flowLpm} min={100} max={10_000} step={100} onChange={(v) => setH({ flowLpm: v })} />
                <NumberField label="Pumpe Ausgang" unit="bar" value={hydraulics.pumpOutBar} min={2} max={16} step={0.5} onChange={(v) => setH({ pumpOutBar: v })} />
                <NumberField label="Mind. Eingang" unit="bar" value={hydraulics.minInBar} min={0} max={8} step={0.5} onChange={(v) => setH({ minInBar: v })} />
                <NumberField label="Am Einsatzort" unit="bar" value={hydraulics.endBar} min={0} max={12} step={0.5} onChange={(v) => setH({ endBar: v })} />
              </div>

              {ws.elevation.isFetching && !profile && <p className="muted map-route-hint">Höhenschnitt wird geladen …</p>}
              {ws.flat && <p className="tone-warn map-route-hint">{(ws.elevation.error as Error)?.message} – gerechnet nur mit Reibung, ohne Höhen.</p>}

              {profile && result && (
                <>
                  <SupplyFacts ws={ws} />
                  <ElevationChart profile={profile} result={result} hydraulics={hydraulics} hover={ws.hover} onHover={ws.setHover} />
                  {warnings.length > 0 && (
                    <ul className="water-warnings tone-warn">
                      {warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                  <PumpTable ws={ws} editable />
                  <p className="muted map-route-hint">Pumpen P2 … auf der Karte entlang des Wegs verschieben.</p>
                  <div className="map-route-actions">
                    <button type="button" className="btn btn-sm" onClick={ws.addPump}>
                      <Plus size={14} /> Pumpe hinzufügen
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!ws.manual} onClick={ws.resetPumps} title="Verstärkerpumpen neu vorschlagen">
                      <RotateCcw size={14} /> Neu vorschlagen
                    </button>
                    <button type="button" className="btn btn-sm" onClick={onPrint}>
                      <Printer size={14} /> Drucken
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Ausdruck der Wasserversorgung (A4 quer, PDF vom Server): an einen Drucker der Druckserver-Addons schicken oder als
 * PDF herunterladen – wie Wetterbericht und Route.
 */
export function WaterPrintDialog({
  ws,
  sources,
  initialSourceId,
  incidentName,
  onDone,
}: {
  ws: WaterSupplyState;
  sources: MapSource[];
  initialSourceId: string;
  incidentName: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const { chosen, result, profile, hydraulics } = ws;
  const [title, setTitle] = useState(`Wasserversorgung ${incidentName}`.slice(0, 120));
  const [sourceId, setSourceId] = useState(initialSourceId);
  const { data: printStatus } = usePrintStatus();
  const hasPrinters = !!printStatus?.printers.length;
  const [target, setTarget] = useState<'pdf' | 'printer' | null>(null);
  const output = target ?? (hasPrinters ? 'printer' : 'pdf');
  const { form, setForm, printer, valid: printerValid } = usePrintForm(printStatus);

  const print = useMutation({
    mutationFn: async () => {
      if (!chosen?.route || !profile || !ws.origin) throw new Error('Keine Förderstrecke gewählt');
      const res = await api.printWaterSupply({
        title: title.trim() || 'Wasserversorgung',
        sourceId,
        incident: { lat: ws.origin.lat, lon: ws.origin.lon, name: incidentName.slice(0, 200) },
        water: { name: chosen.object.name, info: waterInfo(chosen).slice(0, 300), address: chosen.object.address.slice(0, 200), lat: chosen.object.lat, lon: chosen.object.lon },
        routeSource: (ws.query.data?.source ?? 'Routing').slice(0, 120),
        path: thinPath(chosen.route.path),
        profile,
        elevationSource: ws.flat ? null : (ws.elevation.data?.source ?? null),
        hydraulics,
        pumpDs: [...ws.pumpDs],
      });
      if (output === 'pdf') return { ...res, job: null };
      const file = new File([res.pdf], res.filename, { type: 'application/pdf' });
      const job = await api.printPdf(file, { ...form, media: mediaFor(printer, 'A4'), orientation: 'auto', pageRanges: '', numberUp: 1 });
      return { ...res, job };
    },
    onSuccess: ({ pdf, filename, missingTiles, job }) => {
      if (!job) downloadBlob(pdf, filename);
      const what = job ? `Wasserversorgung an ${job.printerName} gesendet${job.archivedPath ? ` und unter „${job.archivedPath}“ abgelegt` : ''}` : 'Wasserversorgung als PDF erstellt';
      if (missingTiles) toast('error', `${what}, aber ${missingTiles} Kartenkachel(n) fehlen (offline?)`);
      else toast('success', what);
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });

  return (
    <div className="print-options">
      <Field label="Titel">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </Field>
      {sources.length > 1 && (
        <Field label="Kartenstil">
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="muted print-summary">
        A4 quer: Karte mit Schlauchweg und {result ? result.pumps.length : 0} Pumpen, danach Kennzahlen, Pumpentabelle und Höhenschnitt.
        {chosen && result && ` ${chosen.object.name} · ${formatDistance(result.lengthM)} · ${HOSE_TYPES[hydraulics.hose].label} · ${hydraulics.flowLpm} l/min.`}
      </p>
      {hasPrinters && (
        <Field label="Ausgabe">
          <Segmented
            label="Ausgabe"
            value={output}
            onChange={setTarget}
            options={[
              { value: 'printer', label: 'Drucker' },
              { value: 'pdf', label: 'PDF herunterladen' },
            ]}
          />
        </Field>
      )}
      {output === 'printer' && printStatus && <PrinterSettings status={printStatus} form={form} onChange={setForm} fixedLayout />}
      {output === 'printer' ? (
        <button className="btn btn-primary btn-lg" disabled={print.isPending || !printerValid} onClick={() => print.mutate()}>
          <Printer size={18} /> {print.isPending ? 'Wird gedruckt …' : 'Drucken (A4 quer)'}
        </button>
      ) : (
        <button className="btn btn-primary btn-lg" disabled={print.isPending} onClick={() => print.mutate()}>
          <FileDown size={18} /> {print.isPending ? 'PDF wird erstellt …' : 'PDF erzeugen (A4 quer)'}
        </button>
      )}
    </div>
  );
}
