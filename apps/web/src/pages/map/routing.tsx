import { useEffect, useMemo, useState } from 'react';
import { Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, FileDown, ListPlus, Loader2, Printer, Route as RouteIcon, X } from 'lucide-react';
import {
  MAX_ROUTE_STOPS,
  ROUTE_PROFILE_LABELS,
  formatDistance,
  formatDuration,
  routeSummary,
  type MapSource,
  type NewMapObject,
  type RouteProfile,
  type RouteResult,
  type RouteStop,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Field, Segmented } from '../../components/ui';
import { PrinterSettings, downloadBlob, mediaFor, usePrintForm, usePrintStatus } from '../../components/print/PrinterSettings';
import { MapSearch } from './search';

export const ROUTE_COLOR = '#1e6fd9';

export interface RoutePlan {
  profile: RouteProfile;
  stops: RouteStop[];
}

/** Ziel für die Auswahlliste „Objekt hinzufügen“ (eigenes Fahrzeug, Einsatzort, Kartenobjekte, Kräfte) */
export interface RouteCandidate {
  key: string;
  label: string;
  lat: number;
  lon: number;
}

/** Route zu den Halten; neu gerechnet, sobald sich Halte oder Profil ändern (ab Start und Ziel) */
export function useRoute(plan: RoutePlan | null) {
  const stops = plan?.stops ?? [];
  return useQuery({
    queryKey: ['route', plan?.profile, stops.map((s) => `${s.lat.toFixed(6)},${s.lon.toFixed(6)}`).join(';')],
    queryFn: () => api.route({ profile: plan!.profile, stops }),
    enabled: !!plan && stops.length >= 2,
    staleTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/** Rolle eines Halts: Start, Zwischenziel, Ziel */
const stopRole = (i: number, n: number) => (i === 0 ? 'start' : i === n - 1 ? 'end' : 'via');
const ROLE_LABELS = { start: 'Start', via: 'Zwischenziel', end: 'Ziel' } as const;

const stopIcon = (i: number, n: number) =>
  L.divIcon({ className: `map-marker route-stop ${stopRole(i, n)}`, html: `<span>${i + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });

/** Route und Halte auf der Karte; eine neue Route wird ganz gezeigt */
export function RouteLayer({ stops, route }: { stops: RouteStop[]; route: RouteResult | undefined }) {
  const map = useMap();
  const positions = useMemo(() => route?.path.map(([lon, lat]) => [lat, lon] as [number, number]) ?? [], [route]);
  useEffect(() => {
    if (positions.length > 1) map.flyToBounds(L.latLngBounds(positions), { padding: [64, 64], maxZoom: 16 });
  }, [positions, map]);
  return (
    <>
      {positions.length > 1 && (
        <>
          <Polyline positions={positions} interactive={false} pathOptions={{ color: '#ffffff', weight: 9, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }} />
          <Polyline positions={positions} interactive={false} pathOptions={{ color: ROUTE_COLOR, weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }} />
        </>
      )}
      {stops.map((s, i) => (
        <Marker key={`${i}-${s.lat}-${s.lon}`} position={[s.lat, s.lon]} icon={stopIcon(i, stops.length)} keyboard={false}>
          <Tooltip direction="top" offset={[0, -12]}>
            {ROLE_LABELS[stopRole(i, stops.length)]}: {s.name}
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}

/** Verlauf auf höchstens max Punkte ausdünnen (Kartenobjekte und Druck begrenzen die Punktzahl); Endpunkt bleibt */
export function thinPath(path: [number, number][], max = 20_000): [number, number][] {
  if (path.length <= max) return path;
  const step = (path.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => path[Math.round(i * step)]!);
}

/** Route als Linie für die Objektliste */
export function routeObject(stops: RouteStop[], route: RouteResult): NewMapObject {
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  return {
    kind: 'line',
    name: `Route ${first.name} → ${last.name}`.slice(0, 120),
    lat: first.lat,
    lon: first.lon,
    color: ROUTE_COLOR,
    data: { detail: routeSummary(route), osm: null, path: { type: 'LineString', coordinates: thinPath(route.path) } },
  };
}

/**
 * Routenbox unter der Werkzeugleiste: Halte in Reihenfolge (Suche, Objekte, Suchtreffer der Karte), Fahrprofil,
 * Strecke und Fahrzeit; übernehmen in die Objektliste oder drucken.
 */
export function RoutePanel({
  top,
  plan,
  onChange,
  route,
  candidates,
  focus,
  adopt,
  onPrint,
  onClose,
}: {
  /** Abstand von oben (unter der Werkzeugleiste) */
  top: number;
  plan: RoutePlan;
  onChange: (p: RoutePlan) => void;
  route: ReturnType<typeof useRoute>;
  candidates: RouteCandidate[];
  focus: () => { lat: number; lon: number } | null;
  /** Übernehmen: null = nicht erlaubt (Grund), sonst Aktion */
  adopt: { run: () => void; pending: boolean } | { reason: string };
  onPrint: () => void;
  onClose: () => void;
}) {
  const { stops } = plan;
  const full = stops.length >= MAX_ROUTE_STOPS;
  const add = (s: RouteStop) => !full && onChange({ ...plan, stops: [...stops, s] });
  const move = (i: number, d: -1 | 1) => {
    const next = [...stops];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange({ ...plan, stops: next });
  };
  const remove = (i: number) => onChange({ ...plan, stops: stops.filter((_, j) => j !== i) });
  const data = stops.length >= 2 ? route.data : undefined;
  // Nach dem Ändern der Halte zeigt die Box noch die vorige Route, bis die neue da ist
  const stale = route.isPlaceholderData || route.isFetching;

  return (
    <div className="map-overlay map-route" style={{ top }} role="dialog" aria-label="Route planen">
      <div className="map-route-head">
        <RouteIcon size={18} />
        <strong>Route</strong>
        <Segmented<RouteProfile>
          label="Fahrprofil"
          value={plan.profile}
          onChange={(profile) => onChange({ ...plan, profile })}
          options={(['auto', 'truck'] as const).map((p) => ({ value: p, label: ROUTE_PROFILE_LABELS[p], title: p === 'truck' ? 'Lkw-Profil: meidet Gewichts- und Höhenbeschränkungen' : undefined }))}
        />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Route schließen" title="Schließen">
          <X size={16} />
        </button>
      </div>

      {stops.length > 0 ? (
        <ol className="map-route-stops">
          {stops.map((s, i) => {
            const role = stopRole(i, stops.length);
            return (
              <li key={`${i}-${s.lat}-${s.lon}`}>
                <span className={`map-route-num ${role}`}>{i + 1}</span>
                <span className="map-route-name" title={`${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`}>
                  {s.name}
                  <span className="muted">{stops.length > 1 ? ROLE_LABELS[role] : 'Start'}</span>
                </span>
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${s.name} nach oben`} title="Nach oben">
                  <ArrowUp size={15} />
                </button>
                <button type="button" className="icon-btn" disabled={i === stops.length - 1} onClick={() => move(i, 1)} aria-label={`${s.name} nach unten`} title="Nach unten">
                  <ArrowDown size={15} />
                </button>
                <button type="button" className="icon-btn" onClick={() => remove(i)} aria-label={`${s.name} entfernen`} title="Entfernen">
                  <X size={15} />
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted map-route-hint">Start, Zwischenziele und Ziel nacheinander hinzufügen – über die Suche, die Auswahl darunter oder „Als Ziel“ an Suchtreffern und in der Objektliste.</p>
      )}

      {!full && (
        <div className="map-route-add">
          <MapSearch focus={focus} onSelect={(r) => add({ lat: r.lat, lon: r.lon, name: r.name })} id="map-route-search-results" placeholder="Ziel suchen …" label="Ziel für die Route suchen" clearOnSelect />
          {candidates.length > 0 && (
            <select
              value=""
              aria-label="Objekt als Ziel hinzufügen"
              onChange={(e) => {
                const c = candidates.find((x) => x.key === e.target.value);
                if (c) add({ lat: c.lat, lon: c.lon, name: c.label });
              }}
            >
              <option value="">Objekt als Ziel …</option>
              {candidates.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {stops.length >= 2 && (
        <div className={`map-route-summary ${stale ? 'stale' : ''}`} role="status">
          {route.isFetching && <Loader2 size={16} className="spin" />}
          {route.error ? (
            <span className="tone-warn">{(route.error as Error).message}</span>
          ) : data ? (
            <span>
              <strong>{formatDistance(data.distanceM)}</strong> · ca. {formatDuration(data.durationS)} · {data.maneuvers.length} Fahrhinweise
            </span>
          ) : (
            <span className="muted">Route wird berechnet …</span>
          )}
        </div>
      )}

      <div className="map-route-actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!data || stale || 'reason' in adopt || adopt.pending}
          title={'reason' in adopt ? adopt.reason : undefined}
          onClick={() => 'run' in adopt && adopt.run()}
        >
          <ListPlus size={14} /> In Objektliste übernehmen
        </button>
        <button type="button" className="btn btn-sm" disabled={!data || stale} onClick={onPrint}>
          <Printer size={14} /> Route drucken
        </button>
      </div>
    </div>
  );
}

/** Routenausdruck: Titel und Kartenstil wählen, PDF herunterladen oder an einen Drucker senden */
export function RoutePrintDialog({ sources, initialSourceId, stops, route, onDone }: { sources: MapSource[]; initialSourceId: string; stops: RouteStop[]; route: RouteResult; onDone: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(`Route ${stops[0]!.name} → ${stops[stops.length - 1]!.name}`.slice(0, 120));
  const [sourceId, setSourceId] = useState(initialSourceId);
  const { data: printStatus } = usePrintStatus();
  const hasPrinters = !!printStatus?.printers.length;
  const [target, setTarget] = useState<'pdf' | 'printer' | null>(null);
  const output = target ?? (hasPrinters ? 'printer' : 'pdf');
  const { form, setForm, printer, valid: printerValid } = usePrintForm(printStatus);
  const media = mediaFor(printer, 'A4');
  // Die Druckanfrage begrenzt die Fahrhinweise; sehr lange Routen werden gekürzt gedruckt
  const maneuvers = route.maneuvers.slice(0, 300);

  const print = useMutation({
    mutationFn: async () => {
      const res = await api.printRoute({ title: title.trim() || 'Route', sourceId, stops, route: { ...route, path: thinPath(route.path), maneuvers } });
      if (output === 'pdf') return { ...res, job: null };
      const file = new File([res.pdf], res.filename, { type: 'application/pdf' });
      const job = await api.printPdf(file, { ...form, media, orientation: 'auto', pageRanges: '', numberUp: 1 });
      return { ...res, job };
    },
    onSuccess: ({ pdf, filename, missingTiles, job }) => {
      if (!job) downloadBlob(pdf, filename);
      const what = job ? `Route an ${job.printerName} gesendet${job.archivedPath ? ` und unter „${job.archivedPath}“ abgelegt` : ''}` : 'Route als PDF erstellt';
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
        A4 hoch: Übersichtskarte mit {stops.length} Halten, danach {maneuvers.length} Fahrhinweise mit je einem Kartenausschnitt. {formatDistance(route.distanceM)} · ca. {formatDuration(route.durationS)} ·{' '}
        {ROUTE_PROFILE_LABELS[route.profile]}.
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
          <Printer size={18} /> {print.isPending ? 'Wird gedruckt …' : 'Drucken (A4)'}
        </button>
      ) : (
        <button className="btn btn-primary btn-lg" disabled={print.isPending} onClick={() => print.mutate()}>
          <FileDown size={18} /> {print.isPending ? 'PDF wird erstellt …' : 'PDF erzeugen (A4)'}
        </button>
      )}
    </div>
  );
}
