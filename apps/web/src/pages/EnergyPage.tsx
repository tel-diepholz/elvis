import { BatteryCharging, Bluetooth } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { VICTRON_BALANCER_LABELS, VICTRON_READOUT_LABELS, VICTRON_STATE_LABELS, type BluetoothDeviceLive, type VictronCellVoltage, type VictronReadout } from '@elvis/shared';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtMinutes, fmtNum, fmtOpt, fmtTime } from '../lib/format';
import { useDevice } from '../lib/live';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { Badge, Card, EmptyState, Meter, PageHeader, Stat, type Tone } from '../components/ui';

const state = (s: number | null) => (s === null ? '–' : (VICTRON_STATE_LABELS[s] ?? `Zustand ${s}`));

type LithiumReadout = Extract<VictronReadout, { type: 'lithium' }>;

/** Füllhöhe einer Zelle: LiFePO4 von 2,80 V (leer) bis 3,65 V (voll) – zeigt die Spannung, nicht den Ladezustand */
const CELL_EMPTY_V = 2.8;
const CELL_FULL_V = 3.65;
/** Außerhalb davon ist die Zelle fast leer bzw. voll (Warnung); „low“/„high“ meldet die Batterie selbst (Alarm) */
const CELL_WARN_LOW_V = 3.0;
const CELL_WARN_HIGH_V = 3.6;
/** Ab diesem Abstand zwischen höchster und niedrigster Zelle fällt der Ausgleich auf */
const SPREAD_WARN_V = 0.05;

const cellTone = (c: VictronCellVoltage): Tone => (typeof c !== 'number' ? 'alarm' : c < CELL_WARN_LOW_V || c > CELL_WARN_HIGH_V ? 'warn' : 'ok');
const cellFill = (c: VictronCellVoltage) => (c === 'low' ? 0 : c === 'high' ? 100 : Math.max(0, Math.min(100, ((c - CELL_EMPTY_V) / (CELL_FULL_V - CELL_EMPTY_V)) * 100)));
const cellLabel = (c: VictronCellVoltage) => (c === 'low' ? '< 2,61' : c === 'high' ? '> 3,85' : fmtNum(c, 2));

/** Lithium Battery Smart als Batterieblock: je Zelle eine Säule, Füllhöhe nach Zellspannung */
function BatteryPack({ r, warnBelowV }: { r: LithiumReadout; warnBelowV: number | null }) {
  const volts = r.cells.filter((c): c is number => typeof c === 'number');
  const min = volts.length > 1 ? Math.min(...volts) : null;
  const max = volts.length > 1 ? Math.max(...volts) : null;
  const spread = min !== null && max !== null ? max - min : null;
  const vTone: Tone | undefined = r.voltageV !== null && warnBelowV !== null && r.voltageV < warnBelowV ? 'warn' : undefined;
  return (
    <>
      <div className="battery" role="img" aria-label={`Zellen: ${r.cells.map(cellLabel).join(', ')} V`}>
        <div className="battery-cells" style={{ '--cells': Math.max(r.cells.length, 1) } as CSSProperties}>
          {r.cells.length === 0 && <p className="muted battery-empty">Keine Zellwerte</p>}
          {r.cells.map((c, i) => (
            <div key={i} className={`battery-cell tone-${cellTone(c)}`}>
              <div className="battery-cell-fill" style={{ height: `${cellFill(c)}%` }} />
              <span className="battery-cell-no">Zelle {i + 1}</span>
              <span className="battery-cell-v">
                {cellLabel(c)}
                <small>V</small>
              </span>
              {spread !== null && spread > 0 && (c === min || c === max) && <span className="battery-cell-tag">{c === min ? 'min' : 'max'}</span>}
            </div>
          ))}
        </div>
        <div className="battery-terminal" />
      </div>
      <div className="battery-stats">
        <Stat label="Spannung" value={fmtOpt(r.voltageV, 2)} unit="V" tone={vTone} />
        <Stat label="Temperatur" value={fmtOpt(r.temperatureC, 0)} unit="°C" />
        <Stat label="Zelldifferenz" value={spread === null ? '–' : Math.round(spread * 1000)} unit="mV" tone={spread !== null && spread >= SPREAD_WARN_V ? 'warn' : undefined} />
        <Stat
          label="Ausgleich"
          value={<span className="battery-balancer">{r.balancer ? VICTRON_BALANCER_LABELS[r.balancer] : '–'}</span>}
          tone={r.balancer === 'imbalance' ? 'warn' : r.balancer === 'balancing' ? 'info' : undefined}
        />
      </div>
      {r.errorFlags !== 0 && (
        <p className="tone-alarm">
          Batteriefehler <span className="mono">0x{r.errorFlags.toString(16)}</span>
        </p>
      )}
    </>
  );
}

function Readout({ r, warnBelowV }: { r: VictronReadout; warnBelowV: number | null }) {
  if (r.type === 'lithium') return <BatteryPack r={r} warnBelowV={warnBelowV} />;
  const vTone = (v: number | null): Tone | undefined => (v !== null && warnBelowV !== null && v < warnBelowV ? 'warn' : undefined);
  switch (r.type) {
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

function DeviceCard({ d }: { d: BluetoothDeviceLive }) {
  return (
    <Card title={d.name} icon={<BatteryCharging size={18} />} actions={<DeviceBadge d={d} />}>
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
  );
}

/** Akkus, Laderegler und Ladegeräte im Fahrzeug (live vom Modul „Bluetooth“) */
export function EnergyPage() {
  const bt = useDevice('bluetooth');
  const user = useAuth().user;
  if (!bt) return <ModuleDisabled name="Bluetooth" module="bluetooth" />;
  const { devices, adapter } = bt.state;
  const packs = devices.filter((d) => d.readout?.type === 'lithium');
  const others = devices.filter((d) => d.readout?.type !== 'lithium');

  return (
    <>
      <PageHeader title="Energie" subtitle={adapter.scanning ? `Bluetooth (${adapter.name})` : adapter.error ? <span className="tone-alarm">{adapter.error}</span> : 'Bluetooth wird gestartet …'} />
      {devices.length === 0 ? (
        <EmptyState icon={<Bluetooth size={32} />} title="Keine Geräte eingetragen">
          {user?.isAdmin ? (
            <>
              Akkus und andere Bluetooth-Geräte unter <Link to="/einstellungen#modul-bluetooth">Einstellungen → Bluetooth</Link> hinzufügen.
            </>
          ) : (
            'Ein Admin kann die Geräte in den Einstellungen eintragen.'
          )}
        </EmptyState>
      ) : (
        <>
          {packs.length > 0 && (
            <div className="energy-packs">
              {packs.map((d) => (
                <DeviceCard key={d.id} d={d} />
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div className="grid">
              {others.map((d) => (
                <DeviceCard key={d.id} d={d} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
