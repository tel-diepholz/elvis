import { useState, type FormEvent } from 'react';
import { Smartphone } from 'lucide-react';
import { APP_POSITION_STALE_MS, formatDeviceId, pairInputSchema, type AppLink, type PairInput } from '@elvis/shared';
import { fmtAgo } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { Field } from '../../components/ui';

/** Gekoppelte App unter dem Namen der Einheit: wann zuletzt geortet, wie genau, Akku */
export function AppLinkInfo({ link }: { link: AppLink }) {
  const now = useNow();
  const stale = !link.lastPositionAt || now.getTime() - new Date(link.lastPositionAt).getTime() > APP_POSITION_STALE_MS;
  const parts = [
    link.lastPositionAt ? `Position ${fmtAgo(link.lastPositionAt, now)}` : 'noch keine Position',
    link.accuracyM !== null && link.lastPositionAt ? `±${Math.round(link.accuracyM)} m` : null,
    link.battery !== null ? `Akku ${Math.round(link.battery * 100)} %` : null,
  ].filter(Boolean);
  return (
    <div className={`cell-sub app-link-info ${stale ? 'stale' : ''}`} title={`App ${formatDeviceId(link.deviceId)}, gekoppelt von ${link.pairedBy}`}>
      <Smartphone size={13} /> App · {parts.join(' · ')}
    </div>
  );
}

/** ID und Code aus der App eingeben */
export function PairAppForm({ unitName, pending, onSubmit }: { unitName: string; pending: boolean; onSubmit: (input: PairInput) => void }) {
  const [deviceId, setDeviceId] = useState('');
  const [code, setCode] = useState('');
  const parsed = pairInputSchema.safeParse({ deviceId, code });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (parsed.success) onSubmit(parsed.data);
  };
  return (
    <form className="form" onSubmit={submit}>
      <p className="muted">
        Die ELVIS-App zeigt nach dem Start eine App-ID und einen Code. Damit sendet sie ihre Position, bis {unitName} entkoppelt, entlassen oder der Einsatz
        beendet wird.
      </p>
      <Field label="App-ID" hint="8 Zeichen, z. B. K7M2-QX9P">
        <input className="mono" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} autoFocus autoComplete="off" spellCheck={false} maxLength={12} />
      </Field>
      <Field label="Code" hint="6 Ziffern">
        <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} />
      </Field>
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={!parsed.success || pending}>
          <Smartphone size={18} /> Koppeln
        </button>
      </div>
    </form>
  );
}
