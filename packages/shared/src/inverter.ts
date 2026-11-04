/**
 * Wechselrichter/Ladegerät am VE.Bus (Victron MultiPlus, Quattro), angebunden über ein MK3-USB-Interface –
 * direkt am Server oder über einen Router (Serial over IP).
 */

/** Betriebsart wie am Schalter eines Digital Multi Control */
export type InverterMode = 'on' | 'off' | 'charger-only' | 'inverter-only';

export const INVERTER_MODE_LABELS: Record<InverterMode, string> = {
  on: 'Ein',
  'charger-only': 'Nur Laden',
  'inverter-only': 'Nur Wechselrichter',
  off: 'Aus',
};

/** Zustand des Geräts (VE.Bus „device state“, beim Laden mit Ladephase) */
export type InverterOpState =
  | 'down'
  | 'startup'
  | 'off'
  | 'slave'
  | 'invert'
  | 'aes'
  | 'power-assist'
  | 'passthru'
  | 'charge-init'
  | 'bulk'
  | 'absorption'
  | 'float'
  | 'storage'
  | 'equalize'
  | 'bulk-stopped';

export const INVERTER_STATE_LABELS: Record<InverterOpState, string> = {
  down: 'Abgeschaltet',
  startup: 'Startet',
  off: 'Aus',
  slave: 'Slave',
  invert: 'Wechselrichten',
  aes: 'Wechselrichten (Sparmodus)',
  'power-assist': 'Netzstützung',
  passthru: 'Durchleitung',
  'charge-init': 'Laden startet',
  bulk: 'Laden (Konstantstrom)',
  absorption: 'Laden (Konstantspannung)',
  float: 'Erhaltungsladung',
  storage: 'Lagerung',
  equalize: 'Ausgleichsladung',
  'bulk-stopped': 'Laden angehalten',
};

export type InverterLed = 'off' | 'on' | 'blink';

/** LEDs wie an der Front des MultiPlus */
export interface InverterLeds {
  mains: InverterLed;
  absorption: InverterLed;
  bulk: InverterLed;
  float: InverterLed;
  inverter: InverterLed;
  overload: InverterLed;
  lowBattery: InverterLed;
  temperature: InverterLed;
}

/** Ein Gerät am VE.Bus, gefunden beim Scan der Adressen 0–31 */
export interface InverterBusDevice {
  address: number;
  role: 'master' | 'slave';
  /** Firmware als „AABBCCC“ (Produkt, Modell, Version), null wenn nicht gelesen */
  firmware: string | null;
}

export interface InverterPhase {
  phase: 'L1' | 'L2' | 'L3' | 'L4';
  acIn: { v: number | null; a: number | null; hz: number | null };
  acOut: { v: number | null; a: number | null };
}

export interface InverterState {
  link: {
    connected: boolean;
    /** host:port oder Schnittstelle */
    target: string;
    error: string | null;
    lastFrameAt: string | null;
    /** Firmware des MK3-Interfaces */
    interfaceVersion: string | null;
  };
  devices: InverterBusDevice[];
  scanning: boolean;
  lastScanAt: string | null;
  /** Betriebsart laut Gerät (Schalterzustand); null wenn unbekannt */
  mode: InverterMode | null;
  opState: InverterOpState | null;
  /** Landstrom-Begrenzung, die gerade gilt, und der einstellbare Bereich */
  shoreLimitA: number | null;
  shoreLimitMinA: number | null;
  shoreLimitMaxA: number | null;
  /** Fernbedienung (z. B. Digital Multi Control) am VE.Bus erkannt – sie hat Vorrang vor ELVIS */
  remotePanel: boolean | null;
  phases: InverterPhase[];
  acOutHz: number | null;
  /** Ausgangsleistung zu den Verbrauchern (nur bei einem einzelnen Gerät gemessen) */
  outputW: number | null;
  dc: { v: number | null; a: number | null };
  leds: InverterLeds | null;
}

const LED_ALARMS: { key: keyof InverterLeds; title: string }[] = [
  { key: 'overload', title: 'Überlast' },
  { key: 'lowBattery', title: 'Batteriespannung niedrig' },
  { key: 'temperature', title: 'Übertemperatur' },
];

/** Alarme aus den LEDs: leuchtet = Alarm (Gerät schaltet ab), blinkt = Vorwarnung */
export function inverterAlarms(leds: InverterLeds | null): { id: string; severity: 'alarm' | 'warn'; title: string }[] {
  if (!leds) return [];
  return LED_ALARMS.filter((a) => leds[a.key] !== 'off').map((a) => ({
    id: a.key,
    severity: leds[a.key] === 'on' ? 'alarm' : 'warn',
    title: leds[a.key] === 'on' ? a.title : `${a.title} (Vorwarnung)`,
  }));
}
