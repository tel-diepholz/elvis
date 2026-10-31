import type { DeviceSnapshot, RadioDevice } from '@elvis/shared';
import { FMS_STATUS } from '@elvis/shared';
import { useCommand } from '../../lib/hooks';
import { fmtTime } from '../../lib/format';
import { Badge, Dot } from '../../components/ui';

function rssiTone(rssi: number | null) {
  if (rssi === null) return 'muted' as const;
  return rssi > -85 ? ('ok' as const) : rssi > -98 ? ('warn' as const) : ('alarm' as const);
}

function RadioRow({ radio, d, cols }: { radio: DeviceSnapshot<'radio'>; d: RadioDevice; cols: Cols }) {
  const { send, pending } = useCommand('radio');
  const { talkgroupSwitch, statusSet } = radio.state.capabilities;
  const activity = d.transmitting ? 'TX' : d.receiving ? 'RX' : null;
  const tgName = radio.state.talkgroups.find((t) => t.id === d.talkgroupId)?.name ?? '–';
  return (
    <tr className={d.online ? '' : 'row-muted'}>
      <td>
        <div className="cell-title">
          <Dot tone={d.online ? 'ok' : 'alarm'} />
          {d.name}
        </div>
        <div className="cell-sub">
          {d.type}
          {d.issi ? ` · ISSI ${d.issi}` : ''}
          {d.workplace ? ` · ${d.workplace}` : ''}
        </div>
      </td>
      {cols.talkgroup && (
        <td>
          {d.type === 'HRT' || !talkgroupSwitch ? (
            tgName
          ) : (
            <select
              value={d.talkgroupId}
              disabled={pending || !d.online}
              onChange={(e) =>
                send('talkgroup.set', {
                  deviceId: d.id,
                  talkgroupId: e.target.value,
                })
              }
              aria-label={`Rufgruppe ${d.name}`}
            >
              {radio.state.talkgroups.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.mode})
                </option>
              ))}
            </select>
          )}
        </td>
      )}
      <td>
        <Badge tone={d.mode === 'DMO' ? 'info' : 'muted'}>{d.mode}</Badge>
      </td>
      {cols.rssi && (
        <td>
          <span className={`tone-${rssiTone(d.rssiDbm)}`}>{d.rssiDbm !== null ? `${d.rssiDbm} dBm` : '–'}</span>
        </td>
      )}
      <td>
        {activity ? (
          <Badge tone={activity === 'TX' ? 'alarm' : 'ok'}>{activity}</Badge>
        ) : (
          <span className="muted">{d.lastActivity ? fmtTime(d.lastActivity) : '–'}</span>
        )}
      </td>
      <td>
        {d.type === 'MRT' && statusSet ? (
          <select
            value={d.fmsStatus ?? ''}
            disabled={pending || !d.online}
            onChange={(e) =>
              send('status.set', {
                deviceId: d.id,
                status: Number(e.target.value),
              })
            }
            aria-label="Fahrzeugstatus"
          >
            {[1, 2, 3, 4, 6].map((s) => (
              <option key={s} value={s}>
                {s} – {FMS_STATUS[s]!.label}
              </option>
            ))}
          </select>
        ) : d.fmsStatus !== null ? (
          `${d.fmsStatus} – ${FMS_STATUS[d.fmsStatus]?.label ?? ''}`
        ) : (
          <span className="muted">–</span>
        )}
      </td>
    </tr>
  );
}

interface Cols {
  talkgroup: boolean;
  rssi: boolean;
}

export function RadioTable({ radio }: { radio: DeviceSnapshot<'radio'> }) {
  // Spalten ohne Daten (z. B. liefert die Reichert ZBE weder Rufgruppe noch Pegel) ausblenden
  const cols: Cols = {
    talkgroup: radio.state.talkgroups.length > 0,
    rssi: radio.state.devices.some((d) => d.rssiDbm !== null) || radio.driver === 'sim',
  };
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Gerät</th>
            {cols.talkgroup && <th>Rufgruppe</th>}
            <th>Modus</th>
            {cols.rssi && <th>Pegel</th>}
            <th>Aktivität</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {radio.state.devices.map((d) => (
            <RadioRow key={d.id} radio={radio} d={d} cols={cols} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
