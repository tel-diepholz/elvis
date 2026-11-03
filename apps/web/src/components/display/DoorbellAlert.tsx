import { useEffect, useRef, useState } from 'react';
import { BellRing, Volume2, VolumeX, X } from 'lucide-react';
import type { DoorbellRing } from '@elvis/shared';
import { useDevice } from '../../lib/live';
import { CameraImage } from '../camera/CameraImage';

/** Abstand, in dem der Ton wiederholt wird, solange niemand ihn abschaltet */
const CHIME_REPEAT_MS = 15_000;

let audio: AudioContext | null = null;

/**
 * Leiser Zweiklang „Ding-Dong“ (Terz abwärts, weich ein- und ausgeblendet), ohne Audiodatei über WebAudio.
 * Spielt der Browser ohne Bedienung keinen Ton (Autoplay-Sperre), bleibt es still – Kiosk-Browser mit
 * --autoplay-policy=no-user-gesture-required spielen ihn sofort.
 */
export function playChime(volume = 0.18): void {
  try {
    audio ??= new AudioContext();
    void audio.resume().catch(() => {});
    const start = audio.currentTime + 0.05;
    for (const [i, freq] of [659.25, 523.25].entries()) {
      const t = start + i * 0.55;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 1.7);
    }
  } catch {
    /* kein WebAudio */
  }
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Klingeln an einer Türstation auf diesem Bildschirm: Dialog mit Livebild über allen Kacheln, dazu der Ton,
 * bis er abgeschaltet oder der Dialog geschlossen wird. Verschwindet von selbst, wenn das Klingeln abläuft.
 */
export function DoorbellAlert({ displayId }: { displayId: string }) {
  const snapshot = useDevice('cameras');
  const rings = (snapshot?.state.rings ?? []).filter((r) => r.displays.includes(displayId));
  const cams = snapshot?.state.cameras ?? [];
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [muted, setMuted] = useState<Set<string>>(() => new Set());
  const open = rings.filter((r) => !dismissed.has(r.id));
  const ring: DoorbellRing | undefined = open[open.length - 1];
  const silent = !ring || muted.has(ring.id);
  const chimed = useRef<string | null>(null);

  // Ton sofort beim neuen Klingeln, danach in Abständen, solange nicht abgeschaltet
  useEffect(() => {
    if (!ring || silent) return;
    if (chimed.current !== ring.id) {
      chimed.current = ring.id;
      playChime();
    }
    const i = setInterval(() => playChime(), CHIME_REPEAT_MS);
    return () => clearInterval(i);
  }, [ring?.id, silent]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ring) return null;
  const cam = cams.find((c) => c.id === ring.cameraId);
  const close = () => setDismissed(new Set([...dismissed, ...open.map((r) => r.id)]));
  const toggleSound = () => {
    const next = new Set(muted);
    if (next.has(ring.id)) {
      next.delete(ring.id);
      playChime();
    } else next.add(ring.id);
    setMuted(next);
  };

  return (
    <div className="doorbell-overlay" role="alertdialog" aria-modal="true" aria-labelledby="doorbell-title">
      <div className="doorbell-dialog">
        <header className="doorbell-head">
          <BellRing size={32} className="doorbell-bell" />
          <div>
            <h2 id="doorbell-title">Es klingelt: {ring.label}</h2>
            <span className="muted">
              {ring.cameraName} · {time(ring.at)}
              {open.length > 1 && ` · ${open.length - 1} weitere`}
            </span>
          </div>
        </header>
        <div className="doorbell-image">{cam ? <CameraImage cam={cam} kind="live" /> : <div className="camera-placeholder">Türstation nicht mehr eingerichtet</div>}</div>
        <footer className="doorbell-actions">
          <button type="button" className="btn btn-lg" onClick={toggleSound}>
            {silent ? <Volume2 size={22} /> : <VolumeX size={22} />} {silent ? 'Klingelton an' : 'Klingelton aus'}
          </button>
          <button type="button" className="btn btn-primary btn-lg" onClick={close}>
            <X size={22} /> Schließen
          </button>
        </footer>
      </div>
    </div>
  );
}
