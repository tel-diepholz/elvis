import { useEffect, useState } from 'react';
import { RefreshCw, Zap } from 'lucide-react';
import { INVERTER_MODE_LABELS, INVERTER_STATE_LABELS, inverterAlarms, type DeviceSnapshot, type InverterLeds, type InverterMode, type InverterOpState } from '@elvis/shared';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtNum, fmtOpt } from '../../lib/format';
import { useCommand } from '../../lib/hooks';
import { Badge, Card, Segmented, Stat, type Tone } from '../../components/ui';

const MODES: InverterMode[] = ['on', 'charger-only', 'inverter-only', 'off'];

const LED_LABELS: Record<keyof InverterLeds, string> = {
  mains: 'Netz',
  bulk: 'Bulk',
  absorption: 'Absorption',
  float: 'Float',
  inverter: 'Wechselrichter',
  overload: 'Überlast',
  lowBattery: 'Batterie niedrig',
  temperature: 'Temperatur',
};

function stateTone(s: InverterOpState | null): Tone {
  if (s === null) return 'muted';
  if (s === 'down') return 'alarm';
  if (s === 'off') return 'muted';
  if (s === 'invert' || s === 'aes' || s === 'power-assist') return 'warn';
  return 'ok';
}

/** Landstrom-Begrenzung: Zahl eingeben, mit „Setzen“ übernehmen */
function ShoreLimit({ value, min, max, disabled, onSet }: { value: number | null; min: number | null; max: number | null; disabled: boolean; onSet: (a: number) => void }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  const n = Number(draft.replace(',', '.'));
  const valid = draft !== '' && Number.isFinite(n) && (min === null || n >= min) && (max === null || n <= max);
  return (
    <form
      className="inverter-limit"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSet(Math.round(n * 10) / 10);
      }}
    >
      <label className="field">
        <span className="field-label">Landstrom-Begrenzung</span>
        <span className="inverter-limit-row">
          <input type="number" inputMode="decimal" step={0.5} min={min ?? 0} max={max ?? undefined} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} aria-label="Landstrom-Begrenzung in Ampere" />
          <span className="muted">A</span>
          <button className="btn btn-sm" type="submit" disabled={disabled || !valid || n === value}>
            Setzen
          </button>
        </span>
        {min !== null && max !== null && (
          <span className="field-hint">
            {fmtNum(min, 1)} bis {fmtNum(max, 1)} A – nach der Absicherung des Landstromanschlusses
          </span>
        )}
      </label>
    </form>
  );
}

/** MultiPlus/Quattro am VE.Bus: Betriebsart, Landstrom, Ausgang, Batterie, Geräte am Bus */
export function InverterCard({ snap }: { snap: DeviceSnapshot<'inverter'> }) {
  const s = snap.state;
  const loggedIn = !!useAuth().user;
  const { send, pending } = useCommand('inverter');
  const connected = s.link.connected && snap.online;
  const canControl = loggedIn && connected && s.devices.length > 0 && !pending;
  const alarms = inverterAlarms(s.leds);
  const l1 = s.phases[0];
  const multiPhase = s.phases.length > 1;
  const activeLeds = s.leds ? (Object.keys(LED_LABELS) as (keyof InverterLeds)[]).filter((k) => s.leds![k] !== 'off') : [];

  const setMode = (mode: InverterMode) => {
    if (mode === s.mode) return;
    if (mode === 'off' && !window.confirm('Wechselrichter ausschalten? Die Verbraucher am Ausgang sind dann ohne Strom – auch bei Landstrom.')) return;
    send('mode.set', { mode });
  };

  return (
    <Card
      title="Wechselrichter"
      icon={<Zap size={18} />}
      className="inverter"
      actions={
        connected ? (
          <Badge tone={stateTone(s.opState)}>{s.opState ? INVERTER_STATE_LABELS[s.opState] : 'Zustand unbekannt'}</Badge>
        ) : (
          <Badge tone="alarm">nicht verbunden</Badge>
        )
      }
    >
      {s.link.error && <p className={connected ? 'tone-warn' : 'tone-alarm'}>{s.link.error}</p>}
      {s.remotePanel && (
        <p className="tone-warn">Am VE.Bus ist eine Fernbedienung (z. B. Digital Multi Control) erkannt. Ihr Schalter hat Vorrang – Schalten aus ELVIS kann wirkungslos sein.</p>
      )}
      {alarms.length > 0 && (
        <p className="inverter-alarms">
          {alarms.map((a) => (
            <Badge key={a.id} tone={a.severity}>
              {a.title}
            </Badge>
          ))}
        </p>
      )}

      <div className="inverter-controls">
        <div className="field">
          <span className="field-label">Betriebsart</span>
          <Segmented
            label="Betriebsart"
            value={s.mode ?? ('' as InverterMode)}
            options={MODES.map((m) => ({ value: m, label: INVERTER_MODE_LABELS[m] }))}
            onChange={setMode}
            disabled={!canControl}
          />
          {!loggedIn && <span className="field-hint">Schalten nur nach Anmeldung.</span>}
        </div>
        <ShoreLimit value={s.shoreLimitA} min={s.shoreLimitMinA} max={s.shoreLimitMaxA} disabled={!canControl || !s.mode} onSet={(amps) => send('shore.limit', { amps })} />
      </div>

      {!multiPhase ? (
        <div className="inverter-flow">
          <div>
            <h3 className="section-title">Landstrom</h3>
            <Stat label="Spannung" value={fmtOpt(l1?.acIn.v ?? null, 0)} unit="V" sub={l1?.acIn.hz ? `${fmtNum(l1.acIn.hz, 1)} Hz` : 'kein Landstrom'} />
            <Stat label="Strom" value={fmtOpt(l1?.acIn.a ?? null, 1)} unit="A" />
          </div>
          <div>
            <h3 className="section-title">Ausgang</h3>
            <Stat label="Spannung" value={fmtOpt(l1?.acOut.v ?? null, 0)} unit="V" sub={s.acOutHz ? `${fmtNum(s.acOutHz, 1)} Hz` : 'aus'} />
            <Stat label={s.outputW !== null ? 'Leistung' : 'Strom'} value={s.outputW !== null ? fmtNum(s.outputW, 0) : fmtOpt(l1?.acOut.a ?? null, 1)} unit={s.outputW !== null ? 'W' : 'A'} />
          </div>
          <div>
            <h3 className="section-title">Batterie</h3>
            <Stat label="Spannung" value={fmtOpt(s.dc.v, 2)} unit="V" />
            <Stat label="Strom" value={fmtOpt(s.dc.a, 1)} unit="A" sub={s.dc.a === null || s.dc.a === 0 ? undefined : s.dc.a > 0 ? 'Laden' : 'Entladen'} />
          </div>
        </div>
      ) : (
        <>
          <table className="table inverter-phases">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Landstrom</th>
                <th>Ausgang</th>
              </tr>
            </thead>
            <tbody>
              {s.phases.map((p) => (
                <tr key={p.phase}>
                  <td>{p.phase}</td>
                  <td className="mono">
                    {fmtOpt(p.acIn.v, 0)} V · {fmtOpt(p.acIn.a, 1)} A
                  </td>
                  <td className="mono">
                    {fmtOpt(p.acOut.v, 0)} V · {fmtOpt(p.acOut.a, 1)} A
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid-2">
            <Stat label="Batteriespannung" value={fmtOpt(s.dc.v, 2)} unit="V" />
            <Stat label="Batteriestrom" value={fmtOpt(s.dc.a, 1)} unit="A" />
          </div>
        </>
      )}

      {activeLeds.length > 0 && (
        <p className="inverter-leds" aria-label="LEDs am Gerät">
          {activeLeds.map((k) => (
            <span key={k} className={`inverter-led ${s.leds![k]}`}>
              {LED_LABELS[k]}
            </span>
          ))}
        </p>
      )}

      <details className="inverter-bus">
        <summary>
          VE.Bus: {s.scanning ? 'wird gescannt …' : `${s.devices.length} ${s.devices.length === 1 ? 'Gerät' : 'Geräte'}`} · {s.link.target}
        </summary>
        <dl className="kv">
          {s.devices.map((d) => (
            <div key={d.address} style={{ display: 'contents' }}>
              <dt>Adresse {d.address}</dt>
              <dd>
                {d.role === 'master' ? 'Master' : 'Slave'} · Firmware {d.firmware ?? '–'}
              </dd>
            </div>
          ))}
          <dt>MK3-Interface</dt>
          <dd>{s.link.interfaceVersion ? `Firmware ${s.link.interfaceVersion}` : '–'}</dd>
          <dt>Letzter Scan</dt>
          <dd>{s.lastScanAt ? fmtDateTime(s.lastScanAt) : '–'}</dd>
        </dl>
        {loggedIn && (
          <button className="btn btn-sm" type="button" disabled={!connected || s.scanning || pending} onClick={() => send('bus.scan')}>
            <RefreshCw size={14} /> Bus neu scannen
          </button>
        )}
      </details>
    </Card>
  );
}
