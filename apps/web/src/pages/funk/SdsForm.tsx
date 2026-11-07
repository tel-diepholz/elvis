import { useState } from 'react';
import type { RadioDevice } from '@elvis/shared';
import { useCommand } from '../../lib/hooks';

/** Einfaches Formular: SDS an eine ISSI über ein Funkgerät. Die Anlage meldet die Zustellung nicht zurück. */
export function SdsForm({ devices }: { devices: RadioDevice[] }) {
  const { send, pending } = useCommand('radio');
  const online = devices.filter((d) => d.online);
  const [deviceId, setDeviceId] = useState('');
  const [issi, setIssi] = useState('');
  const [text, setText] = useState('');
  const device = online.find((d) => d.id === deviceId) ?? online[0];
  const valid = !!device && /^\d{1,8}$/.test(issi) && text.trim().length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        send('sds.send', { deviceId: device.id, issi, text: text.trim() });
        setText('');
      }}
      style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}
    >
      <label>
        Funkgerät
        <br />
        <select value={device?.id ?? ''} onChange={(e) => setDeviceId(e.target.value)} disabled={pending || online.length === 0}>
          {online.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Empfänger (ISSI)
        <br />
        <input value={issi} onChange={(e) => setIssi(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={8} placeholder="4221526" />
      </label>
      <label style={{ flex: 1, minWidth: 200 }}>
        Text
        <br />
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={160} style={{ width: '100%' }} />
      </label>
      <button type="submit" className="btn btn-primary" disabled={!valid || pending}>
        Senden
      </button>
    </form>
  );
}
