import {
  Activity,
  Archive,
  BatteryCharging,
  BookOpenText,
  CloudSun,
  FileStack,
  FileText,
  History,
  LayoutDashboard,
  ListChecks,
  Map,
  Package,
  Printer,
  ScanLine,
  Network,
  Cctv,
  MonitorSmartphone,
  Server,
  Shapes,
  Settings,
  Siren,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Only usable while an incident is open. */
  requiresIncident?: boolean;
  /** Hidden when the Docker/addon management is disabled in the server config. */
  requiresDocker?: boolean;
  /** Locked for anonymous workstations. */
  requiresLogin?: boolean;
  /** Only shown to admins. */
  requiresAdmin?: boolean;
  /** Zähler für Ungelesenes (siehe Layout) */
  badge?: 'personnelSheets';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: 'Fahrzeug',
    items: [
      { to: '/', label: 'Übersicht', icon: LayoutDashboard },
      { to: '/karte', label: 'Karte', icon: Map },
      { to: '/wetter', label: 'Wetter', icon: CloudSun },
      { to: '/energie', label: 'Energie', icon: BatteryCharging },
      { to: '/netzwerk', label: 'Netzwerk', icon: Network },
      { to: '/monitoring', label: 'Monitoring', icon: Activity },
      { to: '/kameras', label: 'Kameras', icon: Cctv },
      { to: '/bildschirme', label: 'Bildschirme', icon: MonitorSmartphone },
      { to: '/drucken', label: 'Drucken', icon: Printer },
      { to: '/scans', label: 'Dokumenten-Eingang', icon: ScanLine, requiresLogin: true, badge: 'personnelSheets' },
    ],
  },
  {
    label: 'Einsatz',
    items: [
      { to: '/einsatz', label: 'Einsatz', icon: Siren, requiresLogin: true },
      { to: '/einsatz/tagebuch', label: 'Einsatztagebuch', icon: BookOpenText, requiresLogin: true, requiresIncident: true },
      { to: '/einsatz/aufgaben', label: 'Aufgaben', icon: ListChecks, requiresLogin: true, requiresIncident: true },
      { to: '/einsatz/kraefte', label: 'Kräfte', icon: Users, requiresLogin: true, requiresIncident: true },
      { to: '/einsatz/dokumente', label: 'Dokumente', icon: FileText, requiresLogin: true, requiresIncident: true },
    ],
  },
  {
    label: 'Verwaltung',
    items: [
      { to: '/archiv', label: 'Einsatzarchiv', icon: Archive, requiresLogin: true },
      { to: '/vorlagen', label: 'Vorlagen', icon: FileStack, requiresLogin: true, requiresAdmin: true },
      { to: '/benutzer', label: 'Benutzer', icon: UserCog, requiresLogin: true },
      { to: '/addons', label: 'Addons', icon: Package, requiresDocker: true, requiresAdmin: true },
      { to: '/docker-hosts', label: 'Docker-Hosts', icon: Server, requiresDocker: true, requiresAdmin: true },
      { to: '/zeichen', label: 'Taktische Zeichen', icon: Shapes },
      { to: '/protokoll', label: 'Bedienprotokoll', icon: History, requiresLogin: true, requiresAdmin: true },
      { to: '/einstellungen', label: 'Einstellungen', icon: Settings, requiresLogin: true, requiresAdmin: true },
    ],
  },
];

/** Primary destinations in the mobile bottom bar; everything else lives in the menu drawer. */
export const MOBILE_PRIMARY = ['/', '/karte', '/wetter', '/einsatz'];
