import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BatteryCharging,
  Bell,
  BookOpenText,
  CalendarDays,
  Cctv,
  Clock,
  CloudSun,
  Image as ImageIcon,
  ListChecks,
  Mail,
  Map as MapIcon,
  Network,
  Radio,
  Siren,
  Type,
  Users,
  Video,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import { DASHBOARD_TILE_TYPES, JOURNAL_CATEGORY_LABELS, bluetoothSummary, formatStrength, INVERTER_STATE_LABELS, inverterAlarms, type InverterState, sumStrength, type DashboardTile, type DashboardTileType, type DisplayTile, type Incident } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtAgo, fmtDuration, fmtNum, fmtTime } from '../../lib/format';
import { useActiveIncident, useNow } from '../../lib/hooks';
import { useDevice } from '../../lib/live';
import { useAuth } from '../../lib/auth';
import { LoginButton } from '../auth/Guards';
import { Badge, Dot, Stat } from '../ui';
import { TileView } from '../display/tiles';
import { MessageDialog } from '../messages/MessageDialog';
import { markdownPreview } from '../messages/Markdown';
import { MESSAGES_PATH, PENDING_LABEL, useMessageAttention } from '../messages/messageHooks';
import { deployedUnits } from '../../pages/incident/UnitsView';

export const DASHBOARD_ICONS: Record<DashboardTileType, LucideIcon> = {
  incident: Siren,
  journal: BookOpenText,
  messages: Mail,
  tasks: ListChecks,
  forces: Users,
  map: MapIcon,
  weather: CloudSun,
  forecast: CalendarDays,
  clock: Clock,
  alerts: Bell,
  radio: Radio,
  network: Network,
  energy: BatteryCharging,
  monitoring: Activity,
  camera: Cctv,
  video: Video,
  text: Type,
  image: ImageIcon,
  guestWifi: Wifi,
};

/** Zielseite beim Klick auf die Kachelüberschrift */
export const DASHBOARD_LINKS: Partial<Record<DashboardTileType, string>> = {
  incident: '/einsatz',
  journal: '/einsatz/tagebuch',
  messages: MESSAGES_PATH,
  tasks: '/einsatz/aufgaben',
  forces: '/einsatz/kraefte',
  map: '/karte',
  weather: '/wetter',
  forecast: '/wetter',
  radio: '/funk',
  network: '/netzwerk',
  energy: '/energie',
  monitoring: '/monitoring',
  camera: '/kameras',
  video: '/kameras',
};

/** Ohne Kopfzeile: der Inhalt füllt die Kachel */
export const HEADLESS: ReadonlySet<DashboardTileType> = new Set(['clock', 'text', 'image']);

function Empty({ children }: { children: ReactNode }) {
  return <div className="tile-empty">{children}</div>;
}

function IncidentTile() {
  const { user } = useAuth();
  const { data: incident } = useActiveIncident();
  if (!user)
    return (
      <Empty>
        <span className="dash-empty-stack">
          Einsatzdaten nur für angemeldete Benutzer
          <LoginButton className="btn btn-primary" />
        </span>
      </Empty>
    );
  if (!incident)
    return (
      <Empty>
        <span className="dash-empty-stack">
          Kein Einsatz aufgelegt
          <Link to="/einsatz" className="btn btn-primary">
            Einsatz eröffnen
          </Link>
        </span>
      </Empty>
    );
  return <IncidentSummary incident={incident} />;
}

function IncidentSummary({ incident }: { incident: Incident }) {
  const now = useNow();
  const { data: units = [] } = useQuery({ queryKey: ['units', incident.id], queryFn: () => api.units(incident.id) });
  const active = deployedUnits(units);
  return (
    <div className="dash-incident">
      <div className="dash-incident-main">
        <div className="incident-keyword">{incident.keyword || 'Einsatz'}</div>
        <div className="incident-title">{incident.title}</div>
        {incident.location && <div className="muted">{incident.location}</div>}
      </div>
      <div className="dash-incident-stats">
        <Stat label="Einsatzdauer" value={<span className="mono">{fmtDuration(incident.startedAt, now)}</span>} />
        <Stat label="Kräfte" value={active.length} sub={formatStrength(sumStrength(active))} />
      </div>
    </div>
  );
}

function JournalTile() {
  const { data: incident } = useActiveIncident();
  const { data: journal } = useQuery({ queryKey: ['journal', incident?.id ?? 0], queryFn: () => api.journal(incident!.id), enabled: !!incident });
  if (!incident) return <Empty>Kein Einsatz aufgelegt</Empty>;
  if (!journal) return <Empty>Lade Einsatztagebuch …</Empty>;
  if (!journal.length) return <Empty>Noch keine Einträge</Empty>;
  return (
    <ul className="mini-journal dash-list">
      {journal
        .slice(-50)
        .reverse()
        .map((e) => (
          <li key={e.id}>
            <span className="mono">{fmtTime(e.timestamp)}</span>
            <Badge tone={e.category === 'system' ? 'muted' : 'info'}>{JOURNAL_CATEGORY_LABELS[e.category]}</Badge>
            <span className="ellipsis">{e.text}</span>
          </li>
        ))}
    </ul>
  );
}

function MessagesTile() {
  const now = useNow();
  const { incident, attention } = useMessageAttention(now);
  const [openId, setOpenId] = useState<number | null>(null);
  if (!incident) return <Empty>Kein Einsatz aufgelegt</Empty>;
  if (!attention.length) return <Empty>Nichts zu tun</Empty>;
  return (
    <>
      <ul className="due-list dash-list">
        {attention.map((m) => (
          <li key={m.id}>
            <button type="button" className="message-alert" onClick={() => setOpenId(m.id)}>
              <span className="due-summary">{m.remindAt ? 'Erneut versuchen' : PENDING_LABEL[m.pending!]}</span>
              <span className="cell-sub">
                {m.sender} → {m.recipient ?? 'Verteilung'} · {fmtAgo(m.repliedAt ?? m.createdAt, now)}
              </span>
              <span className="message-alert-preview">{markdownPreview(m.pending === 'reply' ? (m.reply ?? '') : m.body)}</span>
            </button>
          </li>
        ))}
      </ul>
      <MessageDialog incident={incident} messageId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function RadioTile() {
  const radio = useDevice('radio');
  if (!radio) return <Empty>Funk nicht aktiviert</Empty>;
  const { devices } = radio.state;
  if (!devices.length) return <Empty>Keine Funkgeräte</Empty>;
  const online = devices.filter((d) => d.online).length;
  return (
    <div className="dash-status">
      <div className={`dash-status-head tone-${online === devices.length ? 'ok' : 'warn'}`}>
        {online} / {devices.length} Funkgeräte erreichbar
      </div>
      <ul className="dash-status-list">
        {devices.map((d) => (
          <li key={d.id}>
            <Dot tone={!d.online ? 'alarm' : d.transmitting ? 'warn' : d.receiving ? 'info' : 'ok'} />
            <span className="ellipsis">{d.name}</span>
            <span className="muted mono">{d.transmitting ? 'TX' : d.receiving ? 'RX' : d.fmsStatus !== null ? `S${d.fmsStatus}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Kurzfassung des Wechselrichters: Zustand, Ausgang, Batterie */
function inverterSummary(s: InverterState): string {
  const out = s.outputW !== null ? `${fmtNum(s.outputW, 0)} W` : s.phases[0]?.acOut.a != null ? `${fmtNum(s.phases[0].acOut.a, 1)} A` : null;
  const dc = s.dc.v !== null ? `${fmtNum(s.dc.v, 1)} V` : null;
  return [s.opState ? INVERTER_STATE_LABELS[s.opState] : null, out, dc].filter(Boolean).join(' · ') || '–';
}

function EnergyTile() {
  const bt = useDevice('bluetooth');
  const inv = useDevice('inverter');
  if (!bt && !inv) return <Empty>Wechselrichter und Bluetooth (Victron) nicht aktiviert</Empty>;
  const devices = bt?.state.devices ?? [];
  if (!devices.length && !inv) return <Empty>Keine Geräte eingerichtet</Empty>;
  const invAlarms = inv ? inverterAlarms(inv.state.leds) : [];
  return (
    <ul className="dash-status-list">
      {inv && (
        <li>
          <Dot tone={!inv.online ? 'alarm' : invAlarms.some((a) => a.severity === 'alarm') ? 'alarm' : invAlarms.length || inv.state.link.error ? 'warn' : inv.state.opState === 'off' ? 'muted' : 'ok'} />
          <span className="ellipsis">Wechselrichter</span>
          <span className="mono">{!inv.online ? 'nicht verbunden' : (invAlarms[0]?.title ?? inverterSummary(inv.state))}</span>
        </li>
      )}
      {devices.map((d) => {
        const low = d.readout && 'voltageV' in d.readout && d.readout.voltageV !== null && d.warnBelowV !== null && d.readout.voltageV < d.warnBelowV;
        return (
          <li key={d.id}>
            <Dot tone={d.error || !d.readout ? 'alarm' : d.stale ? 'muted' : low ? 'warn' : 'ok'} />
            <span className="ellipsis">{d.name}</span>
            <span className="mono">{d.error ?? bluetoothSummary(d) ?? '–'}</span>
          </li>
        );
      })}
    </ul>
  );
}

function MonitoringTile() {
  const mon = useDevice('monitoring');
  if (!mon) return <Empty>Monitoring nicht aktiviert</Empty>;
  const { targets } = mon.state;
  if (!targets.length) return <Empty>Keine Systeme überwacht</Empty>;
  const down = targets.filter((t) => t.reachable === false);
  return (
    <div className="dash-status">
      <div className={`dash-status-head tone-${down.length ? 'alarm' : 'ok'}`}>{down.length ? `${down.length} nicht erreichbar` : 'Alle Systeme erreichbar'}</div>
      <ul className="dash-status-list">
        {[...down, ...targets.filter((t) => t.reachable !== false)].map((t) => (
          <li key={t.id}>
            <Dot tone={t.reachable === null ? 'muted' : t.reachable ? 'ok' : 'alarm'} />
            <span className="ellipsis">{t.name}</span>
            {t.error && <span className="muted ellipsis">{t.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Inhalt einer Kachel der Übersicht */
export function DashboardTileContent({ tile }: { tile: DashboardTile }) {
  const { user } = useAuth();
  if (DASHBOARD_TILE_TYPES[tile.type].requiresLogin && tile.type !== 'incident' && !user) return <Empty>Nur für angemeldete Benutzer</Empty>;
  switch (tile.type) {
    case 'incident':
      return <IncidentTile />;
    case 'journal':
      return <JournalTile />;
    case 'messages':
      return <MessagesTile />;
    case 'radio':
      return <RadioTile />;
    case 'energy':
      return <EnergyTile />;
    case 'monitoring':
      return <MonitoringTile />;
    default:
      // Kacheln der Bildschirme
      return <TileView tile={tile as DisplayTile} />;
  }
}
