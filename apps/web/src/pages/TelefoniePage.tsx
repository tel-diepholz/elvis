import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { History, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Server, CreditCard } from 'lucide-react';
import { contactName, formatPhone, phoneKey, type ActiveCall, type CallRecord, type GsmTrunk, type GsmTrunkStatus } from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtTime } from '../lib/format';
import { useDevice } from '../lib/live';
import { useNow } from '../lib/hooks';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { Badge, Card, EmptyState, Loading, Meter, PageHeader, type Tone } from '../components/ui';

const TRUNK_STATUS: Record<GsmTrunkStatus, [string, Tone]> = {
  up: ['im Netz', 'ok'],
  searching: ['sucht Netz', 'warn'],
  down: ['kein Netz', 'alarm'],
  'no-sim': ['keine SIM', 'alarm'],
  unknown: ['unbekannt', 'muted'],
};

const signalTone = (p: number | null): Tone => (p === null ? 'muted' : p > 50 ? 'ok' : p > 20 ? 'warn' : 'alarm');

/** „2:05“ bzw. „1:02:05“ */
function duration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function TrunkTile({ trunk }: { trunk: GsmTrunk }) {
  const [label, tone] = TRUNK_STATUS[trunk.status];
  return (
    <div className={`uplink ${trunk.busy ? 'primary' : ''}`}>
      <div className="uplink-head">
        <CreditCard size={20} />
        <div>
          <strong>{trunk.name}</strong>
          <div className="cell-sub">
            Port {trunk.port} · {trunk.operator ?? 'Netzbetreiber unbekannt'}
          </div>
        </div>
        {trunk.busy && <Badge tone="info">Gespräch</Badge>}
      </div>
      <div className="btn-row">
        <Badge tone={tone}>{label}</Badge>
        {trunk.roaming && <Badge tone="warn">Roaming</Badge>}
      </div>
      <Meter value={trunk.signalPercent ?? 0} tone={signalTone(trunk.signalPercent)} label={`Signal ${trunk.name}`} />
      <dl className="kv">
        <dt>Signal</dt>
        <dd>{trunk.signalPercent !== null ? `${trunk.signalPercent} % (${trunk.rssiDbm} dBm)` : '–'}</dd>
        <dt>Registrierung</dt>
        <dd>{trunk.registration ?? '–'}</dd>
        {trunk.ber !== null && (
          <>
            <dt>Bitfehlerrate</dt>
            <dd>{trunk.ber} von 7</dd>
          </>
        )}
        {trunk.model && (
          <>
            <dt>Modem</dt>
            <dd>{trunk.model}</dd>
          </>
        )}
        {trunk.smsc && (
          <>
            <dt>SMS-Zentrale</dt>
            <dd className="mono">{trunk.smsc}</dd>
          </>
        )}
      </dl>
      {trunk.statusText && trunk.status !== 'up' && <span className="field-hint">{trunk.statusText}</span>}
    </div>
  );
}

function SipTile({ sip }: { sip: { reachable: boolean | null; registration: string | null; checkedAt: string | null; target: string | null } }) {
  return (
    <div className="uplink">
      <div className="uplink-head">
        <Server size={20} />
        <div>
          <strong>SIP</strong>
          <div className="cell-sub">Anbindung an die Telefonanlage</div>
        </div>
      </div>
      <div className="btn-row">
        {sip.reachable === null ? (
          <Badge tone="muted">nicht geprüft</Badge>
        ) : sip.reachable ? (
          <Badge tone="ok">SIP-Dienst antwortet</Badge>
        ) : (
          <Badge tone="alarm">SIP-Dienst antwortet nicht</Badge>
        )}
      </div>
      <dl className="kv">
        <dt>Ziel</dt>
        <dd className="mono">{sip.target ?? '–'}</dd>
        <dt>Registrierung</dt>
        <dd>{sip.registration ?? 'vom Gateway nicht gemeldet'}</dd>
        <dt>Geprüft</dt>
        <dd>{sip.checkedAt ? fmtTime(sip.checkedAt) : '–'}</dd>
      </dl>
    </div>
  );
}

function CallIcon({ direction, answered }: { direction: 'in' | 'out'; answered: boolean }) {
  if (direction === 'in' && !answered) return <PhoneMissed size={16} className="tone-alarm" aria-label="verpasst" />;
  return direction === 'in' ? <PhoneIncoming size={16} aria-label="eingehend" /> : <PhoneOutgoing size={16} aria-label="ausgehend" />;
}

function ActiveCalls({ calls, trunks }: { calls: ActiveCall[]; trunks: GsmTrunk[] }) {
  const now = useNow();
  const { user } = useAuth();
  // Kontaktnamen zu den Nummern (nur angemeldet – die Kontakte sind nicht öffentlich)
  const { data: contacts = [] } = useQuery({ queryKey: ['contacts'], queryFn: api.contacts, enabled: !!user });
  const nameOf = (number: string) => {
    const key = phoneKey(number);
    const c = contacts.find((x) => x.phones.some((p) => phoneKey(p.number) === key));
    return c ? contactName(c) : null;
  };
  return (
    <ul className="call-list">
      {calls.map((c) => (
        <li key={c.id}>
          <CallIcon direction={c.direction} answered />
          <span className="call-party">
            <strong>{c.name ?? (c.number && nameOf(c.number)) ?? (c.number ? formatPhone(c.number) : 'unbekannte Nummer')}</strong>
            <span className="cell-sub">
              {(c.name ?? (c.number && nameOf(c.number))) ? `${formatPhone(c.number)} · ` : ''}
              {c.direction === 'in' ? 'eingehend' : 'ausgehend'} · {trunks.find((t) => t.port === c.port)?.name ?? `Port ${c.port}`}
            </span>
          </span>
          <Badge tone={c.answeredAt ? 'ok' : 'warn'}>
            {c.answeredAt ? duration(Math.max(0, Math.round((now.getTime() - new Date(c.answeredAt).getTime()) / 1000))) : c.direction === 'in' ? 'klingelt' : 'wählt'}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function CallLog() {
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ['calls'], queryFn: () => api.calls(24), enabled: !!user });
  if (!user) return <p className="muted">Die Anrufliste sehen nur angemeldete Benutzer.</p>;
  if (!data) return <Loading />;
  if (!data.length) return <EmptyState icon={<History size={28} />} title="Keine Anrufe in den letzten 24 Stunden" />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th />
            <th>Zeit</th>
            <th>Gegenstelle</th>
            <th>Trunk</th>
            <th>Dauer</th>
            <th>Tagebuch</th>
          </tr>
        </thead>
        <tbody>
          {data.map((c: CallRecord) => (
            <tr key={c.id}>
              <td>
                <CallIcon direction={c.direction} answered={!!c.answeredAt} />
              </td>
              <td className="nowrap">{fmtDateTime(c.startedAt)}</td>
              <td>
                {c.name && <div>{c.name}</div>}
                <a href={`tel:${c.number}`} className={c.name ? 'cell-sub' : undefined}>
                  {/^[+\d]/.test(c.number) ? formatPhone(c.number) : 'unbekannte Nummer'}
                </a>
              </td>
              <td>{c.trunk ?? '–'}</td>
              <td className="nowrap">{c.answeredAt ? duration(c.durationS) : c.direction === 'in' ? <span className="tone-alarm">verpasst</span> : 'nicht erreicht'}</td>
              <td>{c.incidentId ? <Link to="/einsatz/tagebuch">eingetragen</Link> : <span className="muted">–</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Telefonie: GSM-Trunks und SIP des Gateways, laufende Gespräche, Anrufliste */
export function TelefoniePage() {
  const telephony = useDevice('telephony');
  if (!telephony)
    return (
      <>
        <PageHeader title="Telefonie" subtitle="GSM-Gateway, Gespräche und Anrufliste" />
        <ModuleDisabled name="Telefonie" module="telephony" />
      </>
    );

  const { link, trunks, sip, calls } = telephony.state;
  const linkBadge = link ? (
    <Badge tone={link.connected ? 'ok' : 'alarm'}>
      {link.connected ? `Verbunden mit ${link.target}` : `Keine Verbindung zu ${link.target}${link.error ? ` (${link.error})` : ''}`}
    </Badge>
  ) : (
    <Badge tone="info">Simulation</Badge>
  );

  return (
    <>
      <PageHeader title="Telefonie" subtitle="GSM-Gateway, Gespräche und Anrufliste" actions={linkBadge} />
      <div className="grid">
        <Card title="GSM-Gateway" icon={<CreditCard size={18} />} className="span-3">
          <div className={`uplinks ${telephony.online ? '' : 'stale'}`}>
            {trunks.map((t) => (
              <TrunkTile key={t.port} trunk={t} />
            ))}
            <SipTile sip={sip} />
          </div>
          {!telephony.online && <p className="muted">Zuletzt empfangene Werte – das Gateway antwortet gerade nicht.</p>}
        </Card>
        <Card title="Laufende Gespräche" icon={<PhoneCall size={18} />} className="span-3">
          {calls.length ? <ActiveCalls calls={calls} trunks={trunks} /> : <p className="muted">Gerade kein Gespräch.</p>}
        </Card>
        <Card title="Anrufliste" icon={<History size={18} />} className="span-3">
          <p className="muted">Laufende Einsätze bekommen jedes Gespräch als Eintrag „Telefon“ im Einsatztagebuch.</p>
          <CallLog />
        </Card>
      </div>
    </>
  );
}
