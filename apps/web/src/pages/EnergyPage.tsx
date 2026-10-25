import { BatteryCharging, Bluetooth } from 'lucide-react';
import { Link } from 'react-router-dom';
import { VICTRON_BALANCER_LABELS, VICTRON_READOUT_LABELS, VICTRON_STATE_LABELS, type BluetoothDeviceLive, type VictronReadout } from '@elvis/shared';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtMinutes, fmtNum, fmtOpt, fmtTime } from '../lib/format';
import { useDevice } from '../lib/live';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { Badge, Card, EmptyState, Meter, PageHeader, Stat, type Tone } from '../components/ui';

const state = (s: number | null) => (s === null ? '–' : (VICTRON_STATE_LABELS[s] ?? `Zustand ${s}`));

function Readout({ r, warnBelowV }: { r: VictronReadout; warnBelowV: number | null }) {
  const vTone = (v: number | null): Tone | undefined => (v !== null && warnBelowV !== null && v < warnBelowV ? 'warn' : undefined);
  switch (r.type) {
    case 'lithium':
      return (
        <>
          <div className="grid-2">
            <Stat label="Spannung" value={fmtOpt(r.voltageV, 2)} unit="V" tone={vTone(r.voltageV)} />
            <Stat label="Temperatur" value={fmtOpt(r.temperatureC, 0)} unit="°C" />
          </div>
          {r.cells.length > 0 && (
            <dl className="kv">
              <dt>Zellen</dt>
              <dd className="mono">
                {r.cells.map((c, i) => (
                  <span key={i} className={typeof c === 'number' ? undefined : 'tone-alarm'}>
                    {i > 0 && ' · '}
                    {c === 'low' ? '< 2,61' : c === 'high' ? '> 3,85' : fmtNum(c, 2)}
                  </span>
                ))}{' '}
                V
              </dd>
              <dt>Ausgleich</dt>
              <dd className={r.balancer === 'imbalance' ? 'tone-warn' : undefined}>{r.balancer ? VICTRON_BALANCER_LABELS[r.balancer] : '–'}</dd>
              {r.errorFlags !== 0 && (
                <>
                  <dt>Fehler</dt>
                  <dd className="tone-alarm mono">0x{r.errorFlags.toString(16)}</dd>
                </>
              )}
            </dl>
          )}
        </>
      );
    case 'battery-monitor':
      return (
        <>
          {r.socPct !== null && <Meter value={r.socPct} tone={r.socPct < 20 ? 'alarm' : r.socPct < 40 ? 'warn' : 'ok'} label="Ladezustand" />}
          <div className="grid-2">
            <Stat label="Ladezustand" value={fmtOpt(r.socPct, 0)} unit="%" />
            <Stat label="Spannung" value={fmtOpt(r.voltageV, 2)} unit="V" tone={vTone(r.voltageV)} />
            <Stat label="Strom" value={fmtOpt(r.currentA, 1)} unit="A" sub={r.currentA === null ? undefined : r.currentA < 0 ? 'Entladen' : r.currentA > 0 ? 'Laden' : undefined} />
            <Stat label="Restlaufzeit" value={r.remainingMin === null ? '–' : fmtMinutes(r.remainingMin)} />
          </div>
          <dl className="kv">
            <dt>Entnommen</dt>
            <dd>{fmtOpt(r.consumedAh, 1)} Ah</dd>
            {r.starterVoltageV !== null && (
              <>
                <dt>Starterbatterie</dt>
                <dd>{fmtNum(r.starterVoltageV, 2)} V</dd>
              </>
            )}
            {r.temperatureC !== null && (
              <>
                <dt>Temperatur</dt>
                <dd>{fmtNum(r.temperatureC, 1)} °C</dd>
              </>
            )}
            {r.alarms.length > 0 && (
              <>
                <dt>Alarme</dt>
                <dd className="tone-alarm">{r.alarms.join(', ')}</dd>
              </>
            )}
          </dl>
        </>
      );
    case 'solar':
      return (
        <div className="grid-2">
          <Stat label="Solarleistung" value={fmtOpt(r.pvPowerW, 0)} unit="W" />
          <Stat label="Ladestrom" value={fmtOpt(r.currentA, 1)} unit="A" sub={state(r.state)} />
          <Stat label="Batteriespannung" value={fmtOpt(r.voltageV, 2)} unit="V" tone={vTone(r.voltageV)} />
          <Stat label="Ertrag heute" value={r.yieldTodayWh === null ? '–' : fmtNum(r.yieldTodayWh / 1000, 2)} unit="kWh" />
        </div>
      );
    case 'dcdc':
      return (
        <div className="grid-2">
          <Stat label="Eingang" value={fmtOpt(r.inputVoltageV, 2)} unit="V" />
          <Stat label="Ausgang" value={fmtOpt(r.outputVoltageV, 2)} unit="V" sub={state(r.state)} />
        </div>
      );
    case 'ac-charger':
      return (
        <div className="grid-2">
          {r.outputs.map((o, i) => (
            <Stat key={i} label={r.outputs.length > 1 ? `Ausgang ${i + 1}` : 'Ausgang'} value={fmtNum(o.voltageV, 2)} unit="V" sub={o.currentA === null ? undefined : `${fmtNum(o.currentA, 1)} A`} />
          ))}
          <Stat label="Zustand" value={state(r.state)} sub={r.temperatureC === null ? undefined : `${r.temperatureC} °C`} />
        </div>
      );
    default:
      return <p className="muted">Dieses Victron-Gerät sendet Werte, die ELVIS noch nicht anzeigt (Typ {r.readoutType}).</p>;
  }
}

function DeviceBadge({ d }: { d: BluetoothDeviceLive }) {
  if (d.stale) return <Badge tone="warn">kein Empfang</Badge>;
  if (d.error) return <Badge tone="warn">{d.error}</Badge>;
  if (!d.readout) return <Badge>warte auf Daten</Badge>;
  return <Badge tone="ok">{VICTRON_READOUT_LABELS[d.readout.type]}</Badge>;
}

/** Akkus, Laderegler und Ladegeräte im Fahrzeug (live vom Modul „Bluetooth“) */
export function EnergyPage() {
  const bt = useDevice('bluetooth');
  const user = useAuth().user;
  if (!bt) return <ModuleDisabled name="Bluetooth" />;
  const { devices, adapter } = bt.state;

  return (
    <>
      <PageHeader title="Energie" subtitle={adapter.scanning ? `Bluetooth (${adapter.name})` : adapter.error ? <span className="tone-alarm">{adapter.error}</span> : 'Bluetooth wird gestartet …'} />
      {devices.length === 0 ? (
        <EmptyState icon={<Bluetooth size={32} />} title="Keine Geräte eingetragen">
          {user?.isAdmin ? (
            <>
              Akkus und andere Bluetooth-Geräte unter <Link to="/system">System → Bluetooth-Geräte</Link> hinzufügen.
            </>
          ) : (
            'Ein Admin kann die Geräte in den Systemeinstellungen eintragen.'
          )}
        </EmptyState>
      ) : (
        <div className="grid">
          {devices.map((d) => (
            <Card key={d.id} title={d.name} icon={<BatteryCharging size={18} />} actions={<DeviceBadge d={d} />}>
              {d.readout ? (
                <div className={d.stale ? 'energy-readout stale' : 'energy-readout'}>
                  <Readout r={d.readout} warnBelowV={d.warnBelowV} />
                </div>
              ) : (
                <p className="muted">{d.stale ? 'Seit dem Start nichts empfangen – Adresse, Schlüssel und Reichweite prüfen.' : 'Noch keine Werte empfangen.'}</p>
              )}
              <p className="cell-sub">
                {[d.advertisedName !== d.name ? d.advertisedName : null, d.rssi !== null && !d.stale ? `${d.rssi} dBm` : null, d.seenAt ? (d.stale ? `zuletzt ${fmtDateTime(d.seenAt)}` : `empfangen ${fmtTime(d.seenAt)}`) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
