import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';

type State = 'connecting' | 'playing' | 'waiting' | 'error';

/**
 * Schlanker WebRTC-Player (WHEP, z. B. MediaMTX unter <url>/whep).
 * Startet immer stumm – das erlaubt jeder Browser ohne Bedienung. Ist Ton gewünscht, wird er danach eingeschaltet;
 * blockiert der Browser das (keine Bedienung auf der Seite), läuft das Bild stumm weiter und ein Knopf
 * „Ton einschalten“ erscheint. Kiosk-Browser mit --autoplay-policy=no-user-gesture-required spielen Ton sofort.
 */
export function WebRtcPlayer({ url, audio }: { url: string; audio: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>('connecting');
  const [message, setMessage] = useState('');
  const [needsTap, setNeedsTap] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const pc = new RTCPeerConnection();
    const stream = new MediaStream();
    const again = (msg: string, waiting = false) => {
      if (disposed) return;
      setState(waiting ? 'waiting' : 'error');
      setMessage(msg);
      retry = setTimeout(() => setAttempt((a) => a + 1), 3_000);
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      stream.addTrack(e.track);
      const v = video.current;
      if (v && v.srcObject !== stream) v.srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') again('Verbindung unterbrochen – verbinde neu …');
    };

    (async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        // ohne Trickle-ICE: kurz auf die eigenen Kandidaten warten
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') return resolve();
          const t = setTimeout(resolve, 1_500);
          pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && (clearTimeout(t), resolve()));
        });
        const res = await fetch(`${url.replace(/\/+$/, '')}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription!.sdp });
        if (res.status === 404) return again('Quelle liefert gerade kein Bild – warte …', true);
        if (!res.ok) return again(`Gateway antwortet mit HTTP ${res.status}`);
        await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      } catch (err) {
        again(`Gateway nicht erreichbar (${(err as Error).message})`);
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(retry);
      pc.close();
    };
  }, [url, attempt]);

  // Wiedergabe: immer stumm starten, dann Ton versuchen
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onPlaying = async () => {
      setState('playing');
      setMessage('');
      if (!audio || !v.muted) return;
      v.muted = false;
      try {
        await v.play();
        setNeedsTap(false);
      } catch {
        // Browser verlangt eine Bedienung – stumm weiterlaufen lassen
        v.muted = true;
        void v.play().catch(() => {});
        setNeedsTap(true);
      }
      if (v.paused) {
        v.muted = true;
        void v.play().catch(() => {});
        setNeedsTap(true);
      }
    };
    v.addEventListener('playing', onPlaying);
    return () => v.removeEventListener('playing', onPlaying);
  }, [audio]);

  useEffect(() => {
    if (!audio && video.current) video.current.muted = true;
    if (!audio) setNeedsTap(false);
  }, [audio]);

  const unmute = () => {
    const v = video.current;
    if (!v) return;
    v.muted = false;
    void v.play().then(() => setNeedsTap(false), () => (v.muted = true));
  };

  return (
    <div className="webrtc-player">
      <video ref={video} autoPlay muted playsInline />
      {state !== 'playing' && <div className="webrtc-player-state">{message || 'Verbinde …'}</div>}
      {needsTap && (
        <button type="button" className="webrtc-player-unmute" onClick={unmute}>
          <Volume2 size={18} /> Ton einschalten
        </button>
      )}
    </div>
  );
}
