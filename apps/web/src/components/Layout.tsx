import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bell, ChevronDown, Lock, Menu, Moon, PanelLeftClose, PanelLeftOpen, Sun, Wifi, WifiOff, X } from 'lucide-react';
import { useActiveIncident, useInfo, useNow, useSettings } from '../lib/hooks';
import { useAlerts, useLive } from '../lib/live';
import { fmtDate, fmtDtg, fmtTimeSec, fmtWeekday } from '../lib/format';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { effectiveTheme, toggleTheme, useTheme } from '../lib/theme';
import { AlertPanel } from './AlertPanel';
import { CaCertLink } from './CaCertLink';
import { AccountMenu } from './auth/AccountMenu';
import { DueTasksButton, DueTasksPanel } from './tasks/DueTasks';
import { MessagesButton, MessagesPanel } from './messages/MessageAlerts';
import { useMessageAttention } from './messages/messageHooks';
import { inEdition, MOBILE_PRIMARY, NAV, navFor, type NavGroup, type NavItem } from './nav';
import { MESSENGER_IDS, type MessengerState, type TelephonyState } from '@elvis/shared';

/** Neue Personalbögen im Posteingang */
function useUnreadSheets(): number {
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ['personnelSheets', 'unread'], queryFn: api.personnelUnread, enabled: !!user });
  return user ? (data?.count ?? 0) : 0;
}

/** Postfach eingerichtet und ungelesene Mails */
function useMail(): { available: boolean; unread: number } {
  const { user } = useAuth();
  const { data: avail } = useQuery({ queryKey: ['mail', 'available'], queryFn: api.mailAvailable, enabled: !!user });
  const available = !!user && !!avail?.available;
  const { data } = useQuery({ queryKey: ['mail', 'unread'], queryFn: api.mailUnread, enabled: available });
  return { available, unread: available ? (data?.count ?? 0) : 0 };
}

/** Mindestens ein Kanal für Nachrichten (SMS über die Telefonie, eingerichteter Messenger) und ungelesene Nachrichten */
function useChat(): { available: boolean; unread: number } {
  const { user } = useAuth();
  const { devices } = useLive();
  const available = !!user && (!!(devices.telephony?.state as TelephonyState | undefined)?.capabilities.sms || MESSENGER_IDS.some((id) => !!(devices[id]?.state as MessengerState | undefined)?.account));
  const { data } = useQuery({ queryKey: ['chat', 'unread'], queryFn: api.chatUnread, enabled: available });
  return { available, unread: available ? (data?.count ?? 0) : 0 };
}

/** Läuft mindestens ein Druckserver? Teilt sich die Abfrage mit der Druckseite (Live-Thema „printing“). */
function usePrintingAvailable(): boolean {
  return !!useQuery({ queryKey: ['printing'], queryFn: api.printing }).data?.available;
}

const COLLAPSE_KEY = 'elvis.navCollapsed';

/** Seitenleiste auf dem Desktop auf die Icons einklappen – Zustand bleibt im Browser gespeichert. */
function useNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  return [collapsed, toggle];
}

const GROUPS_KEY = 'elvis.navGroupsOpen';

/** Aufgeklappte Gruppen (ELVIS lite) – bleiben im Browser gespeichert. */
function useOpenGroups(): [Set<string>, (label: string) => void] {
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (label: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  return [open, toggle];
}

type Badges = Record<NonNullable<NavItem['badge']>, number>;
const BADGE_TITLE: Record<keyof Badges, string> = { personnelSheets: 'neue Personalbögen', messages: 'Meldungen zu bearbeiten', mail: 'ungelesene Mails', chat: 'ungelesene Nachrichten' };

function NavEntry({ item, locked, lockReason, onNavigate, badges }: { item: NavItem; locked: boolean; lockReason?: string; onNavigate?: () => void; badges: Badges }) {
  const Icon = item.icon;
  const count = item.badge && !locked ? badges[item.badge] : 0;
  const title = [item.label, locked ? lockReason : count > 0 ? `${count} ${BADGE_TITLE[item.badge!]}` : undefined].filter(Boolean).join(' – ');
  return (
    <NavLink
      to={item.to}
      end={item.to === '/' || item.to === '/lage'}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''} ${locked ? 'locked' : ''}`}
      onClick={onNavigate}
      title={title}
    >
      <Icon size={20} />
      <span>{item.label}</span>
      {count > 0 && (
        <span className="nav-badge" title={`${count} ${BADGE_TITLE[item.badge!]}`} aria-label={`${count} neu`}>
          {count}
        </span>
      )}
      {locked && <Lock size={14} className="nav-lock" aria-label="gesperrt" />}
    </NavLink>
  );
}

export function Layout() {
  const { connection } = useLive();
  const vehicle = useSettings().data?.vehicle;
  const alerts = useAlerts();
  const { data: incident } = useActiveIncident();
  const { data: info } = useInfo();
  const dockerEnabled = info?.docker.enabled ?? false;
  const { user } = useAuth();
  const dark = effectiveTheme(useTheme()) === 'dark';
  const now = useNow();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [navCollapsed, toggleNav] = useNavCollapsed();
  const [openGroups, toggleGroup] = useOpenGroups();
  const unreadSheets = useUnreadSheets();
  const messageCount = useMessageAttention(now).attention.length;
  const mail = useMail();
  const chat = useChat();
  const printing = usePrintingAvailable();
  const badges: Badges = { personnelSheets: unreadSheets, messages: messageCount, mail: mail.unread, chat: chat.unread };

  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    document.title = vehicle?.name ? `ELVIS · ${vehicle.name}` : 'ELVIS';
  }, [vehicle?.name]);

  const alarmCount = alerts.filter((a) => a.severity === 'alarm').length;
  const alertTone = alarmCount > 0 ? 'alarm' : alerts.some((a) => a.severity === 'warn') ? 'warn' : 'muted';
  const allItems = NAV.flatMap((g) => g.items);

  const visible = (item: NavItem) =>
    (!item.requiresDocker || dockerEnabled) && (!item.requiresAdmin || user?.isAdmin) && (!item.requiresMail || mail.available) && (!item.requiresChat || chat.available) && (!item.requiresPrinting || printing);
  const lockOf = (item: NavItem) => {
    const needsLogin = !!item.requiresLogin && !user;
    return { locked: needsLogin || (!!item.requiresIncident && !incident), lockReason: needsLogin ? 'Anmeldung erforderlich' : 'Erst verfügbar, wenn eine Lage aufgelegt ist' };
  };
  const isCurrent = (item: NavItem) => (item.to === '/' ? location.pathname === '/' : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));

  const renderGroup = (group: NavGroup) => {
    const items = group.items.filter(visible);
    if (!items.length) return null;
    const entries = items.map((item) => <NavEntry key={item.to} item={item} {...lockOf(item)} badges={badges} />);
    if (group.collapsible) {
      const Icon = group.collapsible;
      // Die Gruppe mit der aktuellen Seite bleibt offen, sonst wäre die Markierung versteckt
      const expanded = openGroups.has(group.label) || items.some(isCurrent);
      const count = items.reduce((n, item) => n + (item.badge && !lockOf(item).locked ? badges[item.badge] : 0), 0);
      return (
        <div key={group.label} className={`nav-group nav-group-collapsible ${expanded ? 'open' : ''}`}>
          <button type="button" className="nav-item nav-item-button nav-group-toggle" onClick={() => toggleGroup(group.label)} aria-expanded={expanded} title={group.label}>
            <Icon size={20} />
            <span>{group.label}</span>
            {!expanded && count > 0 && (
              <span className="nav-badge" aria-label={`${count} neu`}>
                {count}
              </span>
            )}
            <ChevronDown size={16} className="nav-chevron" aria-hidden />
          </button>
          {expanded && <div className="nav-group-items">{entries}</div>}
        </div>
      );
    }
    return (
      <div key={group.label || 'start'} className="nav-group">
        {group.label && (
          <div className="nav-group-label">
            {group.label}
            {group.label === 'Lage' && incident && <span className="nav-live">aktiv</span>}
          </div>
        )}
        {entries}
      </div>
    );
  };

  const nav = (
    <nav className="nav" aria-label="Hauptnavigation">
      {navFor(info?.edition).map(renderGroup)}
      {dockerEnabled && (
        <div className="nav-group nav-footer">
          <CaCertLink />
        </div>
      )}
    </nav>
  );
  const version = info && <VersionTag edition={info.edition} version={info.version} linkToUpdate={info.edition === 'lite' && !!user?.isAdmin} />;

  return (
    <div className={`shell ${incident ? 'has-incident' : ''} ${navCollapsed ? 'nav-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand" title={navCollapsed ? `${vehicle?.name ?? 'ELVIS'} · ${vehicle?.callsign ?? ''}` : undefined}>
          <div className="brand-mark">E</div>
          <div className="brand-text">
            <div className="brand-name">{vehicle?.name ?? 'ELVIS'}</div>
            <div className="brand-sub">{vehicle?.callsign ?? '…'}</div>
          </div>
        </div>
        {nav}
        <div className="sidebar-footer">
          {version}
          <button
            type="button"
            className="btn btn-ghost btn-icon nav-collapse"
            onClick={toggleNav}
            aria-expanded={!navCollapsed}
            aria-label={navCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}
            title={navCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}
          >
            {navCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
        </div>
      </aside>

      <header className="topbar">
        <button className="btn btn-ghost btn-icon mobile-only menu-btn" onClick={() => setDrawerOpen(true)} aria-label={unreadSheets ? `Menü öffnen – ${unreadSheets} neue Personalbögen` : 'Menü öffnen'}>
          <Menu size={22} />
          {unreadSheets + messageCount + mail.unread > 0 && <span className="menu-dot" />}
        </button>

        <div className="clock" title={fmtWeekday(now)}>
          <div className="clock-dtg" aria-label={`Datum-Zeit-Gruppe ${fmtDtg(now)}`}>
            {fmtDtg(now)}
          </div>
          <div className="clock-detail">
            <span className="clock-time">{fmtTimeSec(now)}</span>
            <span className="clock-date">{fmtDate(now)}</span>
          </div>
        </div>

        <div className="topbar-right">
          <span className={`conn conn-${connection}`} title={connection === 'online' ? 'Live-Verbindung aktiv' : 'Verbindung unterbrochen'}>
            {connection === 'online' ? <Wifi size={18} /> : <WifiOff size={18} />}
            <span className="desktop-only">{connection === 'online' ? 'Live' : connection === 'connecting' ? 'Verbinde …' : 'Offline'}</span>
          </span>
          <MessagesButton />
          <DueTasksButton />
          <button className={`btn btn-ghost btn-icon alert-btn tone-${alertTone}`} onClick={() => setAlertsOpen((o) => !o)} aria-label={`${alerts.length} Meldungen`}>
            <Bell size={20} />
            {alerts.length > 0 && <span className={`alert-count badge-${alertTone}`}>{alerts.length}</span>}
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={toggleTheme}
            aria-label={dark ? 'Helles Design' : 'Dunkles Design'}
            title={dark ? 'Helles Design' : 'Dunkles Design'}
          >
            {dark ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <AccountMenu />
        </div>
      </header>

      {connection === 'offline' && <div className="banner banner-alarm">Verbindung zum Fahrzeugserver unterbrochen – Daten sind nicht aktuell.</div>}

      <main className="content">
        <Outlet />
      </main>

      <nav className="bottombar" aria-label="Schnellnavigation">
        {MOBILE_PRIMARY.filter((to) => inEdition(allItems.find((i) => i.to === to)!, info?.edition)).map((to) => {
          const item = allItems.find((i) => i.to === to)!;
          const Icon = item.icon;
          return (
            <NavLink key={to} to={to} end className={({ isActive }) => `bottom-item ${isActive ? 'active' : ''}`}>
              <Icon size={22} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
        <button className="bottom-item" onClick={() => setDrawerOpen(true)}>
          <Menu size={22} />
          <span>Mehr</span>
        </button>
      </nav>

      {drawerOpen && (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <div className="brand-name">{vehicle?.name ?? 'ELVIS'}</div>
              <button className="btn btn-ghost btn-icon" onClick={() => setDrawerOpen(false)} aria-label="Menü schließen">
                <X size={22} />
              </button>
            </div>
            {nav}
            {version}
          </div>
        </div>
      )}

      {alertsOpen && <AlertPanel onClose={() => setAlertsOpen(false)} />}
      <div className="panel-stack">
        <MessagesPanel />
        <DueTasksPanel />
      </div>
    </div>
  );
}

/** Versionsanzeige unten links im Menü; Admins in ELVIS lite kommen damit direkt zu Einstellungen → Update */
function VersionTag({ edition, version, linkToUpdate }: { edition: 'full' | 'lite'; version: string; linkToUpdate: boolean }) {
  const label = `${edition === 'lite' ? 'ELVIS lite' : 'ELVIS'} ${version === 'dev' ? '(Entwicklung)' : version}`;
  return linkToUpdate ? (
    <Link to="/einstellungen#update" className="nav-version" title="Einstellungen → Update">
      {label}
    </Link>
  ) : (
    <div className="nav-version">{label}</div>
  );
}
