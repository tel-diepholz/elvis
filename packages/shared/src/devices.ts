/**
 * Device contracts. Every adapter (simulated or real hardware driver) publishes
 * exactly one of these state shapes, so the UI never depends on a concrete driver.
 */

import type { AddonOption, OptionValues } from './addons';
import type { BluetoothState } from './bluetooth';
import type { MonitoringState } from './monitoring';

export type SystemId = 'energy' | 'vehicle' | 'comms' | 'media' | 'weather';

export const SYSTEM_LABELS: Record<SystemId, string> = {
  energy: 'Energie',
  vehicle: 'Fahrzeug',
  comms: 'Kommunikation',
  media: 'Medien',
  weather: 'Wetter',
};

export interface GeoPosition {
  lat: number;
  lon: number;
  headingDeg: number | null;
  /** false wenn kein GPS-Fix vorliegt; Position ist dann die letzte bekannte. */
  fix: boolean;
}

export type RadioType = 'MRT' | 'FRT' | 'HRT';
export type RadioMode = 'TMO' | 'DMO';

export interface Talkgroup {
  id: string;
  name: string;
  mode: RadioMode;
  description?: string;
}

export interface RadioDevice {
  id: string;
  name: string;
  type: RadioType;
  workplace: string | null;
  issi: string;
  mode: RadioMode;
  talkgroupId: string;
  rssiDbm: number | null;
  fmsStatus: number | null;
  transmitting: boolean;
  receiving: boolean;
  online: boolean;
  lastActivity: string | null;
}

/**
 * Funkaktivität für die Timeline: Sprechen (tx), Hören (rx) als Zeitspanne, SDS, Status, Positionsmeldungen und
 * sonstige Ereignisse der Funkvermittlung als Zeitpunkt (end === start).
 */
export type RadioActivityKind = 'tx' | 'rx' | 'sds' | 'status' | 'gps' | 'event';

export interface RadioActivity {
  id: string;
  deviceId: string;
  kind: RadioActivityKind;
  start: string;
  /** null = läuft noch */
  end: string | null;
  /** Gegenstelle (ISSI): bei Empfang und eingehenden SDS/Status der Absender */
  peer: string | null;
  /** Rufgruppe des Gesprächs, falls bekannt */
  talkgroup?: string | null;
  /** SDS-Text, Statusbezeichnung oder Ereignisname */
  text: string | null;
}

export interface RadioState {
  talkgroups: Talkgroup[];
  devices: RadioDevice[];
  /** Aktivität der letzten Minuten, älteste zuerst (begrenzt) */
  activity: RadioActivity[];
  /** Was der Treiber kann – die Oberfläche blendet nicht unterstützte Bedienelemente aus. */
  capabilities: { talkgroupSwitch: boolean; statusSet: boolean };
  /** Verbindung zur Funkvermittlung (z. B. Reichert ZBE); null beim Simulator */
  link: { connected: boolean; target: string; error: string | null; lastTelegramAt: string | null } | null;
}

export type UplinkKind = 'lte' | '5g' | 'sat' | 'wan';

export interface Uplink {
  id: string;
  name: string;
  kind: UplinkKind;
  provider: string;
  online: boolean;
  signalPercent: number;
  rxMbps: number;
  txMbps: number;
  latencyMs: number | null;
}

export interface NetworkState {
  internet: boolean;
  primaryUplinkId: string;
  uplinks: Uplink[];
  wlan: { ssid: string; clients: number; guestEnabled: boolean };
  vpn: { connected: boolean; peer: string };
  dataUsageGb: number;
}

// --- ELW-Router (z. B. Teltonika RUTM59: ein Modem mit zwei SIM-Steckplätzen, ein WAN-Port) ---

export type SimStatus = 'connected' | 'registered' | 'searching' | 'standby' | 'no-sim' | 'pin-required' | 'puk-required' | 'denied' | 'error' | 'unknown';

export interface RouterSim {
  slot: number;
  /** Aktuell vom Modem benutzte SIM. Die andere ist Reserve; ihr Zustand ist nur bekannt, solange sie aktiv war. */
  active: boolean;
  status: SimStatus;
  /** Statustext des Routers (z. B. „Registered, home“) zur Diagnose. */
  detail: string | null;
  operator: string | null;
  /** z. B. „5G-NSA“, „LTE“ */
  networkType: string | null;
  band: string | null;
  signalPercent: number | null;
  rssiDbm: number | null;
  rsrpDbm: number | null;
  rsrqDb: number | null;
  sinrDb: number | null;
  roaming: boolean;
  iccid: string | null;
  /** Zeitpunkt der letzten Live-Werte (für die inaktive SIM: als sie zuletzt aktiv war). */
  seenAt: string | null;
}

export type UplinkStatus = 'online' | 'offline' | 'standby' | 'disabled' | 'unknown';

export interface RouterWan {
  /** Frei vergebene Bezeichnung aus den Moduleinstellungen, z. B. „LAN Feuerwache“. */
  name: string;
  /** Physischer Link am Port (Kabel steckt, Gegenstelle aktiv); null = nicht ermittelbar. */
  link: boolean | null;
  speedMbps: number | null;
  /** Schnittstelle hat eine IP-Konfiguration. */
  up: boolean;
  ip: string | null;
  gateway: string | null;
}

export interface FailoverMember {
  /** Schnittstellenname im Router, z. B. wan, mob1s1a1 */
  id: string;
  label: string;
  kind: 'wan' | 'sim';
  /** SIM-Steckplatz bei kind = 'sim' */
  slot: number | null;
  status: UplinkStatus;
  /** Rangfolge (1 = bevorzugt) */
  priority: number;
  active: boolean;
}

export interface RouterFailover {
  enabled: boolean;
  /** Über diese Verbindung läuft gerade der Verkehr. */
  activeId: string | null;
  /** Bevorzugte Verbindung ist ausgefallen, es läuft eine Ausweichverbindung. */
  onBackup: boolean;
  members: FailoverMember[];
}

export interface DhcpLease {
  ip: string;
  mac: string;
  hostname: string | null;
  /** Netz/Schnittstelle des Routers, z. B. lan */
  interface: string | null;
  /** Ablaufzeitpunkt (auf die Minute gerundet); null = unbegrenzt */
  expiresAt: string | null;
  /** Feste Zuweisung (statischer Lease) im Router */
  static: boolean;
  /** Name der festen Zuweisung, falls vergeben */
  name: string | null;
}

export interface RouterState {
  model: string | null;
  internet: boolean;
  wan: RouterWan;
  sims: RouterSim[];
  failover: RouterFailover;
  /** Vergebene DHCP-Leases (IPv4); null = vom Router nicht abrufbar */
  leases: DhcpLease[] | null;
}

// --- Kameras (z. B. Axis über VAPIX) ---

export type CameraType = 'axis' | 'demo';
export type DayNightMode = 'auto' | 'day' | 'night';

/** Was die Kamera kann – daraus ergeben sich die Bedienelemente. */
export interface CameraCaps {
  panTilt: boolean;
  zoom: boolean;
  /** Zoom per Gedrückthalten (PTZ-Kameras); sonst in Schritten */
  continuousZoom: boolean;
  focus: boolean;
  autofocus: boolean;
  dayNight: boolean;
  home: boolean;
  /** Bedeutung des Zoomwerts: Vergrößerungsfaktor, Anteil 0…1 oder Rohschritte 1…9999 */
  zoomUnit: 'factor' | 'fraction' | 'steps' | null;
}

/** Absolute Position; null = von dieser Kamera nicht unterstützt. */
export interface CameraPosition {
  pan: number | null;
  tilt: number | null;
  zoom: number | null;
  focus: number | null;
}

export interface CameraStatus {
  id: string;
  name: string;
  type: CameraType;
  online: boolean;
  error: string | null;
  model: string | null;
  caps: CameraCaps;
  position: CameraPosition | null;
  dayNight: DayNightMode | null;
}

export interface CamerasState {
  cameras: CameraStatus[];
}

/** Kamera in den Einstellungen (Passwort wird nie ausgeliefert). */
export interface CameraConfig {
  id: string;
  name: string;
  type: CameraType;
  host: string;
  protocol: 'http' | 'https';
  username: string;
  verifyTls: boolean;
  /** Auflösung des Livebilds, z. B. 1280x720 */
  resolution: string;
  enabled: boolean;
  sort: number;
  passwordSet: boolean;
}

export interface CameraConfigInput {
  name: string;
  type: CameraType;
  host: string;
  protocol: 'http' | 'https';
  username: string;
  /** leer = unverändert */
  password: string;
  verifyTls: boolean;
  resolution: string;
  enabled: boolean;
}

export interface CameraTestResult {
  ok: boolean;
  model: string | null;
  caps: CameraCaps | null;
  message: string;
}

/** Gespeicherte Kameraposition; gehört zum laufenden Einsatz. */
export interface CameraPreset {
  id: number;
  incidentId: number;
  cameraId: string;
  name: string;
  position: CameraPosition;
  createdAt: string;
  createdBy: string;
}

// --- WLAN-Accesspoints (OpenWrt) ---

/** Erreichbarkeit eines APs laut letzter Abfrage der angemeldeten Geräte */
export interface WifiApLive {
  id: string;
  name: string;
  online: boolean;
  error: string | null;
  /** Angemeldete Geräte je Netz */
  clients: { ops: number; guest: number };
}

/** Die Geräte selbst stehen in der Tabelle wifi_clients (GET /api/wifi/clients), nicht im Zustand */
export interface WifiState {
  aps: WifiApLive[];
}

// --- Videoquellen aus Addons (z. B. NDI-Gateway) ---

export type VideoStreamState = 'starting' | 'running' | 'error';

export interface VideoStream {
  /** eindeutig über alle Gateways: <anbieter>:<pfad> */
  id: string;
  providerId: string;
  /** Name der Quelle, z. B. NDI-Name „STUDIO (Kamera 1)“ */
  name: string;
  state: VideoStreamState;
  error: string | null;
  /** WebRTC-Player (MediaMTX) für den Browser */
  url: string;
}

export interface VideoProvider {
  id: string;
  name: string;
  /** Gateway antwortet */
  online: boolean;
  /** z. B. „Encoder nicht verfügbar“ oder „NDI-Laufzeit fehlt“ */
  problem: string | null;
  encoder: string | null;
  resolution: string | null;
  /** Gefundene, aber (noch) nicht gestreamte Quellen */
  discovered: string[];
}

export interface VideoSources {
  providers: VideoProvider[];
  streams: VideoStream[];
}

export interface MediaSource {
  id: string;
  name: string;
}

export interface Display {
  id: string;
  name: string;
  location: string;
  power: boolean;
  sourceId: string | null;
}

export interface Camera {
  id: string;
  name: string;
  online: boolean;
  ptz: boolean;
  presets: { id: string; name: string }[];
  activePresetId: string | null;
  snapshotUrl: string | null;
}

export interface MediaState {
  sources: MediaSource[];
  displays: Display[];
  cameras: Camera[];
}

/**
 * Wetterstation; Airmar-Stationen liefern zusätzlich GPS-Position und Kurs des Fahrzeugs.
 * Werte, die ein Sensor nicht misst (oder noch nicht gemeldet hat), sind null.
 */
export interface WeatherState {
  /** Fahrzeugstandort (GPS der Wetterstation), null ohne GPS. */
  position: GeoPosition | null;
  /** Mittelwind (gleitend über 2 min). */
  windSpeedMs: number | null;
  /** Böe: höchster 3-Sekunden-Mittelwert der letzten 10 min. */
  windGustMs: number | null;
  /** Richtung, aus der der Wind kommt, bezogen auf geografisch Nord. */
  windDirectionDeg: number | null;
  temperatureC: number | null;
  humidityPercent: number | null;
  pressureHpa: number | null;
  precipitationMmH: number | null;
  /** Weitere Angaben des GPS-Empfängers, null ohne GPS. */
  gnss: GnssInfo | null;
}

/** Art der Positionsbestimmung nach NMEA 2000 (PGN 129029). */
export type GnssMethod = 'none' | 'gnss' | 'dgnss' | 'precise' | 'rtk-fixed' | 'rtk-float' | 'estimated' | 'manual' | 'simulated';

export interface GnssInfo {
  method: GnssMethod | null;
  satellites: number | null;
  /** Horizontale Genauigkeitsminderung (HDOP): unter 1 sehr gut, über 5 ungenau. */
  hdop: number | null;
  /** Höhe über NN (Ellipsoidhöhe abzüglich Geoidundulation, sonst wie gemeldet). */
  altitudeM: number | null;
  /** Geschwindigkeit über Grund. */
  speedMs: number | null;
  /** Kurs über Grund, rechtweisend; nur in Fahrt aussagekräftig. */
  courseDeg: number | null;
  /** Neigung des Sensors: Nicken (vorn hoch positiv) und Rollen (rechts runter positiv). */
  pitchDeg: number | null;
  rollDeg: number | null;
  /** Uhrzeit laut GPS (ISO) und deren Abweichung von der Server-Uhr in Sekunden (GPS minus Server). */
  time: string | null;
  clockOffsetS: number | null;
}

export interface DeviceStateMap {
  radio: RadioState;
  network: NetworkState;
  router: RouterState;
  cameras: CamerasState;
  wifi: WifiState;
  media: MediaState;
  weather: WeatherState;
  monitoring: MonitoringState;
  bluetooth: BluetoothState;
}

export type DeviceId = keyof DeviceStateMap;

export const DEVICE_IDS: readonly DeviceId[] = ['router', 'wifi', 'cameras', 'radio', 'network', 'media', 'weather', 'monitoring', 'bluetooth'];

export interface DeviceSnapshot<K extends DeviceId = DeviceId> {
  id: K;
  name: string;
  system: SystemId;
  driver: string;
  online: boolean;
  updatedAt: string;
  state: DeviceStateMap[K];
}

export interface CommandRequest {
  action: string;
  params?: Record<string, unknown>;
}

export interface CommandResponse {
  ok: boolean;
  message?: string;
}

// --- Konfiguration der Fahrzeugmodule (Einstellungen, nur Admins) ---

/** Treiber eines Moduls; `options` beschreibt das Formular (gleiches Schema wie bei Addons). */
export interface DeviceDriverInfo {
  id: string;
  label: string;
  description: string;
  options: Record<string, AddonOption>;
}

export interface DeviceModuleConfig {
  enabled: boolean;
  driver: string;
  options: OptionValues;
}

export interface DeviceModule {
  id: DeviceId;
  name: string;
  system: SystemId;
  config: DeviceModuleConfig;
  /** Herkunft der Konfiguration: in der Oberfläche gespeichert oder Vorgabe aus config/elvis.json. */
  source: 'settings' | 'config';
  drivers: DeviceDriverInfo[];
  online: boolean | null;
  error: string | null;
  /** Passwörter werden nie ausgeliefert; gesetzte Passwortfelder stehen hier. */
  secretsSet: string[];
}

export interface SerialPortInfo {
  /** Bevorzugt der stabile Pfad /dev/serial/by-id/…, sonst /dev/tty… */
  path: string;
  device: string;
  label: string;
}
