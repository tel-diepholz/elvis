import { z } from 'zod';

/**
 * Luft- und Schiffsverkehr: Flugzeuge (ADS-B/MLAT, z. B. adsb.fi) und Schiffe (AIS, aisstream.io) für die
 * Kartenebenen. Einzelne Ziele lassen sich als Kartenobjekt („aircraft“/„ship“) verfolgen.
 */

export type AircraftSource = 'adsb' | 'mlat' | 'other';

export interface Aircraft {
  /** ICAO-Adresse (6 Hex-Zeichen, klein; „~…“ für Ziele ohne ICAO-Adresse) */
  hex: string;
  callsign: string | null;
  registration: string | null;
  /** ICAO-Typkürzel, z. B. A320 */
  type: string | null;
  lat: number;
  lon: number;
  /** Barometrische Höhe in Fuß; null = unbekannt */
  altFt: number | null;
  onGround: boolean;
  speedKt: number | null;
  /** Kurs über Grund in Grad */
  track: number | null;
  squawk: string | null;
  /** ADS-B-Kategorie, z. B. A3 (Verkehrsflugzeug), A7 (Hubschrauber) */
  category: string | null;
  source: AircraftSource;
  /** Alter der Position in Sekunden */
  seenS: number;
}

export interface Ship {
  /** MMSI (9 Ziffern) */
  mmsi: string;
  name: string | null;
  callsign: string | null;
  /** AIS-Schiffstyp (Zahl 0–99) */
  shipType: number | null;
  lat: number;
  lon: number;
  /** Fahrt über Grund in Knoten */
  sogKn: number | null;
  /** Kurs über Grund in Grad */
  cog: number | null;
  heading: number | null;
  navStatus: number | null;
  destination: string | null;
  seenAt: string;
}

export interface TrafficResult<T> {
  items: T[];
  /** Herkunft der Daten für die Quellenangabe */
  source: string | null;
  /** Hinweis, wenn nichts geladen werden konnte (z. B. Dienst nicht erreichbar, kein Schlüssel) */
  problem: string | null;
}

export type TrafficHit = ({ kind: 'aircraft' } & Aircraft) | ({ kind: 'ship' } & Ship);

/** Höchster Radius einer Abfrage (Nautische Meilen) */
export const MAX_TRAFFIC_RADIUS_NM = 250;

/** AIS-Navigationsstatus (Auswahl) */
export const NAV_STATUS: Record<number, string> = {
  0: 'in Fahrt (Maschine)',
  1: 'vor Anker',
  2: 'manövrierunfähig',
  3: 'manövrierbehindert',
  5: 'festgemacht',
  6: 'auf Grund',
  7: 'beim Fischen',
  8: 'in Fahrt (Segel)',
};

/** Grobe Einordnung des AIS-Schiffstyps */
export function shipTypeLabel(t: number | null): string | null {
  if (t == null || t <= 0) return null;
  if (t === 30) return 'Fischereifahrzeug';
  if (t === 31 || t === 32 || t === 52) return 'Schlepper';
  if (t === 35) return 'Militär';
  if (t === 36) return 'Segelboot';
  if (t === 37) return 'Sportboot';
  if (t === 50) return 'Lotsenfahrzeug';
  if (t === 51) return 'SAR';
  if (t === 55) return 'Behörde';
  if (t === 58) return 'Sanitätsfahrzeug';
  if (t >= 60 && t <= 69) return 'Fahrgastschiff';
  if (t >= 70 && t <= 79) return 'Frachtschiff';
  if (t >= 80 && t <= 89) return 'Tanker';
  return 'sonstiges Schiff';
}

/** Flugfläche bzw. Höhe für Label und Liste */
export function formatAltitude(altFt: number | null, onGround = false): string {
  if (onGround) return 'am Boden';
  if (altFt == null) return 'Höhe unbekannt';
  return altFt >= 6000 ? `FL${String(Math.round(altFt / 100)).padStart(3, '0')}` : `${altFt.toLocaleString('de-DE')} ft`;
}

// --- Einstellungen (nur Admins) ---

export interface TrafficSettings {
  aircraft: boolean;
  ships: boolean;
  /** Ist ein aisstream.io-Schlüssel hinterlegt? Der Schlüssel selbst verlässt den Server nicht. */
  aisKeySet: boolean;
  /** Online-Dienste laut Konfiguration (null = abgeschaltet) */
  aircraftUrl: string | null;
  aisUrl: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const trafficSettingsInputSchema = z.object({
  aircraft: z.boolean(),
  ships: z.boolean(),
  /** undefined = unverändert, null = entfernen */
  aisKey: z.string().trim().min(10, 'Schlüssel zu kurz').max(200).nullable().optional(),
});

export type TrafficSettingsInput = z.infer<typeof trafficSettingsInputSchema>;
