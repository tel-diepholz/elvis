import { useEffect, useState } from 'react';
import { History, Loader2, X } from 'lucide-react';
import { fmtDate, fmtTime } from '../../lib/format';

const MINUTE = 60_000;

/** Wert erst übernehmen, wenn er sich eine Weile nicht mehr ändert (Schieberegler ziehen erzeugt viele Zwischenwerte) */
export function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function ago(at: Date, now: Date): string {
  const min = Math.round((now.getTime() - at.getTime()) / MINUTE);
  if (min < 60) return `vor ${min} min`;
  const h = Math.floor(min / 60);
  return `vor ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/**
 * Zeitstrahl der Lagekarte: Schieberegler vom Einsatzbeginn bis jetzt in Minutenschritten. at = null heißt live; ganz
 * rechts springt der Regler zurück auf live.
 */
export function TimelineBar({
  startedAt,
  now,
  at,
  loading,
  onChange,
  onClose,
}: {
  startedAt: string;
  now: Date;
  at: string | null;
  loading: boolean;
  onChange: (at: string | null) => void;
  onClose: () => void;
}) {
  const start = new Date(startedAt).getTime();
  const max = Math.max(1, Math.floor((now.getTime() - start) / MINUTE));
  const value = at ? Math.min(max, Math.round((new Date(at).getTime() - start) / MINUTE)) : max;
  const set = (minutes: number) => onChange(minutes >= max ? null : new Date(start + Math.max(0, minutes) * MINUTE).toISOString());
  const shown = at ? new Date(at) : now;
  const sameDay = fmtDate(shown) === fmtDate(now);
  return (
    <div className={`map-overlay map-timeline ${at ? 'past' : ''}`} role="group" aria-label="Zeitstrahl der Lage">
      <History size={16} aria-hidden />
      <button type="button" className="btn btn-sm" onClick={() => set(value - 15)} disabled={value <= 0} title="15 Minuten zurück">
        −15
      </button>
      <input
        type="range"
        className="map-radar-slider"
        min={0}
        max={max}
        value={value}
        aria-label="Zeitpunkt der Lage"
        aria-valuetext={at ? `${fmtTime(shown)}, ${ago(shown, now)}` : 'live'}
        onChange={(e) => set(Number(e.target.value))}
      />
      <button type="button" className="btn btn-sm" onClick={() => set(value + 15)} disabled={!at} title="15 Minuten vor">
        +15
      </button>
      <span className="map-timeline-time" aria-live="polite">
        {at ? (
          <>
            <strong>
              {sameDay ? '' : `${fmtDate(shown)} `}
              {fmtTime(shown)}
            </strong>{' '}
            <span>{ago(shown, now)}</span>
          </>
        ) : (
          <strong>Live</strong>
        )}
        {loading && <Loader2 size={14} className="spin" aria-label="Lage wird geladen" />}
      </span>
      <button type="button" className="btn btn-sm" onClick={() => onChange(null)} disabled={!at}>
        Jetzt
      </button>
      <button type="button" className="btn btn-sm btn-icon btn-ghost" onClick={onClose} aria-label="Zeitstrahl schließen" title="Zeitstrahl schließen">
        <X size={16} />
      </button>
    </div>
  );
}
