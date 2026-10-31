import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, BookOpenText, Network, Radio, Siren, Wind } from 'lucide-react';
import { JOURNAL_CATEGORY_LABELS, formatStrength, sumStrength, type Incident } from '@elvis/shared';
import { api } from '../lib/api';
import { compass, fmtDuration, fmtOpt, fmtTime } from '../lib/format';
import { useActiveIncident, useNow } from '../lib/hooks';
import { useAlerts, useDevice } from '../lib/live';
import { useAuth } from '../lib/auth';
import { LoginButton } from '../components/auth/Guards';
import { UPLINK_KIND } from '../lib/labels';
import { AlertList } from '../components/AlertPanel';
import { WindCompass } from '../components/WindCompass';
import { Badge, Card, Stat } from '../components/ui';
import { deployedUnits } from './incident/UnitsView';

function IncidentSummary({ incident }: { incident: Incident }) {
  const now = useNow();
  const { data: journal = [] } = useQuery({ queryKey: ['journal', incident.id], queryFn: () => api.journal(incident.id) });
  const { data: units = [] } = useQuery({ queryKey: ['units', incident.id], queryFn: () => api.units(incident.id) });
  const active = deployedUnits(units);

  return (
    <Card
      title="Laufender Einsatz"
      icon={<Siren size={18} />}
      className="span-2 card-incident"
      actions={
        <Link to="/einsatz" className="btn btn-sm">
          Details
        </Link>
      }
    >
      <div className="incident-hero">
        <div>
          <div className="incident-keyword">{incident.keyword || 'Einsatz'}</div>
          <div className="incident-title">{incident.title}</div>
          {incident.location && <div className="muted">{incident.location}</div>}
        </div>
        <div className="grid-2">
          <Stat label="Einsatzdauer" value={<span className="mono">{fmtDuration(incident.startedAt, now)}</span>} />
          <Stat label="Kräfte" value={active.length} sub={formatStrength(sumStrength(active))} />
        </div>
      </div>
      <h3 className="section-title">
        <BookOpenText size={16} /> Letzte Einträge
      </h3>
      <ul className="mini-journal">
        {journal
          .slice(-5)
          .reverse()
          .map((e) => (
            <li key={e.id}>
              <span className="mono">{fmtTime(e.timestamp)}</span>
              <Badge tone={e.category === 'system' ? 'muted' : 'info'}>{JOURNAL_CATEGORY_LABELS[e.category]}</Badge>
              <span className="ellipsis">{e.text}</span>
            </li>
          ))}
      </ul>
    </Card>
  );
}

function NoIncident() {
  const { user } = useAuth();
  if (!user) {
    return (
      <Card title="Einsatz" icon={<Siren size={18} />} className="span-2">
        <div className="incident-empty">
          <p className="muted">Einsatzdaten werden nur angemeldeten Benutzern angezeigt.</p>
          <LoginButton className="btn btn-primary btn-lg" />
        </div>
      </Card>
    );
  }
  return (
    <Card title="Einsatz" icon={<Siren size={18} />} className="span-2">
      <div className="incident-empty">
        <div>
          <p className="muted">Kein Einsatz aufgelegt. Einsatztagebuch, Kräfteübersicht und Dokumente werden mit dem Eröffnen eines Einsatzes freigeschaltet.</p>
        </div>
        <Link to="/einsatz" className="btn btn-primary btn-lg">
          Einsatz eröffnen
        </Link>
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const { data: incident } = useActiveIncident();
  const alerts = useAlerts();
  const weather = useDevice('weather');
  const radio = useDevice('radio');
  const network = useDevice('network');
  const router = useDevice('router');
  const link = router?.state.failover.members.find((m) => m.active);

  const primary = network?.state.uplinks.find((u) => u.id === network.state.primaryUplinkId);
  const radiosOnline = radio?.state.devices.filter((d) => d.online).length ?? 0;
  const radioActive = radio?.state.devices.filter((d) => d.transmitting || d.receiving) ?? [];

  return (
    <div className="grid">
      {incident ? <IncidentSummary incident={incident} /> : <NoIncident />}

      <Card title="Meldungen" icon={<Bell size={18} />}>
        <AlertList alerts={alerts.slice(0, 6)} compact />
      </Card>

      {weather && (
        <Link to="/wetter" className="card card-link">
          <h2 className="card-title">
            <Wind size={18} /> Wetter
          </h2>
          <div className="wind-mini">
            <WindCompass directionDeg={weather.state.windDirectionDeg} size={96} />
            <div>
              <Stat
                label={weather.state.windDirectionDeg === null ? 'Wind' : `Wind aus ${compass(weather.state.windDirectionDeg)}`}
                value={fmtOpt(weather.state.windSpeedMs)}
                unit="m/s"
                sub={`Böen ${fmtOpt(weather.state.windGustMs)} m/s`}
              />
              <div className="muted">
                {fmtOpt(weather.state.temperatureC)} °C
                {weather.state.humidityPercent !== null && ` · ${weather.state.humidityPercent} % rF`}
              </div>
            </div>
          </div>
        </Link>
      )}

      {radio && (
        <Link to="/funk" className="card card-link">
          <h2 className="card-title">
            <Radio size={18} /> Funk
          </h2>
          <div className="grid-2">
            <Stat label="Funkgeräte" value={radiosOnline} unit={`/ ${radio.state.devices.length}`} tone={radiosOnline === radio.state.devices.length ? 'ok' : 'warn'} />
          </div>
          <div className="muted">{radioActive.length ? `Aktiv: ${radioActive.map((d) => `${d.name} (${d.transmitting ? 'TX' : 'RX'})`).join(', ')}` : 'Kein Funkverkehr'}</div>
        </Link>
      )}

      {(network || router) && (
        <Link to="/netzwerk" className="card card-link">
          <h2 className="card-title">
            <Network size={18} /> Netzwerk
          </h2>
          <div className="grid-2">
            {router ? (
              <Stat
                label="Internet"
                value={!router.online ? '–' : link ? (link.kind === 'wan' ? 'WAN' : `SIM ${link.slot}`) : 'Nein'}
                tone={!router.online || !link ? 'alarm' : router.state.failover.onBackup ? 'warn' : 'ok'}
                sub={!router.online ? 'Router nicht erreichbar' : link ? `${link.label}${router.state.failover.onBackup ? ' · Ausweich' : ''}` : undefined}
              />
            ) : (
              network && (
                <Stat
                  label="Internet"
                  value={network.state.internet && primary ? UPLINK_KIND[primary.kind] : network.state.internet ? 'Ja' : 'Nein'}
                  tone={network.state.internet ? 'ok' : 'alarm'}
                  sub={primary?.provider}
                />
              )
            )}
          </div>
        </Link>
      )}
    </div>
  );
}
