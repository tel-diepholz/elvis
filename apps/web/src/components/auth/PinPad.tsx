import { useEffect } from 'react';
import { Delete } from 'lucide-react';

/** Vierstellige PIN-Eingabe mit Ziffernblock (Touch) und Tastaturunterstützung. */
export function PinPad({ value, onChange, onComplete, disabled, label = 'PIN' }: { value: string; onChange: (v: string) => void; onComplete?: (pin: string) => void; disabled?: boolean; label?: string }) {
  const press = (d: string) => {
    if (disabled || value.length >= 4) return;
    const next = value + d;
    onChange(next);
    if (next.length === 4) onComplete?.(next);
  };
  const back = () => !disabled && onChange(value.slice(0, -1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="pinpad" aria-label={label}>
      <div className="pin-dots" role="status" aria-label={`${value.length} von 4 Ziffern`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`pin-dot ${i < value.length ? 'filled' : ''}`} />
        ))}
      </div>
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className="pin-key" onClick={() => press(d)} disabled={disabled}>
            {d}
          </button>
        ))}
        <span />
        <button type="button" className="pin-key" onClick={() => press('0')} disabled={disabled}>
          0
        </button>
        <button type="button" className="pin-key pin-key-muted" onClick={back} disabled={disabled} aria-label="Ziffer löschen">
          <Delete size={22} />
        </button>
      </div>
    </div>
  );
}
