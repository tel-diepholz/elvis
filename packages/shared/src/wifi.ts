import { z } from 'zod';

/**
 * WLAN über OpenWrt-Accesspoints: ELVIS richtet auf allen APs das Betriebs-WLAN ein und schaltet für die Dauer eines
 * Einsatzes ein Gastnetz zu. Die Gastnetz-Bridge muss auf dem AP bereits als Schnittstelle eingerichtet sein.
 */

/** Höchstlänge des Gastnetz-Namens ohne den Einsatzzusatz (SSID max. 32 Byte) */
export const WIFI_GUEST_SSID_MAX = 24;

const ssid = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => new TextEncoder().encode(s).length <= max, `Höchstens ${max} Byte`);

/** WPA2-Passwort: 8 bis 63 Zeichen; leer = unverändert */
const psk = z.string().refine((s) => s === '' || (s.length >= 8 && s.length <= 63), 'Passwort: 8 bis 63 Zeichen');

export const wifiSettingsInputSchema = z
  .object({
    ops: z.object({ enabled: z.boolean(), ssid: ssid(32), password: psk }),
    guest: z.object({ enabled: z.boolean(), ssid: ssid(WIFI_GUEST_SSID_MAX) }),
  })
  .superRefine((v, ctx) => {
    if (v.ops.enabled && !v.ops.ssid) ctx.addIssue({ code: 'custom', path: ['ops', 'ssid'], message: 'Netzname fehlt' });
    if (v.guest.enabled && !v.guest.ssid) ctx.addIssue({ code: 'custom', path: ['guest', 'ssid'], message: 'Netzname fehlt' });
  });

export type WifiSettingsInput = z.input<typeof wifiSettingsInputSchema>;

/** Einstellungen (Passwort des Betriebs-WLANs wird nie ausgeliefert) */
export interface WifiSettings {
  ops: { enabled: boolean; ssid: string; passwordSet: boolean };
  guest: { enabled: boolean; ssid: string };
}

/** Gastnetz des laufenden Einsatzes; für Bildschirme und angemeldete Benutzer lesbar */
export type WifiGuestInfo = { active: false; reason: string } | { active: true; ssid: string; password: string; incidentId: number };

/** Netzname des Gastnetzes im Einsatz: eingestellter Name mit angehängter Einsatznummer */
export const guestSsid = (base: string, incidentId: number) => `${base}-${incidentId}`;

/** Inhalt des QR-Codes zum Verbinden (Format der Android-/iOS-Kamera-Apps) */
export function wifiQrPayload(ssid: string, password: string): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, '\\$1');
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`;
}

export interface WifiApConfig {
  id: string;
  name: string;
  host: string;
  protocol: 'http' | 'https';
  username: string;
  verifyTls: boolean;
  /** OpenWrt-Schnittstelle für das Betriebs-WLAN (meist lan) */
  opsNetwork: string;
  /** OpenWrt-Schnittstelle (Bridge) des Gastnetzes; leer = kein Gastnetz auf diesem AP */
  guestNetwork: string;
  enabled: boolean;
  sort: number;
  passwordSet: boolean;
}

export interface WifiApConfigInput {
  name: string;
  host: string;
  protocol: 'http' | 'https';
  username: string;
  /** leer = unverändert */
  password: string;
  verifyTls: boolean;
  opsNetwork: string;
  guestNetwork: string;
  enabled: boolean;
}

export type WifiApState = 'ok' | 'error' | 'disabled' | 'pending';

/** Ergebnis des letzten Abgleichs mit einem AP (nur im Speicher des Servers) */
export interface WifiApStatus {
  state: WifiApState;
  message: string | null;
  /** Funkmodule des APs, z. B. „radio0 (2,4 GHz)“ */
  radios: string[];
  /** Letzter erfolgreicher Abgleich */
  syncedAt: string | null;
}

export interface WifiAp extends WifiApConfig {
  status: WifiApStatus;
}

/** Antwort auf GET /api/system/wifi */
export interface WifiOverview {
  settings: WifiSettings;
  guest: WifiGuestInfo;
  aps: WifiAp[];
}

export interface WifiApTestResult {
  ok: boolean;
  message: string;
}

/** Am WLAN angemeldetes Gerät (Tabelle wifi_clients, vom Modul „WLAN-Accesspoints“ alle paar Sekunden aktualisiert) */
export interface WifiClient {
  mac: string;
  /** Gerätename laut AP (DHCP/Hosts), sonst null */
  name: string | null;
  /** IPv4-Adresse laut AP (ARP/DHCP), sonst null */
  ip: string | null;
  network: 'ops' | 'guest';
  ssid: string;
  apId: string;
  apName: string;
  /** z. B. 5 GHz */
  band: string | null;
  signalDbm: number | null;
  /** Datenrate in kbit/s */
  rxRateKbps: number | null;
  txRateKbps: number | null;
  /** Verbunden seit (Sekunden, laut AP) */
  connectedSec: number | null;
  /** Zuletzt beim AP gesehen */
  lastSeen: string;
}
