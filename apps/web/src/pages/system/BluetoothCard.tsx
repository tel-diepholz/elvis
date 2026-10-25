import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Bluetooth, Pencil, Plus, Trash2 } from 'lucide-react';
import { BLUETOOTH_KIND_LABELS, bluetoothSummary, type BluetoothDeviceConfig, type BluetoothDeviceInput, type BluetoothNearby } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import { useDevice } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Modal, Toggle } from '../../components/ui';

const EMPTY: BluetoothDeviceInput = { name: '', kind: 'victron', address: '', key: '', warnBelowV: null, enabled: true };

function DeviceDialog({ device, preset, onClose }: { device: BluetoothDeviceConfig | null; preset: Partial<BluetoothDeviceInput>; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<BluetoothDeviceInput>(device ? { name: device.name, kind: device.kind, address: device.address, key: device.key, warnBelowV: device.warnBelowV, enabled: device.enabled } : { ...EMPTY, ...preset });
  const [warn, setWarn] = useState(device?.warnBelowV === null || device?.warnBelowV === undefined ? '' : String(device.warnBelowV).replace('.', ','));
  const set = <K extends keyof BluetoothDeviceInput>(k: K, value: BluetoothDeviceInput[K]) => setV({ ...v, [k]: value });
  const key = v.key.replace(/\s/g, '');
  const warnValue = warn.trim() === '' ? null : Number(warn.replace(',', '.'));
  const valid = v.name.trim() !== '' && v.address.replace(/[^0-9a-fA-F]/g, '').length === 12 && /^[0-9a-fA-F]{32}$/.test(key) && (warnValue === null || Number.isFinite(warnValue));

  const save = useMutation({
    mutationFn: () => {
      const input = { ...v, warnBelowV: warnValue };
      return device ? api.updateBluetoothDevice(device.id, input) : api.createBluetoothDevice(input);
    },
    onSuccess: (d) => (toast('success', `„${d.name}“ gespeichert`), onClose()),
    onError: (e) => toast('error', e.message),
  });

  return (
    <Modal open title={device ? `Bluetooth-Gerät „${device.name}“` : 'Bluetooth-Gerät hinzufügen'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Name">
          <input value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={60} placeholder="z. B. Akku links" autoFocus />
        </Field>
        <Field label="Geräteart">
          <select value={v.kind} onChange={(e) => set('kind', e.target.value as BluetoothDeviceInput['kind'])}>
            {Object.entries(BLUETOOTH_KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bluetooth-Adresse" hint="Steht in VictronConnect unter Produktinfo – oder aus „In der Nähe gefunden“ übernehmen">
          <input className="mono" value={v.address} onChange={(e) => set('address', e.target.value)} placeholder="C8:2E:47:12:34:56" />
        </Field>
        <Field label="Schlüssel (Instant Readout)" hint="VictronConnect → Gerät → Einstellungen (Zahnrad) → ⋮ → Produktinfo → Instant Readout über Bluetooth einschalten → Verschlüsselungsdaten anzeigen">
          <input className="mono" value={v.key} onChange={(e) => set('key', e.target.value)} placeholder="32 Hex-Zeichen" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Warnung unter (V)" hint="Optional, z. B. 12,4 für einen 12-V-LiFePO4-Akku. Leer = nur die Alarme des Geräts">
          <input inputMode="decimal" value={warn} onChange={(e) => setWarn(e.target.value)} placeholder="z. B. 12,4" />
        </Field>
        <Toggle label="Gerät aktiv" checked={v.enabled} onChange={(on) => set('enabled', on)} />
      </div>
      <p className="field-hint">ELVIS koppelt sich nicht mit dem Gerät, sondern liest nur mit, was es ohnehin aussendet. VictronConnect kann weiter parallel genutzt werden.</p>
      <div className="form-actions">
        <span className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>
    </Modal>
  );
}

/** Bluetooth-Geräte (Akkus, Laderegler …), deren Werte das Modul „Bluetooth“ mitliest – nur Admins. */
export function BluetoothCard() {
  const toast = useToast();
  const { data: devices } = useQuery({ queryKey: ['bluetooth'], queryFn: api.bluetoothDevices });
  const live = useDevice('bluetooth');
  const [editing, setEditing] = useState<{ device: BluetoothDeviceConfig | null; preset: Partial<BluetoothDeviceInput> } | null>(null);
  const remove = useMutation({ mutationFn: api.removeBluetoothDevice, onError: (e) => toast('error', e.message) });
  const reorder = useMutation({ mutationFn: api.reorderBluetoothDevices, onError: (e) => toast('error', e.message) });
  const move = (i: number, d: -1 | 1) => {
    if (!devices) return;
    const ids = devices.map((x) => x.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };
  const liveOf = (id: string) => live?.state.devices.find((d) => d.id === id);
  const nearby = (live?.state.nearby ?? []).filter((n) => !n.configured);
  const adopt = (n: BluetoothNearby) => setEditing({ device: null, preset: { kind: n.kind, address: n.address, name: n.name ?? '' } });

  return (
    <Card
      title="Bluetooth-Geräte"
      icon={<Bluetooth size={18} />}
      className="span-3"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setEditing({ device: null, preset: {} })}>
          <Plus size={16} /> Gerät hinzufügen
        </button>
      }
    >
      {!live ? (
        <p className="muted">Das Modul ist deaktiviert – oben unter „Modul aktiv“ einschalten.</p>
      ) : live.state.adapter.error ? (
        <p className="tone-alarm">{live.state.adapter.error}</p>
      ) : null}
      {!devices ? (
        <Loading />
      ) : devices.length === 0 ? (
        <p className="muted">Noch keine Geräte. Victron-Geräte (Lithium-Batterien, SmartShunt, MPPT, Orion, Ladegeräte) senden ihre Werte per Bluetooth – dafür in VictronConnect „Instant Readout“ einschalten.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Adresse</th>
                <th>Empfang</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((d, i) => {
                const l = liveOf(d.id);
                return (
                  <tr key={d.id} className={d.enabled ? '' : 'row-muted'}>
                    <td>
                      <div className="cell-title">{d.name}</div>
                      <div className="cell-sub">{BLUETOOTH_KIND_LABELS[d.kind]}</div>
                    </td>
                    <td className="mono">{d.address}</td>
                    <td>
                      {!d.enabled ? (
                        <Badge>deaktiviert</Badge>
                      ) : !l ? (
                        <Badge>–</Badge>
                      ) : l.stale ? (
                        <Badge tone="warn">kein Empfang</Badge>
                      ) : l.error ? (
                        <Badge tone="alarm">{l.error}</Badge>
                      ) : l.readout ? (
                        <Badge tone="ok">{bluetoothSummary(l) ?? 'empfangen'}</Badge>
                      ) : (
                        <Badge>warte auf Daten</Badge>
                      )}
                      {l?.seenAt && <div className="cell-sub">{`${fmtTime(l.seenAt)}${l.rssi !== null ? ` · ${l.rssi} dBm` : ''}`}</div>}
                    </td>
                    <td>
                      <span className="btn-row">
                        <button type="button" className="btn btn-icon" aria-label="nach oben" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                          <ArrowUp size={16} />
                        </button>
                        <button type="button" className="btn btn-icon" aria-label="nach unten" disabled={i === devices.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                          <ArrowDown size={16} />
                        </button>
                        <button type="button" className="btn btn-icon" aria-label={`${d.name} bearbeiten`} onClick={() => setEditing({ device: d, preset: {} })}>
                          <Pencil size={16} />
                        </button>
                        <button type="button" className="btn btn-icon" aria-label={`${d.name} entfernen`} disabled={remove.isPending} onClick={() => window.confirm(`„${d.name}“ entfernen?`) && remove.mutate(d.id)}>
                          <Trash2 size={16} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {nearby.length > 0 && (
        <>
          <h3 className="section-title">In der Nähe gefunden</h3>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {nearby.map((n) => (
                  <tr key={n.address}>
                    <td>
                      <div className="cell-title">{n.name ?? 'ohne Namen'}</div>
                      <div className="cell-sub">{n.type}</div>
                    </td>
                    <td className="mono">{n.address}</td>
                    <td className="cell-sub">{`${n.rssi ?? '–'} dBm · ${fmtTime(n.seenAt)}`}</td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => adopt(n)}>
                        <Plus size={16} /> Übernehmen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && <DeviceDialog device={editing.device} preset={editing.preset} onClose={() => setEditing(null)} />}
    </Card>
  );
}
