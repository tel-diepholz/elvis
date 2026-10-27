import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bluetooth,
  Cctv,
  CloudSun,
  Database,
  FolderTree,
  Laptop,
  ListTodo,
  Mail,
  Map as MapIcon,
  MonitorPlay,
  MonitorSmartphone,
  Network,
  Plane,
  Printer,
  Radio,
  Router,
  ScanLine,
  Smartphone,
  Truck,
  UserRoundCog,
  Users,
  PackagePlus,
  Wifi,
} from 'lucide-react';
import type { DeviceId } from '@elvis/shared';
import { api } from '../lib/api';
import { useSettings } from '../lib/hooks';
import { SettingsGroup, SettingsSection } from '../components/SettingsSection';
import { Loading, PageHeader } from '../components/ui';
import { AppRelayCard } from './system/AppRelayCard';
import { BluetoothCard } from './system/BluetoothCard';
import { CamerasCard } from './system/CamerasCard';
import { DisplaysCard } from './system/DisplaysCard';
import { DocumentFoldersCard } from './system/DocumentFoldersCard';
import { ForcesCard } from './system/ForcesCard';
import { MapSourcesCard } from './system/MapSourcesCard';
import { MessageSettingsCard } from './system/MessageSettingsCard';
import { RequestSettingsCard } from './system/RequestSettingsCard';
import { OverpassQueriesCard } from './system/OverpassQueriesCard';
import { ModuleSection } from './system/ModuleSection';
import { MonitoringCard } from './system/MonitoringCard';
import { PrintSettingsCard } from './system/PrintSettingsCard';
import { RolesCard } from './system/RolesCard';
import { ScanSettingsCard } from './system/ScanSettingsCard';
import { SettingsCard } from './system/SettingsCard';
import { TaskTemplatesCard } from './system/TaskTemplatesCard';
import { TrafficCard } from './system/TrafficCard';
import { WifiApsCard, WifiCard } from './system/WifiCard';
import { WorkstationsCard } from './system/WorkstationsCard';

const ICON = { size: 18 };

/** Symbol und Geräte je Fahrzeugmodul; die Geräte erscheinen im aufgeklappten Modul unter Treiber und Einstellungen */
const MODULE_PARTS: Partial<Record<DeviceId, { icon: ReactNode; devices?: ReactNode }>> = {
  router: { icon: <Router {...ICON} /> },
  wifi: {
    icon: <Wifi {...ICON} />,
    devices: (
      <>
        <WifiCard />
        <WifiApsCard />
      </>
    ),
  },
  cameras: { icon: <Cctv {...ICON} />, devices: <CamerasCard /> },
  monitoring: { icon: <Activity {...ICON} />, devices: <MonitoringCard /> },
  bluetooth: { icon: <Bluetooth {...ICON} />, devices: <BluetoothCard /> },
  radio: { icon: <Radio {...ICON} /> },
  network: { icon: <Network {...ICON} /> },
  media: { icon: <MonitorPlay {...ICON} /> },
  weather: { icon: <CloudSun {...ICON} /> },
};

/**
 * Einstellungen (nur Admins): Fahrzeug, Fahrzeugmodule mit ihren Geräten, Dienste und Einsatz – je Thema ein
 * aufklappbarer Abschnitt. Links von anderen Seiten öffnen einen Abschnitt direkt, z. B. /einstellungen#modul-bluetooth.
 */
export function SettingsPage() {
  const vehicle = useSettings().data?.vehicle;
  const { data: modules } = useQuery({ queryKey: ['devices'], queryFn: api.deviceModules });

  return (
    <>
      <PageHeader title="Einstellungen" subtitle={vehicle ? `${vehicle.organization} · ${vehicle.callsign}` : undefined} />
      <div className="settings">
        <SettingsGroup title="Fahrzeug">
          <SettingsSection id="fahrzeug" title="Fahrzeug & Einheit" icon={<Truck {...ICON} />} summary={vehicle && `${vehicle.name} · ${vehicle.callsign}`}>
            <SettingsCard />
          </SettingsSection>
        </SettingsGroup>

        <SettingsGroup title="Fahrzeugmodule">
          {!modules ? (
            <Loading />
          ) : (
            modules.map((m) => (
              <ModuleSection key={m.id} module={m} icon={MODULE_PARTS[m.id]?.icon}>
                {MODULE_PARTS[m.id]?.devices}
              </ModuleSection>
            ))
          )}
        </SettingsGroup>

        <SettingsGroup title="Dienste">
          <SettingsSection id="bildschirme" title="Bildschirme" icon={<MonitorSmartphone {...ICON} />} summary="Kiosk-Bildschirme koppeln und belegen">
            <DisplaysCard />
          </SettingsSection>
          <SettingsSection id="arbeitsplaetze" title="Arbeitsplätze" icon={<Laptop {...ICON} />} summary="Notebooks per PXE, Updates">
            <WorkstationsCard />
          </SettingsSection>
          <SettingsSection id="karten" title="Kartenquellen" icon={<MapIcon {...ICON} />} summary="Kartenstile, Luftbilder (WMS)">
            <MapSourcesCard />
          </SettingsSection>
          <SettingsSection id="overpass" title="Overpass-Vorlagen" icon={<Database {...ICON} />} summary="OpenStreetMap-Abfragen im Menü „Objekte“ der Karte">
            <OverpassQueriesCard />
          </SettingsSection>
          <SettingsSection id="verkehr" title="Luft- und Schiffsverkehr" icon={<Plane {...ICON} />} summary="Flugzeuge (ADS-B/MLAT) und Schiffe (AIS) auf der Karte">
            <TrafficCard />
          </SettingsSection>
          <SettingsSection id="drucken" title="Druckserver" icon={<Printer {...ICON} />} summary="Ablage im Einsatz, vorausgewählter Drucker">
            <PrintSettingsCard />
          </SettingsSection>
          <SettingsSection id="scannen" title="Scannen" icon={<ScanLine {...ICON} />} summary="Scan an E-Mail">
            <ScanSettingsCard />
          </SettingsSection>
          <SettingsSection id="dokumente" title="Ordnervorgabe für Dokumente" icon={<FolderTree {...ICON} />} summary="Ordner je Einsatz">
            <DocumentFoldersCard />
          </SettingsSection>
          <SettingsSection id="app" title="App-Anbindung" icon={<Smartphone {...ICON} />} summary="Positionen von Einsatzkräften per App">
            <AppRelayCard />
          </SettingsSection>
        </SettingsGroup>

        <SettingsGroup title="Einsatz">
          <SettingsSection id="rollen" title="Rollen im Einsatz" icon={<UserRoundCog {...ICON} />}>
            <RolesCard />
          </SettingsSection>
          <SettingsSection id="kraefte" title="Kräfteverwaltung" icon={<Users {...ICON} />} summary="Einheiten und Fahrzeuge zur Auswahl">
            <ForcesCard />
          </SettingsSection>
          <SettingsSection id="aufgaben" title="Aufgabenvorlagen" icon={<ListTodo {...ICON} />}>
            <TaskTemplatesCard />
          </SettingsSection>
          <SettingsSection id="meldungen" title="Meldungen" icon={<Mail {...ICON} />} summary="Fernmelder und Dispatcher">
            <MessageSettingsCard />
          </SettingsSection>
          <SettingsSection id="anforderungen" title="Anforderungen" icon={<PackagePlus {...ICON} />} summary="Beschaffungsrolle">
            <RequestSettingsCard />
          </SettingsSection>
        </SettingsGroup>
      </div>
    </>
  );
}
