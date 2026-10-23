import { useEffect, useState } from 'react';
import { VideoOff } from 'lucide-react';
import type { CameraStatus } from '@elvis/shared';
import { api } from '../../lib/api';

/** Livebild (MJPEG über ELVIS); bei Abbruch nach kurzer Pause neu verbinden. */
export function CameraImage({ cam, kind }: { cam: CameraStatus; kind: 'live' | 'thumb' }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => (setFailed(false), setAttempt((a) => a + 1)), 5_000);
    return () => clearTimeout(t);
  }, [failed]);

  const placeholder = (text: string) => (
    <div className="camera-placeholder">
      <VideoOff size={kind === 'live' ? 40 : 22} />
      <span>{text}</span>
    </div>
  );
  if (cam.type === 'demo') return placeholder('Demo-Kamera – kein Videobild');
  if (!cam.online) return placeholder('Kamera nicht erreichbar');
  if (failed) return placeholder('Videobild unterbrochen – verbinde neu …');
  return <img key={attempt} src={`${api.cameraStreamUrl(cam.id, kind)}&n=${attempt}`} alt={`Livebild ${cam.name}`} onError={() => setFailed(true)} draggable={false} />;
}

