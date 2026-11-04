import { useState, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Activity,
  BatteryCharging,
  Bell,
  BookOpenText,
  CalendarDays,
  Cctv,
  ClipboardPlus,
  Clock,
  CloudSun,
  History,
  Image as ImageIcon,
  ListChecks,
  AtSign,
  Mail,
  MessagesSquare,
  Plus,
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
import { CHAT_CHANNEL_LABEL, DASHBOARD_TILE_TYPES, formatPhone, JOURNAL_CATEGORY_LABELS, bluetoothSummary, formatStrength, INVERTER_STATE_LABELS, inverterAlarms, type InverterState, sumStrength, type DashboardTile, type DashboardTileType, type DisplayTile, type Incident, type MessageInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtAgo, fmtDateTime, fmtDuration, fmtNum, fmtTime } from '../../lib/format';
import { useActiveIncident, useNow } from '../../lib/hooks';
import { useDevice } from '../../lib/live';
import { useAuth } from '../../lib/auth';
import { LoginButton } from '../auth/Guards';
import { Badge, Dot, Modal, Stat } from '../ui';
import { TileView } from '../display/tiles';
import { MessageDialog } from '../messages/MessageDialog';
import { MessageForm } from '../messages/MessageForm';
import { useToast } from '../../lib/toast';
import { markdownPreview } from '../messages/Markdown';
import { MESSAGES_PATH, PENDING_LABEL, useMessageAttention } from '../messages/messageHooks';
import { deployedUnits } from '../../pages/incident/UnitsView';
import { RadioTimeline } from '../../pages/funk/RadioTimeline';

export const DASHBOARD_ICONS: Record<DashboardTileType, LucideIcon> = {
  incident: Siren,
  journal: BookOpenText,
  messages: Mail,
  chat: MessagesSquare,
  mail: AtSign,
  tasks: ListChecks,
  forces: Users,
  damage: ClipboardPlus,
  map: MapIcon,
  weather: CloudSun,
  forecast: CalendarDays,
  clock: Clock,
  alerts: Bell,
  radio: Radio,
  radioTimeline: History,
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
  chat: '/nachrichten',
  mail: '/mail',
  tasks: '/einsatz/aufgaben',
  forces: '/einsatz/kraefte',
  damage: '/einsatz/schadenkonten',
  map: '/karte',
  weather: '/wetter',
  forecast: '/wetter',
  radio: '/funk',
  radioTimeline: '/funk',
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

/** Kurze Zeitangabe: heute nur Uhrzeit, sonst Datum und Uhrzeit */
const when = (iso: string, now: Date) => (new Date(iso).toDateString() === now.toDateString() ? fmtTime(iso) : fmtDateTime(iso));

/** Eingang der Nachrichten: Gespräche mit der letzten Nachricht, ungelesene hervorgehoben */
function ChatTile() {
  const now = useNow();
  const { data: avail } = useQuery({ queryKey: ['chat', 'available'], queryFn: api.chatAvailable });
  const { data: threads } = useQuery({ queryKey: ['chat', 'threads'], queryFn: api.chatThreads, enabled: !!avail?.available });
  if (!avail) return <Empty>Lade …</Empty>;
  if (!avail.available) return <Empty>Kein Kanal für Nachrichten eingerichtet</Empty>;
  if (!threads) return <Empty>Lade Nachrichten …</Empty>;
  if (!threads.length) return <Empty>Keine Nachrichten</Empty>;
  return (
    <ul className="dash-inbox dash-list">
      {[...threads]
        .sort((a, b) => b.last.date.localeCompare(a.last.date))
        .map((t) => (
          <li key={t.key}>
            <Link to={`/nachrichten?t=${encodeURIComponent(t.key)}`} className={`dash-inbox-item ${t.unread ? 'unread' : ''}`}>
              <span className="dash-inbox-head">
                <strong className="ellipsis">{t.name ?? (t.numbers[0] ? formatPhone(t.numbers[0]) : (t.peer ?? 'Unbekannt'))}</strong>
                {t.unread > 0 && <Badge tone="info">{t.unread}</Badge>}
                <span className="muted dash-inbox-date">{when(t.last.date, now)}</span>
              </span>
              <span className="cell-sub ellipsis">
                {CHAT_CHANNEL_LABEL[t.last.channel]} · {t.last.folder === 'sent' ? 'Du: ' : ''}
                {t.last.text || (t.last.attachment ? 'Anhang' : t.last.location ? 'Standort' : '')}
              </span>
            </Link>
          </li>
        ))}
    </ul>
  );
}

/** Posteingang: Absender, Betreff, Anfang des Textes; ungelesene hervorgehoben */
function MailTile() {
  const now = useNow();
  const { data: avail } = useQuery({ queryKey: ['mail', 'available'], queryFn: api.mailAvailable });
  const { data: list } = useQuery({ queryKey: ['mail', 'messages', 'inbox'], queryFn: () => api.mailMessages('inbox'), enabled: !!avail?.available });
  if (!avail) return <Empty>Lade …</Empty>;
  if (!avail.available) return <Empty>Kein Postfach eingerichtet</Empty>;
  if (!list) return <Empty>Lade E-Mails …</Empty>;
  if (!list.items.length) return <Empty>Keine E-Mails</Empty>;
  return (
    <ul className="dash-inbox dash-list">
      {list.items.map((m) => (
        <li key={m.id}>
          <Link to={`/mail?id=${m.id}`} className={`dash-inbox-item ${m.seen ? '' : 'unread'}`}>
            <span className="dash-inbox-head">
              <strong className="ellipsis">{m.from}</strong>
              <span className="muted dash-inbox-date">{when(m.date, now)}</span>
            </span>
            <span className="ellipsis dash-inbox-subject">{m.subject || '(ohne Betreff)'}</span>
            <span className="cell-sub ellipsis">{m.snippet}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Neue Meldung erfassen – wie auf der Seite „Meldungen“ */
function NewMessageButton() {
  const toast = useToast();
  const { data: incident } = useActiveIncident();
  const [creating, setCreating] = useState(false);
  const create = useMutation({
    mutationFn: (input: MessageInput) => api.createMessage(incident!.id, input),
    onSuccess: () => (setCreating(false), toast('success', 'Meldung erstellt')),
    onError: (e) => toast('error', e.message),
  });
  if (!incident || incident.closedAt) return null;
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
        <Plus size={16} /> Meldung
      </button>
      <Modal open={creating} title="Neue Meldung" onClose={() => setCreating(false)} wide>
        <MessageForm incidentId={incident.id} pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
    </>
  );
}

/** Knöpfe rechts in der Kopfzeile einer Kachel (nur angemeldet, nicht beim Bearbeiten der Übersicht) */
export const DASHBOARD_ACTIONS: Partial<Record<DashboardTileType, ComponentType>> = {
  messages: NewMessageButton,
};

/** Alle Funkgeräte des Treibers untereinander – nicht erreichbare rot */
function RadioTile() {
  const radio = useDevice('radio');
  if (!radio) return <Empty>Funk nicht aktiviert</Empty>;
  const { devices, talkgroups } = radio.state;
  if (!devices.length) return <Empty>Keine Funkgeräte</Empty>;
  return (
    <ul className="dash-radio-devices">
      {devices.map((d) => {
        const tg = talkgroups.find((t) => t.id === d.talkgroupId)?.name;
        const act = d.transmitting ? 'TX' : d.receiving ? 'RX' : null;
        return (
          <li key={d.id} className={d.online ? undefined : 'offline'} title={d.online ? undefined : 'Nicht erreichbar'}>
            <Dot tone={d.online ? 'ok' : 'alarm'} />
            <span className="dash-radio-name">
              <strong className="ellipsis">{d.name}</strong>
              <span className="cell-sub ellipsis">{[d.type, d.issi && `ISSI ${d.issi}`, tg, !d.online && 'nicht erreichbar'].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="dash-radio-state">
              {act ? <Badge tone={act === 'TX' ? 'alarm' : 'ok'}>{act}</Badge> : d.fmsStatus !== null ? <span className="mono">S{d.fmsStatus}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Funkverkehr wie auf der Seite „Funk“, ohne Filterleiste */
function RadioTimelineTile() {
  const radio = useDevice('radio');
  if (!radio) return <Empty>Funk nicht aktiviert</Empty>;
  return (
    <div className="dash-radio-timeline">
      <RadioTimeline devices={radio.state.devices} live={radio.state.activity} compact />
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
    case 'chat':
      return <ChatTile />;
    case 'mail':
      return <MailTile />;
    case 'radio':
      return <RadioTile />;
    case 'radioTimeline':
      return <RadioTimelineTile />;
    case 'energy':
      return <EnergyTile />;
    case 'monitoring':
      return <MonitoringTile />;
    default:
      // Kacheln der Bildschirme
      return <TileView tile={tile as DisplayTile} />;
  }
}
