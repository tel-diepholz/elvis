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
  /** Typbeschreibung aus der Datenbank des Dienstes, z. B. „AIRBUS A-320“ */
  description: string | null;
  lat: number;
  lon: number;
  /** Barometrische Höhe in Fuß; null = unbekannt */
  altFt: number | null;
  onGround: boolean;
  speedKt: number | null;
  /** Kurs über Grund in Grad */
  track: number | null;
  /** Steig-/Sinkrate in ft/min */
  vertRateFpm: number | null;
  squawk: string | null;
  /** ADS-B-Kategorie, z. B. A3 (Verkehrsflugzeug), A7 (Hubschrauber) */
  category: string | null;
  source: AircraftSource;
  /** Alter der Position in Sekunden */
  seenS: number;
}

/** Zusätzliche Angaben für die Detailseite */
export interface AircraftDetail extends Aircraft {
  /** Halter bzw. Betreiber laut Datenbank */
  operator: string | null;
  year: string | null;
  /** Geometrische (GPS-)Höhe in Fuß */
  altGeomFt: number | null;
  /** Am Autopiloten gewählte Höhe */
  selectedAltFt: number | null;
  iasKt: number | null;
  tasKt: number | null;
  mach: number | null;
  /** Notfallstatus (none, general, lifeguard, minfuel, nordo, unlawful, downed) */
  emergency: string | null;
}

/** Foto von planespotters.net (Fotograf und Link müssen angezeigt werden) */
export interface AircraftPhoto {
  src: string;
  width: number;
  height: number;
  link: string;
  photographer: string;
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

/** ADS-B-Kategorien (DO-260B) */
export const AIRCRAFT_CATEGORIES: Record<string, string> = {
  A1: 'Leichtflugzeug',
  A2: 'Kleinflugzeug',
  A3: 'Verkehrsflugzeug',
  A4: 'Verkehrsflugzeug (Wirbelschleppe hoch)',
  A5: 'Großraumflugzeug',
  A6: 'Hochleistungsflugzeug',
  A7: 'Hubschrauber',
  B1: 'Segelflugzeug',
  B2: 'Ballon/Luftschiff',
  B3: 'Fallschirmspringer',
  B4: 'Ultraleichtflugzeug',
  B6: 'Drohne',
  B7: 'Raumfahrzeug',
  C1: 'Einsatzfahrzeug (Boden)',
  C2: 'Servicefahrzeug (Boden)',
  C3: 'Hindernis',
};

export const EMERGENCY_LABELS: Record<string, string> = {
  general: 'Notfall (7700)',
  lifeguard: 'Ambulanzflug',
  minfuel: 'Treibstoffmangel',
  nordo: 'Funkausfall (7600)',
  unlawful: 'Entführung (7500)',
  downed: 'abgestürzt',
};

/** Flaggenstaat aus den ersten drei Ziffern der MMSI (Auswahl) */
const MID: Record<string, string> = {
  '211': 'Deutschland', '218': 'Deutschland', '219': 'Dänemark', '220': 'Dänemark', '244': 'Niederlande', '245': 'Niederlande', '246': 'Niederlande',
  '205': 'Belgien', '226': 'Frankreich', '227': 'Frankreich', '228': 'Frankreich', '232': 'Vereinigtes Königreich', '233': 'Vereinigtes Königreich',
  '234': 'Vereinigtes Königreich', '235': 'Vereinigtes Königreich', '257': 'Norwegen', '258': 'Norwegen', '259': 'Norwegen', '265': 'Schweden',
  '266': 'Schweden', '261': 'Polen', '230': 'Finnland', '276': 'Estland', '275': 'Lettland', '277': 'Litauen', '273': 'Russland', '209': 'Zypern',
  '210': 'Zypern', '212': 'Zypern', '229': 'Malta', '248': 'Malta', '249': 'Malta', '215': 'Malta', '255': 'Madeira (Portugal)', '263': 'Portugal',
  '224': 'Spanien', '225': 'Spanien', '247': 'Italien', '237': 'Griechenland', '239': 'Griechenland', '240': 'Griechenland', '241': 'Griechenland',
  '236': 'Gibraltar', '304': 'Antigua und Barbuda', '305': 'Antigua und Barbuda', '308': 'Bahamas', '309': 'Bahamas', '311': 'Bahamas',
  '351': 'Panama', '352': 'Panama', '353': 'Panama', '354': 'Panama', '355': 'Panama', '356': 'Panama', '357': 'Panama', '370': 'Panama',
  '371': 'Panama', '372': 'Panama', '373': 'Panama', '374': 'Panama', '636': 'Liberia', '637': 'Liberia', '538': 'Marshallinseln',
  '477': 'Hongkong', '563': 'Singapur', '564': 'Singapur', '565': 'Singapur', '566': 'Singapur', '412': 'China', '413': 'China', '414': 'China',
  '366': 'USA', '367': 'USA', '368': 'USA', '369': 'USA', '316': 'Kanada', '256': 'Malta', '271': 'Türkei', '272': 'Ukraine',
};
export const shipFlag = (mmsi: string): string | null => MID[mmsi.slice(0, 3)] ?? null;

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
