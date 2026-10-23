import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import type { DisplayCommand } from '@elvis/shared';
import { api } from '../lib/api';
import { DISPLAY_COMMAND_EVENT, useLive } from '../lib/live';
import { applyTheme } from '../lib/theme';
import { DisplayCanvas } from '../components/display/DisplayCanvas';

/**
 * Seite für gekoppelte Bildschirme (Kiosk-Browser oder App, /bildschirm): ohne Menü, dunkel, Vollbild.
 * Ungekoppelt zeigt sie einen Kopplungscode; danach das Kachel-Layout, das in ELVIS eingestellt wird.
 */
export function DisplayScreenPage() {
  const queryClient = useQueryClient();
  const { connection } = useLive();
  const { data: self, error } = useQuery({ queryKey: ['displays', 'self'], queryFn: api.displaySelf, refetchInterval: (q) => (q.state.data?.state === 'paired' ? false : 3_000) });
  const [identify, setIdentify] = useState(false);
  const previous = useRef<string | null>(null);
  const display = self?.state === 'paired' ? self.display : null;

  useEffect(() => {
    applyTheme('dark');
    document.documentElement.classList.add('display-mode');
    return () => document.documentElement.classList.remove('display-mode');
  }, []);

  // Ungekoppelt: Kopplung beginnen (Code anzeigen)
  useEffect(() => {
    if (self?.state === 'unpaired') void api.displayStartPairing().then((s) => queryClient.setQueryData(['displays', 'self'], s));
  }, [self?.state, queryClient]);

  // Frisch gekoppelt: einmal neu laden, damit die Live-Verbindung den Bildschirm am Cookie erkennt
  useEffect(() => {
    if (self?.state === 'paired' && previous.current === 'pending') location.reload();
    if (self) previous.current = self.state;
  }, [self]);

  // Lebenszeichen mit Fenstergröße (für die Vorschau in ELVIS)
  useEffect(() => {
    if (!display) return;
    const beat = () => void api.displayHeartbeat(window.innerWidth, window.innerHeight).catch(() => {});
    beat();
    let t: ReturnType<typeof setTimeout>;
    const onResize = () => (clearTimeout(t), (t = setTimeout(beat, 500)));
    window.addEventListener('resize', onResize);
    const i = setInterval(beat, 60_000);
    return () => (window.removeEventListener('resize', onResize), clearInterval(i), clearTimeout(t));
  }, [display?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Befehle aus ELVIS
  useEffect(() => {
    const onCommand = (e: Event) => {
      const action = (e as CustomEvent<DisplayCommand>).detail;
      if (action === 'reload') location.reload();
      if (action === 'identify') {
        setIdentify(true);
        setTimeout(() => setIdentify(false), 6_000);
      }
    };
    window.addEventListener(DISPLAY_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(DISPLAY_COMMAND_EVENT, onCommand);
  }, []);

  if (!self) return <div className="display-screen display-center">{error ? `ELVIS nicht erreichbar – ${(error as Error).message}` : 'Verbinde mit ELVIS …'}</div>;

  if (self.state !== 'paired')
    return (
      <div className="display-screen display-center display-pairing">
        <MonitorSmartphone size={96} />
        <h1>Bildschirm koppeln</h1>
        {self.state === 'pending' ? (
          <>
            <p>In ELVIS unter System → Bildschirme „Bildschirm koppeln“ wählen und diesen Code eingeben:</p>
            <div className="display-code">{self.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</div>
            <p className="muted">Der Code gilt 10 Minuten und wird danach automatisch erneuert.</p>
          </>
        ) : (
          <p>Code wird angefordert …</p>
        )}
      </div>
    );

  return (
    <div className="display-screen">
      {display!.layout.tiles.length ? (
        <DisplayCanvas layout={display!.layout} />
      ) : (
        <div className="display-center display-pairing">
          <MonitorSmartphone size={96} />
          <h1>{display!.name}</h1>
          <p>Gekoppelt. In ELVIS unter „Bildschirme“ Inhalte zuweisen.</p>
        </div>
      )}
      {identify && <div className="display-identify">{display!.name}</div>}
      {connection === 'offline' && <div className="display-offline">Verbindung zu ELVIS unterbrochen …</div>}
    </div>
  );
}
