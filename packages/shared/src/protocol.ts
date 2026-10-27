import type { DisplayCommand, DisplayMapView } from './displays';
import type { DeviceId, DeviceSnapshot, SystemId } from './devices';

export type AlertSeverity = 'info' | 'warn' | 'alarm';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  system: SystemId;
  title: string;
  detail?: string;
  since: string;
}

export interface VehicleInfo {
  name: string;
  callsign: string;
  organization: string;
}

/** Topics a client should refetch via REST when invalidated. */
export type Topic = 'incident' | 'journal' | 'units' | 'forces' | 'documents' | 'audit' | 'dockerHosts' | 'addons' | 'mapSources' | 'users' | 'settings' | 'devices' | 'cameras' | 'cameraPresets' | 'displays' | 'videoSources' | 'mapObjects' | 'wifi' | 'wifiClients' | 'monitoring' | 'bluetooth' | 'templates' | 'office' | 'roles' | 'tasks' | 'taskTemplates' | 'printing' | 'scans' | 'workstations' | 'appLinks' | 'personnel' | 'personnelSheets' | 'messages' | 'overpassQueries' | 'requests';

export type ServerMessage =
  | {
      type: 'hello';
      serverTime: string;
      vehicle: VehicleInfo;
      devices: DeviceSnapshot[];
      alerts: Alert[];
    }
  | { type: 'device'; device: DeviceSnapshot }
  /** Modul deaktiviert: Zustand aus der Anzeige entfernen. */
  | { type: 'deviceRemoved'; id: DeviceId }
  | { type: 'alerts'; alerts: Alert[] }
  | { type: 'invalidate'; topics: Topic[] }
  /** Nur an den betroffenen Bildschirm */
  | { type: 'displayCommand'; action: DisplayCommand }
  /** Kartenausschnitt aus ELVIS übernehmen (Fernsteuerung) */
  | { type: 'displayMapView'; tileId: string; view: DisplayMapView };

