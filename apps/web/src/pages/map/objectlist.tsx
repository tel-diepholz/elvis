import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Crosshair, Eye, EyeOff, MapPin, Plane, Shapes, Ship, Square, Trash2, Truck, Wind as WindIcon } from 'lucide-react';
import {
  COLORABLE_KINDS,
  DEFAULT_OBJECT_COLORS,
  MAP_OBJECT_COLORS,
  MAP_OBJECT_LABELS,
  SECTOR_LENGTHS,
  UNIT_STATUS,
  formatAltitude,
  objectColor,
  unitChildren,
  type GaussSettings,
  type Incident,
  type MapObject,
  type Unit,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtAgo, fmtTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Field } from '../../components/ui';
import { TacticalSignImage } from '../../components/tactical/TacticalSign';
import { GaussControls, NoWindWarning, fmtDistance, usePlume, type Wind } from '../../components/map/dispersion';

const OPEN_KEY = 'elvis.map.objectsOpen';
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
};

const KIND_ICONS = { point: MapPin, area: Square, gauss: WindIcon, sector: Crosshair, aircraft: Plane, ship: Ship } as const;

function GaussEditor({ object, wind, now, canEdit }: { object: Extract<MapObject, { kind: 'gauss' }>; wind: Wind | undefined; now: Date; canEdit: boolean }) {
  const toast = useToast();
  // Eingaben sofort zeigen, gespeichert wird nach einer kurzen Pause (Zahlenfelder ändern sich je Tastendruck)
  const [draft, setDraft] = useState<GaussSettings>(object.data);
  const pending = useRef<Partial<GaussSettings>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!Object.keys(pending.current).length) setDraft(object.data);
  }, [object.data]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const plume = usePlume(draft, object, wind, now);
  const change = (p: Partial<GaussSettings>) => {
    setDraft((d) => ({ ...d, ...p }));
    pending.current = { ...pending.current, ...p };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const data = pending.current;
      pending.current = {};
      api.patchMapObject(object.id, { data }).catch((e: Error) => toast('error', e.message));
    }, 600);
  };
  return <GaussControls settings={draft} onChange={change} result={plume} noWind={!wind} disabled={!canEdit} />;
}

/** Farbauswahl eines Objekts; „Standard“ setzt auf die Vorgabe der Objektart zurück */
function ColorPalette({ object, onPick }: { object: MapObject; onPick: (color: string | null) => void }) {
  const current = objectColor(object);
  return (
    <div className="map-object-colors" role="radiogroup" aria-label={`Farbe von ${object.name}`}>
      {MAP_OBJECT_COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={current === c.value}
          aria-label={c.label}
          title={c.label}
          className={`map-color ${current === c.value ? 'active' : ''}`}
          style={{ background: c.value }}
          onClick={() => onPick(c.value === DEFAULT_OBJECT_COLORS[object.kind] ? null : c.value)}
        />
      ))}
      {object.color && (
        <button type="button" className="btn btn-sm" onClick={() => onPick(null)}>
          Standard
        </button>
      )}
    </div>
  );
}

/** Kräfte (ohne entlassene) in Baumreihenfolge mit Tiefe */
function unitRows(units: Unit[]): { unit: Unit; depth: number }[] {
  const children = unitChildren(units.filter((u) => u.status !== 'entlassen'));
  const out: { unit: Unit; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const u of children.get(parent) ?? []) out.push({ unit: u, depth }), walk(u.id, depth + 1);
  };
  walk(null, 0);
  return out;
}

function summary(o: MapObject, now: Date): string {
  switch (o.kind) {
    case 'point':
    case 'area':
      return o.data.detail || MAP_OBJECT_LABELS[o.kind];
    case 'gauss':
      return `${MAP_OBJECT_LABELS.gauss}${o.data.stability === 'auto' ? '' : ` · Klasse ${o.data.stability}`}`;
    case 'sector':
      return `${MAP_OBJECT_LABELS.sector} · ${fmtDistance(o.data.sectorM)}`;
    case 'aircraft':
    case 'ship': {
      const { last, lostSince, detail } = o.data;
      if (lostSince) return `Kein Signal seit ${fmtTime(lostSince)} · ${detail}`;
      if (!last) return `warte auf Position · ${detail}`;
      const speed = last.speedKt != null ? `${Math.round(last.speedKt)} kn` : null;
      return [o.kind === 'aircraft' ? formatAltitude(last.altFt, last.onGround) : null, speed, fmtAgo(last.at, now)].filter(Boolean).join(' · ');
    }
  }
}

/**
 * Objektliste des Einsatzes (Seitenleiste rechts): Einsatzort und Kartenobjekte, ein Klick fliegt hin.
 * Ausbreitungen klappen ihre Einstellungen auf; ändern dürfen angemeldete Benutzer, solange der Einsatz läuft.
 */
export function ObjectList({
  incident,
  vehicle,
  objects,
  units,
  wind,
  now,
  canEdit,
  shiftPx = 0,
  onFly,
  onMoveIncident,
  onPlaceUnit,
}: {
  incident: Incident;
  /** Eigenes Fahrzeug (immer erster Eintrag, nur ausblendbar); pos = null ohne GPS */
  vehicle: { name: string; pos: [number, number] | null };
  objects: MapObject[];
  /** Kräfte des Einsatzes; ohne Position stehen sie in der Liste, bis sie gesetzt werden */
  units: Unit[];
  wind: Wind | undefined;
  now: Date;
  canEdit: boolean;
  /** Nach unten rücken, solange darüber ein Menü offen ist (Kartenstil) */
  shiftPx?: number;
  onFly: (target: MapObject | Unit | 'incident' | 'vehicle') => void;
  onMoveIncident: () => void;
  onPlaceUnit: (u: Unit) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(readOpen);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [coloring, setColoring] = useState<number | null>(null);
  const hasLocation = incident.lat != null && incident.lon != null;
  const shift = { '--objects-shift': `${shiftPx}px` } as CSSProperties;

  const toggleOpen = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? '0' : '1');
      } catch {
        /* nur Komfort */
      }
      return !o;
    });
  };

  const patch = useMutation({
    mutationFn: ({ id, ...p }: { id: number; visible?: boolean; color?: string | null; data?: { sectorM: number } }) => api.patchMapObject(id, p),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mapObjects', incident.id] }),
    onError: (e) => toast('error', e.message),
  });
  const remove = useMutation({
    mutationFn: (o: MapObject) => api.removeMapObject(o.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mapObjects', incident.id] }),
    onError: (e) => toast('error', e.message),
  });
  const clearLocation = useMutation({
    mutationFn: () => api.updateIncident(incident.id, { lat: null, lon: null }),
    onError: (e) => toast('error', e.message),
  });
  const patchUnit = useMutation({
    mutationFn: ({ id, ...p }: { id: number; mapVisible?: boolean; lat?: null; lon?: null }) => api.patchUnit(id, p),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['units', incident.id] }),
    onError: (e) => toast('error', e.message),
  });
  const forces = unitRows(units);
  const vehicleVisible = useMutation({
    mutationFn: (visible: boolean) => api.updateIncident(incident.id, { vehicleVisible: visible }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['incident'] }),
    onError: (e) => toast('error', e.message),
  });

  if (!open)
    return (
      <button type="button" className="map-overlay map-objects-tab" style={shift} onClick={toggleOpen} aria-label="Objektliste öffnen">
        <ChevronLeft size={18} /> <Shapes size={18} /> {objects.length + forces.length + (hasLocation ? 1 : 0) + 1}
      </button>
    );

  return (
    <aside className="map-overlay map-objects" style={shift} aria-label="Objekte">
      <div className="map-objects-head">
        <strong>Objekte</strong>
        <button type="button" className="icon-btn" onClick={toggleOpen} aria-label="Objektliste schließen">
          <ChevronRight size={18} />
        </button>
      </div>
      <ul className="map-objects-list">
        <li className={`map-object ${incident.vehicleVisible ? '' : 'hidden'}`}>
          <button type="button" className="map-object-main" onClick={() => vehicle.pos && onFly('vehicle')} disabled={!vehicle.pos}>
            <span className="map-object-icon vehicle">
              <Truck size={16} />
            </span>
            <span className="map-object-text">
              <strong>{vehicle.name}</strong>
              <span className="muted">{vehicle.pos ? `Eigenes Fahrzeug · ${vehicle.pos[0].toFixed(5)}, ${vehicle.pos[1].toFixed(5)}` : 'Eigenes Fahrzeug · kein GPS'}</span>
            </span>
          </button>
          {canEdit && (
            <span className="map-object-actions">
              <button
                type="button"
                className="icon-btn"
                onClick={() => vehicleVisible.mutate(!incident.vehicleVisible)}
                aria-label={incident.vehicleVisible ? 'Fahrzeug ausblenden' : 'Fahrzeug einblenden'}
                title={incident.vehicleVisible ? 'Ausblenden' : 'Einblenden'}
              >
                {incident.vehicleVisible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </span>
          )}
        </li>
        <li className="map-object">
          <button type="button" className="map-object-main" onClick={() => hasLocation && onFly('incident')} disabled={!hasLocation}>
            <span className="map-object-icon incident">!</span>
            <span className="map-object-text">
              <strong>Einsatzort</strong>
              <span className="muted">{hasLocation ? incident.location || 'auf der Karte gesetzt' : 'noch nicht gesetzt – über „Objekte“'}</span>
            </span>
          </button>
          {canEdit && (
            <span className="map-object-actions">
              <button type="button" className="icon-btn" onClick={onMoveIncident} title={hasLocation ? 'Verschieben' : 'Setzen'} aria-label="Einsatzort setzen">
                <MapPin size={16} />
              </button>
              {hasLocation && (
                <button type="button" className="icon-btn" onClick={() => window.confirm('Einsatzort von der Karte entfernen?') && clearLocation.mutate()} title="Entfernen" aria-label="Einsatzort entfernen">
                  <Trash2 size={16} />
                </button>
              )}
            </span>
          )}
        </li>
        {objects.map((o) => {
          const Icon = KIND_ICONS[o.kind];
          const settings = o.kind === 'gauss' || o.kind === 'sector';
          const isOpen = expanded === o.id;
          const colorable = COLORABLE_KINDS.includes(o.kind);
          const color = objectColor(o);
          return (
            <li key={o.id} className={`map-object ${o.visible ? '' : 'hidden'}`}>
              <button type="button" className="map-object-main" onClick={() => onFly(o)}>
                <span className={`map-object-icon ${o.kind}`} style={colorable ? { color, background: `${color}26` } : undefined}>
                  <Icon size={16} />
                </span>
                <span className="map-object-text">
                  <strong>{o.name}</strong>
                  <span className="muted">{summary(o, now)}</span>
                </span>
              </button>
              <span className="map-object-actions">
                {settings && (
                  <button type="button" className="icon-btn" onClick={() => setExpanded(isOpen ? null : o.id)} aria-expanded={isOpen} aria-label="Einstellungen" title="Einstellungen">
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                )}
                {canEdit && colorable && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setColoring(coloring === o.id ? null : o.id)}
                    aria-expanded={coloring === o.id}
                    aria-label="Farbe"
                    title="Farbe"
                  >
                    <span className="map-color-dot" style={{ background: color }} />
                  </button>
                )}
                {canEdit && (
                  <>
                    <button type="button" className="icon-btn" onClick={() => patch.mutate({ id: o.id, visible: !o.visible })} aria-label={o.visible ? 'Ausblenden' : 'Einblenden'} title={o.visible ? 'Ausblenden' : 'Einblenden'}>
                      {o.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                    </button>
                    <button type="button" className="icon-btn" onClick={() => window.confirm(`„${o.name}“ von der Karte entfernen?`) && remove.mutate(o)} aria-label="Entfernen" title="Entfernen">
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </span>
              {coloring === o.id && canEdit && <ColorPalette object={o} onPick={(c) => (patch.mutate({ id: o.id, color: c }), setColoring(null))} />}
              {isOpen && o.kind === 'gauss' && <GaussEditor object={o} wind={wind} now={now} canEdit={canEdit} />}
              {isOpen && o.kind === 'sector' && (
                <div className="dispersion-panel">
                  {!wind && <NoWindWarning />}
                  <Field label="Sektorlänge">
                    <select value={o.data.sectorM} disabled={!canEdit} onChange={(e) => patch.mutate({ id: o.id, data: { sectorM: Number(e.target.value) } })}>
                      {[...new Set([...SECTOR_LENGTHS, o.data.sectorM])].sort((a, b) => a - b).map((m) => (
                        <option key={m} value={m}>
                          {fmtDistance(m)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p className="dispersion-note">Schematischer Sektor ±30° in Windrichtung, dreht mit dem aktuellen Wind.</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!objects.length && <p className="muted map-objects-empty">Weitere Objekte über „Objekte“ oder aus der Suche hinzufügen.</p>}
      {forces.length > 0 && (
        <>
          <div className="map-objects-head map-objects-subhead">
            <strong>Kräfte</strong>
            <span className="muted">
              {forces.filter((f) => f.unit.lat !== null).length}/{forces.length} gesetzt
            </span>
          </div>
          <ul className="map-objects-list">
            {forces.map(({ unit: u, depth }) => {
              const placed = u.lat !== null && u.lon !== null;
              return (
                <li key={u.id} className={`map-object ${u.mapVisible ? '' : 'hidden'}`} style={{ paddingLeft: depth * 14 }}>
                  <button type="button" className="map-object-main" onClick={() => (placed ? onFly(u) : canEdit && onPlaceUnit(u))} disabled={!placed && !canEdit}>
                    <span className="map-object-icon unit">
                      <TacticalSignImage sign={u.sign} height={22} />
                    </span>
                    <span className="map-object-text">
                      <strong>{u.name}</strong>
                      <span className="muted">
                        {UNIT_STATUS[u.status]}
                        {placed ? '' : ' · noch ohne Position'}
                      </span>
                    </span>
                  </button>
                  {canEdit && (
                    <span className="map-object-actions">
                      <button type="button" className="icon-btn" onClick={() => onPlaceUnit(u)} title={placed ? 'Verschieben' : 'Position setzen'} aria-label={`Position von ${u.name} setzen`}>
                        <MapPin size={16} />
                      </button>
                      {placed && (
                        <>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => patchUnit.mutate({ id: u.id, mapVisible: !u.mapVisible })}
                            aria-label={u.mapVisible ? 'Ausblenden' : 'Einblenden'}
                            title={u.mapVisible ? 'Ausblenden' : 'Einblenden'}
                          >
                            {u.mapVisible ? <Eye size={16} /> : <EyeOff size={16} />}
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => window.confirm(`Position von ${u.name} entfernen?`) && patchUnit.mutate({ id: u.id, lat: null, lon: null })}
                            aria-label="Position entfernen"
                            title="Position entfernen"
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}
