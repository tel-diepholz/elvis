import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Bookmark,
  Cctv,
  Focus,
  House,
  Maximize,
  Minimize,
  Square,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { CameraStatus, DayNightMode } from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNum, fmtTime } from '../lib/format';
import { useActiveIncident, useCommand } from '../lib/hooks';
import { useDevice } from '../lib/live';
import { useToast } from '../lib/toast';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { CameraImage } from '../components/camera/CameraImage';
import { Badge, Card, EmptyState, PageHeader, Segmented } from '../components/ui';

const SELECTED_KEY = 'elvis.camera';
const readSelected = () => {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
};

/**
 * Livebild, auf Wunsch über das ganze Browserfenster (Knopf oder Doppelklick, Esc beendet) – bewusst ohne
 * Bildschirm-Vollbild des Browsers. Kein <button>: die Nur-Ansicht-Sperre deaktiviert Knöpfe, maximieren soll aber
 * jeder können.
 */
function LiveView({ cam }: { cam: CameraStatus }) {
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (!filled) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFilled(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filled]);
  const toggle = () => setFilled((f) => !f);
  const label = filled ? 'Verkleinern' : 'Im Fenster maximieren';

  return (
    <div className={`camera-live ${filled ? 'camera-live-filled' : ''}`} onDoubleClick={toggle}>
      <CameraImage cam={cam} kind="live" />
      <div className="camera-overlay">
        <strong>{cam.name}</strong>
        <Badge tone={cam.online ? 'ok' : 'alarm'}>{cam.online ? 'live' : 'offline'}</Badge>
      </div>
      <div
        role="button"
        tabIndex={0}
        className="camera-fullscreen"
        aria-label={label}
        title={`${label} (Doppelklick aufs Bild${filled ? ', Esc' : ''})`}
        onClick={toggle}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle())}
      >
        {filled ? <Minimize size={20} /> : <Maximize size={20} />}
      </div>
    </div>
  );
}

/** Gedrückt halten: Befehl sofort und alle 400 ms wiederholen (der Server hält ohne Wiederholung nach ~1 s an). */
function useHold(onRepeat: () => void, onStop: () => void) {
  const timer = useRef<number | null>(null);
  const stop = useRef(onStop);
  stop.current = onStop;
  const end = () => {
    if (timer.current === null) return;
    clearInterval(timer.current);
    timer.current = null;
    stop.current();
  };
  useEffect(() => end, []);
  return {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      onRepeat();
      timer.current = window.setInterval(onRepeat, 400);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
}

function HoldButton({ label, icon, onRepeat, onStop, className = '' }: { label: string; icon: React.ReactNode; onRepeat: () => void; onStop: () => void; className?: string }) {
  const hold = useHold(onRepeat, onStop);
  return (
    <button type="button" className={`btn ptz-btn ${className}`} aria-label={label} title={label} {...hold}>
      {icon}
    </button>
  );
}

const PAD: [number, number, React.ReactNode, string][] = [
  [-1, 1, <ArrowUpLeft key="ul" />, 'links oben'],
  [0, 1, <ArrowUp key="u" />, 'hoch'],
  [1, 1, <ArrowUpRight key="ur" />, 'rechts oben'],
  [-1, 0, <ArrowLeft key="l" />, 'links'],
  [0, 0, null, ''],
  [1, 0, <ArrowRight key="r" />, 'rechts'],
  [-1, -1, <ArrowDownLeft key="dl" />, 'links unten'],
  [0, -1, <ArrowDown key="d" />, 'runter'],
  [1, -1, <ArrowDownRight key="dr" />, 'rechts unten'],
];

function CameraControls({ cam }: { cam: CameraStatus }) {
  const { send, pending } = useCommand('cameras');
  const toast = useToast();
  const [speed, setSpeed] = useState(50);
  const disabled = !cam.online;
  const c = cam.caps;
  // Bewegung direkt senden (ohne Ladezustand und ohne Erfolgsmeldung)
  const move = (pan: number, tilt: number, zoom = 0) => void api.command('cameras', 'move', { cameraId: cam.id, pan, tilt, zoom }).catch((e: Error) => toast('error', e.message));
  const stop = () => void api.command('cameras', 'stop', { cameraId: cam.id }).catch(() => {});
  const p = cam.position;
  const zoomText =
    p?.zoom == null ? '–' : c.zoomUnit === 'factor' ? `${fmtNum(p.zoom, 1)}×` : c.zoomUnit === 'fraction' ? `${Math.round(p.zoom * 100)} %` : `${Math.round(((p.zoom - 1) / 9998) * 100)} %`;

  if (!c.panTilt && !c.zoom && !c.focus && !c.dayNight)
    return <p className="muted">{cam.online ? 'Diese Kamera hat keine fernsteuerbaren Funktionen.' : 'Bedienung, sobald die Kamera erreichbar ist.'}</p>;

  return (
    <fieldset className="camera-controls" disabled={disabled}>
      {c.panTilt && (
        <section>
          <h3 className="section-title">Schwenken / Neigen</h3>
          <div className="ptz-pad">
            {PAD.map(([pan, tilt, icon, label]) =>
              pan === 0 && tilt === 0 ? (
                c.home ? (
                  <button key="home" type="button" className="btn ptz-btn" aria-label="Grundstellung" title="Grundstellung" disabled={pending} onClick={() => send('home', { cameraId: cam.id })}>
                    <House />
                  </button>
                ) : (
                  <button key="stop" type="button" className="btn ptz-btn" aria-label="Stopp" title="Stopp" onClick={stop}>
                    <Square />
                  </button>
                )
              ) : (
                <HoldButton key={label} label={label} icon={icon} onRepeat={() => move(pan * speed, tilt * speed)} onStop={stop} />
              ),
            )}
          </div>
          <Segmented
            label="Geschwindigkeit"
            value={speed}
            onChange={setSpeed}
            options={[
              { value: 20, label: 'Langsam' },
              { value: 50, label: 'Mittel' },
              { value: 100, label: 'Schnell' },
            ]}
          />
        </section>
      )}

      {c.zoom && (
        <section>
          <h3 className="section-title">
            Zoom <span className="muted">{zoomText}</span>
          </h3>
          <div className="btn-row camera-steps">
            {c.continuousZoom ? (
              <>
                <HoldButton label="Zoom heraus" icon={<ZoomOut />} onRepeat={() => move(0, 0, -speed)} onStop={stop} />
                <HoldButton label="Zoom hinein" icon={<ZoomIn />} onRepeat={() => move(0, 0, speed)} onStop={stop} />
              </>
            ) : (
              <>
                <button type="button" className="btn" disabled={pending} title="Weit heraus" onClick={() => send('zoom', { cameraId: cam.id, direction: -1, big: true })}>
                  <ZoomOut size={16} /> −−
                </button>
                <button type="button" className="btn" disabled={pending} title="Etwas heraus" onClick={() => send('zoom', { cameraId: cam.id, direction: -1 })}>
                  <ZoomOut size={16} /> −
                </button>
                <button type="button" className="btn" disabled={pending} title="Etwas hinein" onClick={() => send('zoom', { cameraId: cam.id, direction: 1 })}>
                  <ZoomIn size={16} /> +
                </button>
                <button type="button" className="btn" disabled={pending} title="Weit hinein" onClick={() => send('zoom', { cameraId: cam.id, direction: 1, big: true })}>
                  <ZoomIn size={16} /> ++
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {(c.focus || c.autofocus) && (
        <section>
          <h3 className="section-title">
            Fokus <span className="muted">{p?.focus == null ? '' : p.focus > 1 ? p.focus : fmtNum(p.focus, 2)}</span>
          </h3>
          <div className="btn-row camera-steps">
            {c.focus && (
              <>
                <button type="button" className="btn" disabled={pending} onClick={() => send('focus', { cameraId: cam.id, direction: -1, big: true })}>
                  −−
                </button>
                <button type="button" className="btn" disabled={pending} onClick={() => send('focus', { cameraId: cam.id, direction: -1 })}>
                  −
                </button>
                <button type="button" className="btn" disabled={pending} onClick={() => send('focus', { cameraId: cam.id, direction: 1 })}>
                  +
                </button>
                <button type="button" className="btn" disabled={pending} onClick={() => send('focus', { cameraId: cam.id, direction: 1, big: true })}>
                  ++
                </button>
              </>
            )}
            {c.autofocus && (
              <button type="button" className="btn" disabled={pending} onClick={() => send('autofocus', { cameraId: cam.id })}>
                <Focus size={16} /> Autofokus
              </button>
            )}
          </div>
        </section>
      )}

      {c.dayNight && (
        <section>
          <h3 className="section-title">Tag / Nacht</h3>
          <Segmented<DayNightMode>
            label="Tag/Nacht"
            value={cam.dayNight ?? 'auto'}
            disabled={pending}
            onChange={(mode) => send('daynight', { cameraId: cam.id, mode })}
            options={[
              { value: 'auto', label: 'Automatisch' },
              { value: 'day', label: 'Tag' },
              { value: 'night', label: 'Nacht' },
            ]}
          />
        </section>
      )}
    </fieldset>
  );
}

/** Gespeicherte Positionen der gewählten Kamera – gehören zum laufenden Einsatz. */
function CameraPresets({ cam }: { cam: CameraStatus }) {
  const { user } = useAuth();
  const toast = useToast();
  const { data: incident } = useActiveIncident();
  const { data: presets = [] } = useQuery({ queryKey: ['cameraPresets'], queryFn: api.cameraPresets, enabled: !!user });
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: () => api.saveCameraPreset(cam.id, name.trim()),
    onSuccess: (p) => (setName(''), toast('success', `Position „${p.name}“ gespeichert`)),
    onError: (e) => toast('error', e.message),
  });
  const go = useMutation({ mutationFn: api.gotoCameraPreset, onSuccess: (r) => r.message && toast('success', r.message), onError: (e) => toast('error', e.message) });
  const remove = useMutation({ mutationFn: api.removeCameraPreset, onError: (e) => toast('error', e.message) });
  const mine = presets.filter((p) => p.cameraId === cam.id);
  const canSave = cam.caps.panTilt || cam.caps.zoom || cam.caps.focus;

  if (!user) return null;
  return (
    <Card title="Positionen" icon={<Bookmark size={18} />}>
      {!incident ? (
        <p className="muted">
          Positionen gehören zum Einsatz. <Link to="/einsatz">Einsatz eröffnen</Link>, um Positionen zu speichern.
        </p>
      ) : (
        <>
          {mine.length === 0 ? (
            <p className="muted">Für diese Kamera ist im Einsatz noch keine Position gespeichert.</p>
          ) : (
            <ul className="preset-list">
              {mine.map((p) => (
                <li key={p.id}>
                  <button type="button" className="btn preset-go" disabled={!cam.online || go.isPending} onClick={() => go.mutate(p.id)} title="Position anfahren">
                    {p.name}
                  </button>
                  <span className="cell-sub">
                    {fmtTime(p.createdAt)} · {p.createdBy}
                  </span>
                  <button type="button" className="btn btn-icon" aria-label={`Position ${p.name} löschen`} title="Löschen" disabled={remove.isPending} onClick={() => remove.mutate(p.id)}>
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {canSave && (
            <form
              className="preset-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) save.mutate();
              }}
            >
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, z. B. Einfahrt Nord" maxLength={60} aria-label="Name der Position" />
              <button type="submit" className="btn btn-primary" disabled={!name.trim() || !cam.online || save.isPending}>
                Aktuelle Position speichern
              </button>
            </form>
          )}
          <p className="field-hint">Wird der Einsatz beendet oder ein neuer eröffnet, beginnt die Liste leer.</p>
        </>
      )}
    </Card>
  );
}

export function CamerasPage() {
  const dev = useDevice('cameras');
  const admin = !!useAuth().user?.isAdmin;
  const [selected, setSelected] = useState<string | null>(readSelected);
  const header = <PageHeader title="Kameras" subtitle="Livebild und Bedienung der Fahrzeugkameras" />;

  if (!dev)
    return (
      <>
        {header}
        <ModuleDisabled name="Kameras" module="cameras" />
      </>
    );
  const cams = dev.state.cameras;
  if (cams.length === 0)
    return (
      <>
        {header}
        <EmptyState icon={<Cctv size={32} />} title="Noch keine Kameras eingerichtet">
          {admin ? (
            <>
              Kameras unter <Link to="/einstellungen#modul-cameras">Einstellungen → Kameras</Link> anlegen.
            </>
          ) : (
            'Ein Admin kann Kameras in den Einstellungen anlegen.'
          )}
        </EmptyState>
      </>
    );

  const cam = cams.find((c) => c.id === selected) ?? cams[0]!;
  // Ohne fernsteuerbare Funktionen (oder solange offline und unbekannt) keine Seitenblöcke – das Bild nutzt die volle Breite
  const controllable = Object.values(cam.caps).some(Boolean);
  const choose = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(SELECTED_KEY, id);
    } catch {
      /* nur Komfort */
    }
  };

  return (
    <>
      <div className={`cameras-layout ${controllable ? '' : 'no-side'}`}>
        <div className={`camera-main ${cams.length > 1 ? 'has-strip' : ''}`}>
          <LiveView cam={cam} />
          <div className="camera-meta muted">
            {cam.model ?? (cam.type === 'demo' ? 'Demo-Kamera' : 'Modell unbekannt')}
            {cam.error && <span className="tone-alarm"> · {cam.error}</span>}
          </div>
          {cams.length > 1 && (
            <div className="camera-strip" role="tablist" aria-label="Kamera wählen">
              {cams.map((c) => (
                <button key={c.id} type="button" role="tab" aria-selected={c.id === cam.id} className={`camera-thumb ${c.id === cam.id ? 'active' : ''}`} onClick={() => choose(c.id)}>
                  {c.id === cam.id ? (
                    <div className="camera-placeholder">
                      <Cctv size={22} />
                      <span>wird oben angezeigt</span>
                    </div>
                  ) : (
                    <CameraImage cam={c} kind="thumb" />
                  )}
                  <span className="camera-thumb-label">
                    <span className={`dot tone-bg-${c.online ? 'ok' : 'alarm'}`} /> {c.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {controllable && (
          <div className="camera-side">
            <Card title="Bedienung" icon={<Cctv size={18} />}>
              <CameraControls cam={cam} />
            </Card>
            <CameraPresets cam={cam} />
          </div>
        )}
      </div>
    </>
  );
}
