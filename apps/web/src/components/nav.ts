import {
  Activity,
  ToggleRight,
  Archive,
  AtSign,
  BatteryCharging,
  BookOpenText,
  ClipboardPlus,
  CloudSun,
  Contact,
  FileStack,
  FileText,
  History,
  LayoutDashboard,
  Library,
  Mail,
  PackagePlus,
  ListChecks,
  Map,
  Package,
  Printer,
  ScanLine,
  Network,
  Radio,
  Cctv,
  MonitorSmartphone,
  MessagesSquare,
  Phone,
  PhoneCall,
  Server,
  Shapes,
  Settings,
  Siren,
  UserCog,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Edition } from '@elvis/shared';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Only usable while an incident is open. */
  requiresIncident?: boolean;
  /** Hidden when the Docker/addon management is disabled in the server config. */
  requiresDocker?: boolean;
  /** Braucht Fahrzeugtechnik (Gerätemodule) – in ELVIS lite ausgeblendet */
  requiresVehicle?: boolean;
  /** Locked for anonymous workstations. */
  requiresLogin?: boolean;
  /** Only shown to admins. */
  requiresAdmin?: boolean;
  /** Nur mit eingerichtetem Postfach (Einstellungen → E-Mail) */
  requiresMail?: boolean;
  /** Nur mit einem Kanal für Nachrichten (SMS über die Telefonie oder ein Messenger) */
  requiresChat?: boolean;
  /** Nur mit mindestens einem Druckserver (Addon) */
  requiresPrinting?: boolean;
  /** Zähler für Ungelesenes (siehe Layout) */
  badge?: 'personnelSheets' | 'messages' | 'mail' | 'chat';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  /** Einklappbare Gruppe (ELVIS lite): Kopfzeile mit diesem Icon, standardmäßig zu */
  collapsible?: LucideIcon;
}

export const NAV: NavGroup[] = [
  {
    label: 'Fahrzeug',
    items: [
      { to: '/', label: 'Übersicht', icon: LayoutDashboard },
      { to: '/karte', label: 'Karte', icon: Map },
      { to: '/wetter', label: 'Wetter', icon: CloudSun },
      { to: '/energie', label: 'Energie', icon: BatteryCharging, requiresVehicle: true },
      { to: '/funk', label: 'Funk', icon: Radio, requiresVehicle: true },
      { to: '/telefonie', label: 'Telefonie', icon: Phone, requiresVehicle: true },
      { to: '/telefone', label: 'Telefone', icon: PhoneCall, requiresLogin: true, requiresVehicle: true },
      { to: '/netzwerk', label: 'Netzwerk', icon: Network, requiresVehicle: true },
      { to: '/monitoring', label: 'Monitoring', icon: Activity, requiresVehicle: true },
      { to: '/logo', label: 'LOGO', icon: ToggleRight, requiresVehicle: true },
      { to: '/kameras', label: 'Kameras', icon: Cctv, requiresVehicle: true },
      { to: '/bildschirme', label: 'Bildschirme', icon: MonitorSmartphone, requiresVehicle: true },
      { to: '/drucken', label: 'Drucken', icon: Printer, requiresPrinting: true },
      { to: '/scans', label: 'Posteingang', icon: ScanLine, requiresLogin: true, badge: 'personnelSheets' },
      { to: '/mail', label: 'E-Mail', icon: AtSign, requiresLogin: true, requiresMail: true, badge: 'mail' },
      { to: '/nachrichten', label: 'Nachrichten', icon: MessagesSquare, requiresLogin: true, requiresChat: true, badge: 'chat' },
      { to: '/kontakte', label: 'Kontakte', icon: Contact, requiresLogin: true },
    ],
  },
  {
    label: 'Lage',
    items: [
      { to: '/lage', label: 'Lage', icon: Siren, requiresLogin: true },
      { to: '/lage/tagebuch', label: 'Einsatztagebuch', icon: BookOpenText, requiresLogin: true, requiresIncident: true },
      { to: '/lage/aufgaben', label: 'Aufgaben', icon: ListChecks, requiresLogin: true, requiresIncident: true },
      { to: '/lage/meldungen', label: 'Meldungen', icon: Mail, requiresLogin: true, requiresIncident: true, badge: 'messages' },
      { to: '/lage/anforderungen', label: 'Anforderungen', icon: PackagePlus, requiresLogin: true, requiresIncident: true },
      { to: '/lage/schadenkonten', label: 'Schadenkonten', icon: ClipboardPlus, requiresLogin: true, requiresIncident: true },
      { to: '/lage/kraefte', label: 'Kräfte', icon: Users, requiresLogin: true, requiresIncident: true },
      { to: '/lage/dokumente', label: 'Dokumente', icon: FileText, requiresLogin: true, requiresIncident: true },
    ],
  },
  {
    label: 'Verwaltung',
    items: [
      { to: '/archiv', label: 'Einsatzarchiv', icon: Archive, requiresLogin: true },
      { to: '/objekte', label: 'Objektbibliothek', icon: Library, requiresLogin: true },
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
export const MOBILE_PRIMARY = ['/', '/karte', '/wetter', '/lage'];

/** Nav-Einträge, die die Ausbaustufe überhaupt anbietet (ELVIS lite: ohne Fahrzeugtechnik) */
export const inEdition = (item: NavItem, edition: Edition | undefined) => !item.requiresVehicle || edition !== 'lite';

/**
 * Navigation der Ausbaustufe. In ELVIS lite zählt vor allem die Lage: Oben stehen Übersicht und die Lage,
 * alles andere liegt in den einklappbaren Gruppen „Werkzeuge“ und „Verwaltung“.
 */
export function navFor(edition: Edition | undefined): NavGroup[] {
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => inEdition(i, edition)) }));
  if (edition !== 'lite') return groups;
  const items = (label: string) => groups.find((g) => g.label === label)?.items ?? [];
  const isHome = (i: NavItem) => i.to === '/';
  const isSigns = (i: NavItem) => i.to === '/zeichen';
  return [
    { label: '', items: items('Fahrzeug').filter(isHome) },
    { label: 'Lage', items: items('Lage') },
    { label: 'Werkzeuge', items: [...items('Fahrzeug').filter((i) => !isHome(i)), ...items('Verwaltung').filter(isSigns)], collapsible: Wrench },
    { label: 'Verwaltung', items: items('Verwaltung').filter((i) => !isSigns(i)), collapsible: Settings },
  ];
}
