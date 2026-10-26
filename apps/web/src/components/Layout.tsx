import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bell, Lock, Menu, Moon, Sun, Wifi, WifiOff, X } from 'lucide-react';
import { useActiveIncident, useInfo, useNow, useSettings } from '../lib/hooks';
import { useAlerts, useLive } from '../lib/live';
import { fmtDate, fmtDtg, fmtTimeSec, fmtWeekday } from '../lib/format';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { effectiveTheme, toggleTheme, useTheme } from '../lib/theme';
import { AlertPanel } from './AlertPanel';
import { AccountMenu } from './auth/AccountMenu';
import { DueTasksButton, DueTasksPanel } from './tasks/DueTasks';
import { MessagesButton, MessagesPanel } from './messages/MessageAlerts';
import { useMessageAttention } from './messages/messageHooks';
import { MOBILE_PRIMARY, NAV, type NavItem } from './nav';

/** Neue Personalbögen im Posteingang */
function useUnreadSheets(): number {
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ['personnelSheets', 'unread'], queryFn: api.personnelUnread, enabled: !!user });
  return user ? (data?.count ?? 0) : 0;
}

type Badges = Record<NonNullable<NavItem['badge']>, number>;
const BADGE_TITLE: Record<keyof Badges, string> = { personnelSheets: 'neue Personalbögen', messages: 'Meldungen zu bearbeiten' };

function NavEntry({ item, locked, lockReason, onNavigate, badges }: { item: NavItem; locked: boolean; lockReason?: string; onNavigate?: () => void; badges: Badges }) {
  const Icon = item.icon;
  const count = item.badge && !locked ? badges[item.badge] : 0;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/' || item.to === '/einsatz'}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''} ${locked ? 'locked' : ''}`}
      onClick={onNavigate}
      title={locked ? lockReason : undefined}
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
  const unreadSheets = useUnreadSheets();
  const messageCount = useMessageAttention(now).attention.length;
  const badges: Badges = { personnelSheets: unreadSheets, messages: messageCount };

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const alarmCount = alerts.filter((a) => a.severity === 'alarm').length;
  const alertTone = alarmCount > 0 ? 'alarm' : alerts.some((a) => a.severity === 'warn') ? 'warn' : 'muted';
  const allItems = NAV.flatMap((g) => g.items);

  const nav = (
    <nav className="nav" aria-label="Hauptnavigation">
      {NAV.map((group) => (
        <div key={group.label} className="nav-group">
          <div className="nav-group-label">
            {group.label}
            {group.label === 'Einsatz' && incident && <span className="nav-live">aktiv</span>}
          </div>
          {group.items
            .filter((item) => (!item.requiresDocker || dockerEnabled) && (!item.requiresAdmin || user?.isAdmin))
            .map((item) => {
              const needsLogin = !!item.requiresLogin && !user;
              const noIncident = !!item.requiresIncident && !incident;
              return (
                <NavEntry
                  key={item.to}
                  item={item}
                  locked={needsLogin || noIncident}
                  lockReason={needsLogin ? 'Anmeldung erforderlich' : 'Erst verfügbar, wenn ein Einsatz aufgelegt ist'}
                  badges={badges}
                />
              );
            })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className={`shell ${incident ? 'has-incident' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">E</div>
          <div>
            <div className="brand-name">{vehicle?.name ?? 'ELVIS'}</div>
            <div className="brand-sub">{vehicle?.callsign ?? '…'}</div>
          </div>
        </div>
        {nav}
      </aside>

      <header className="topbar">
        <button className="btn btn-ghost btn-icon mobile-only menu-btn" onClick={() => setDrawerOpen(true)} aria-label={unreadSheets ? `Menü öffnen – ${unreadSheets} neue Personalbögen` : 'Menü öffnen'}>
          <Menu size={22} />
          {unreadSheets + messageCount > 0 && <span className="menu-dot" />}
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
        {MOBILE_PRIMARY.map((to) => {
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
