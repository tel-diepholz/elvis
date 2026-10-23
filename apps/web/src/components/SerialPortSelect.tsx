import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

const CUSTOM = '__custom__';

/** Auswahl einer seriellen Schnittstelle aus den am Server erkannten Geräten, alternativ freier Pfad. */
export function SerialPortSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const { data: ports = [], isFetching, refetch, error } = useQuery({ queryKey: ['serialports'], queryFn: api.serialPorts, staleTime: 10_000 });
  const known = ports.some((p) => p.path === value || p.device === value);
  const [custom, setCustom] = useState(false);

  return (
    <div className="serialport">
      <div className="serialport-row">
        <select
          value={custom ? CUSTOM : value}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          {!value && !custom && <option value="">– Schnittstelle wählen –</option>}
          {ports.map((p) => (
            <option key={p.path} value={p.path} title={p.path}>
              {p.label}
            </option>
          ))}
          {value && !known && !custom && <option value={value}>{value} (eigener Pfad bzw. nicht erkannt)</option>}
          <option value={CUSTOM}>Eigener Pfad …</option>
        </select>
        <button type="button" className="btn btn-icon" title="Schnittstellen neu einlesen" aria-label="Schnittstellen neu einlesen" disabled={disabled || isFetching} onClick={() => void refetch()}>
          <RefreshCw size={16} className={isFetching ? 'spin' : undefined} />
        </button>
      </div>
      {custom && <input value={value} placeholder="/dev/serial/by-id/… oder /dev/ttyUSB0" disabled={disabled} onChange={(e) => onChange(e.target.value.trim())} />}
      {!custom && value && known && <span className="field-hint mono">{value}</span>}
      {error && <span className="field-error">Schnittstellen konnten nicht gelesen werden: {(error as Error).message}</span>}
      {!error && !isFetching && ports.length === 0 && <span className="field-hint">Keine seriellen Schnittstellen gefunden – Gateway angesteckt? Im Container das Gerät durchreichen.</span>}
    </div>
  );
}
