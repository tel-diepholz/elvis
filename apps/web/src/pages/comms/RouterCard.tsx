import { ArrowRight, Cable, CreditCard, Router as RouterIcon, Shuffle } from 'lucide-react';
import type { DeviceSnapshot, FailoverMember, RouterSim, SimStatus, UplinkStatus } from '@elvis/shared';
import { fmtDateTime, fmtOpt } from '../../lib/format';
import { Badge, Card, Meter, type Tone } from '../../components/ui';

const SIM_STATUS: Record<SimStatus, [string, Tone]> = {
  connected: ['verbunden', 'ok'],
  registered: ['im Netz, keine Daten', 'warn'],
  searching: ['sucht Netz', 'warn'],
  standby: ['Reserve', 'muted'],
  'no-sim': ['keine SIM', 'alarm'],
  'pin-required': ['PIN erforderlich', 'alarm'],
  'puk-required': ['PUK erforderlich', 'alarm'],
  denied: ['Netz verweigert', 'alarm'],
  error: ['SIM-Fehler', 'alarm'],
  unknown: ['unbekannt', 'muted'],
};

const UPLINK_STATUS: Record<UplinkStatus, [string, Tone]> = {
  online: ['online', 'ok'],
  offline: ['offline', 'alarm'],
  standby: ['Bereitschaft', 'muted'],
  disabled: ['abgeschaltet', 'muted'],
  unknown: ['unbekannt', 'muted'],
};

const signalTone = (p: number | null): Tone => (p === null ? 'muted' : p > 50 ? 'ok' : p > 20 ? 'warn' : 'alarm');

function SimTile({ sim }: { sim: RouterSim }) {
  const [label, tone] = SIM_STATUS[sim.status];
  return (
    <div className={`uplink ${sim.active ? 'primary' : ''}`}>
      <div className="uplink-head">
        <CreditCard size={20} />
        <div>
          <strong>SIM {sim.slot}</strong>
          <div className="cell-sub">{sim.operator ?? 'Netzbetreiber unbekannt'}</div>
        </div>
        <Badge tone={sim.active ? 'info' : 'muted'}>{sim.active ? 'aktiv' : 'Reserve'}</Badge>
      </div>
      <div className="btn-row">
        <Badge tone={tone}>{label}</Badge>
        {sim.roaming && <Badge tone="warn">Roaming</Badge>}
      </div>
      {sim.active ? (
        <>
          <Meter value={sim.signalPercent ?? 0} tone={signalTone(sim.signalPercent)} label={`Signal SIM ${sim.slot}`} />
          <dl className="kv">
            <dt>Netz</dt>
            <dd>{[sim.networkType, sim.band].filter(Boolean).join(' · ') || '–'}</dd>
            <dt>Signal</dt>
            <dd>{sim.signalPercent !== null ? `${sim.signalPercent} %` : '–'}</dd>
            <dt>RSRP / RSRQ</dt>
            <dd>
              {fmtOpt(sim.rsrpDbm, 0)} dBm / {fmtOpt(sim.rsrqDb, 0)} dB
            </dd>
            <dt>SINR</dt>
            <dd>{fmtOpt(sim.sinrDb, 0)} dB</dd>
            {sim.iccid && (
              <>
                <dt>ICCID</dt>
                <dd className="mono">{sim.iccid}</dd>
              </>
            )}
          </dl>
        </>
      ) : (
        <p className="muted">
          {sim.seenAt ? `Zuletzt aktiv ${fmtDateTime(sim.seenAt)}.` : 'Das Modem fragt immer nur die aktive SIM ab.'} Der Zustand der Reserve-SIM ist erst nach einer Umschaltung sicher bekannt.
        </p>
      )}
      {sim.detail && sim.active && sim.status !== 'connected' && <span className="field-hint">{sim.detail}</span>}
    </div>
  );
}

function FailoverList({ members, onBackup, enabled }: { members: FailoverMember[]; onBackup: boolean; enabled: boolean }) {
  const active = members.find((m) => m.active);
  return (
    <div className="uplink failover">
      <div className="uplink-head">
        <Shuffle size={20} />
        <div>
          <strong>Failover</strong>
          <div className="cell-sub">{enabled ? 'Reihenfolge der Verbindungen' : 'im Router nicht eingerichtet'}</div>
        </div>
      </div>
      <div className="btn-row">
        {active ? <Badge tone={onBackup ? 'warn' : 'ok'}>{onBackup ? 'Ausweichverbindung aktiv' : 'bevorzugte Verbindung aktiv'}</Badge> : <Badge tone="alarm">keine Verbindung</Badge>}
      </div>
      <ol className="failover-list">
        {members.map((m) => {
          const [label, tone] = UPLINK_STATUS[m.status];
          return (
            <li key={m.id} className={m.active ? 'active' : undefined}>
              <span className="failover-prio">{m.priority}</span>
              <span className="failover-name">
                {m.active && <ArrowRight size={14} aria-label="aktiv" />} {m.label}
              </span>
              <Badge tone={m.active ? 'info' : tone}>{m.active ? 'aktiv' : label}</Badge>
            </li>
          );
        })}
      </ol>
      {onBackup && active && <p className="muted">Die bevorzugte Verbindung ist ausgefallen, der Verkehr läuft über {active.label}.</p>}
    </div>
  );
}

/** ELW-Router: WAN-Port, Failover und beide SIM-Steckplätze. */
export function RouterCard({ router }: { router: DeviceSnapshot<'router'> }) {
  const s = router.state;
  const active = s.failover.members.find((m) => m.active);
  const badge = !router.online ? (
    <Badge tone="alarm">Router nicht erreichbar</Badge>
  ) : s.internet ? (
    <Badge tone="ok">Internet über {active ? (active.kind === 'wan' ? s.wan.name : `SIM ${active.slot}`) : 'unbekannt'}</Badge>
  ) : (
    <Badge tone="alarm">Kein Internet</Badge>
  );
  return (
    <Card title={s.model ? `ELW-Router · ${s.model}` : 'ELW-Router'} icon={<RouterIcon size={18} />} className="span-3" actions={badge}>
      <div className={`uplinks router-grid ${router.online ? '' : 'stale'}`}>
        <FailoverList members={s.failover.members} onBackup={s.failover.onBackup} enabled={s.failover.enabled} />
        <div className={`uplink ${active?.kind === 'wan' ? 'primary' : ''}`}>
          <div className="uplink-head">
            <Cable size={20} />
            <div>
              <strong>{s.wan.name}</strong>
              <div className="cell-sub">WAN-Port</div>
            </div>
            <Badge tone={s.wan.link === null ? (s.wan.up ? 'ok' : 'muted') : s.wan.link ? 'ok' : 'muted'}>
              {s.wan.link === null ? (s.wan.up ? 'verbunden' : 'getrennt') : s.wan.link ? 'Link' : 'kein Link'}
            </Badge>
          </div>
          <dl className="kv">
            <dt>Kabel</dt>
            <dd>{s.wan.link === null ? 'nicht ermittelbar' : s.wan.link ? `verbunden${s.wan.speedMbps ? ` · ${s.wan.speedMbps} Mbit/s` : ''}` : 'nicht verbunden'}</dd>
            <dt>IP-Adresse</dt>
            <dd className="mono">{s.wan.ip ?? '–'}</dd>
            <dt>Gateway</dt>
            <dd className="mono">{s.wan.gateway ?? '–'}</dd>
          </dl>
        </div>
        {s.sims.map((sim) => (
          <SimTile key={sim.slot} sim={sim} />
        ))}
      </div>
      {!router.online && <p className="muted">Zuletzt empfangene Werte – der Router antwortet gerade nicht.</p>}
    </Card>
  );
}
