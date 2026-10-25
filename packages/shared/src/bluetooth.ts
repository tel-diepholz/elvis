import { z } from 'zod';

/**
 * Bluetooth-Geräte im Fahrzeug: ELVIS hört über den Bluetooth-Adapter des Servers die Werbepakete (Advertisements)
 * der eingetragenen Geräte mit. Verbunden wird nicht – die Geräte senden ihre Messwerte von selbst. Die Geräte legen
 * Admins in den Einstellungen an; empfangen wird vom Fahrzeugmodul „Bluetooth“.
 */

/** Geräteart; bestimmt, wie die Werbepakete gelesen werden. Weitere Arten hier ergänzen. */
export type BluetoothKind = 'victron';

export const BLUETOOTH_KIND_LABELS: Record<BluetoothKind, string> = {
  victron: 'Victron (Instant Readout)',
};

export interface BluetoothDeviceConfig {
  id: string;
  name: string;
  kind: BluetoothKind;
  /** Bluetooth-Adresse, z. B. „C8:2E:47:12:34:56“ (Großbuchstaben) */
  address: string;
  /** Victron: Schlüssel für die Messwerte (VictronConnect → Produktinfo → Instant Readout → Verschlüsselungsdaten) */
  key: string;
  /** Warnung, wenn die Spannung darunter fällt (V); null = keine eigene Grenze */
  warnBelowV: number | null;
  enabled: boolean;
  sort: number;
}

const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

/** „c8-2e-47-12-34-56“ oder „c82e47123456“ → „C8:2E:47:12:34:56“ */
export function normalizeBluetoothAddress(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 12 ? hex.match(/../g)!.join(':') : raw.trim().toUpperCase();
}

export const bluetoothDeviceInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Name fehlt').max(60),
    kind: z.enum(['victron']),
    address: z
      .string()
      .transform(normalizeBluetoothAddress)
      .refine((v) => MAC.test(v), 'Bluetooth-Adresse im Format AA:BB:CC:DD:EE:FF'),
    key: z
      .string()
      .transform((v) => v.replace(/\s/g, '').toLowerCase())
      .refine((v) => v === '' || /^[0-9a-f]{32}$/.test(v), 'Schlüssel: 32 Hex-Zeichen'),
    warnBelowV: z.number().finite().min(0).max(1000).nullable(),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'victron' && !v.key) ctx.addIssue({ code: 'custom', path: ['key'], message: 'Schlüssel fehlt (VictronConnect → Produktinfo → Instant Readout)' });
  });

export type BluetoothDeviceInput = z.input<typeof bluetoothDeviceInputSchema>;

// --- Messwerte (Victron Instant Readout) ---

/** Zustand eines Ladegeräts (VE.Direct „Device state“) */
export const VICTRON_STATE_LABELS: Record<number, string> = {
  0: 'Aus',
  1: 'Energiesparmodus',
  2: 'Störung',
  3: 'Konstantstrom (Bulk)',
  4: 'Konstantspannung (Absorption)',
  5: 'Erhaltungsladung (Float)',
  6: 'Lagerung',
  7: 'Ausgleichsladung',
  9: 'Wechselrichter',
  11: 'Netzteil',
  245: 'Startet',
  246: 'Wiederholte Absorption',
  247: 'Auffrischen',
  248: 'Batterieschutz',
  249: 'Aktiv',
  252: 'Externe Steuerung',
};

/** Alarmgründe des Batteriemonitors (Bits) */
export const VICTRON_ALARM_LABELS: [number, string][] = [
  [1, 'Unterspannung'],
  [2, 'Überspannung'],
  [4, 'Ladezustand niedrig'],
  [8, 'Starterbatterie Unterspannung'],
  [16, 'Starterbatterie Überspannung'],
  [32, 'Temperatur niedrig'],
  [64, 'Temperatur hoch'],
  [128, 'Mittelpunktspannung'],
  [256, 'Überlast'],
  [512, 'DC-Welligkeit'],
  [1024, 'AC-Ausgang Unterspannung'],
  [2048, 'AC-Ausgang Überspannung'],
  [4096, 'Kurzschluss'],
  [8192, 'BMS-Sperre'],
];

export type VictronBalancer = 'balanced' | 'balancing' | 'imbalance';

export const VICTRON_BALANCER_LABELS: Record<VictronBalancer, string> = {
  balanced: 'ausgeglichen',
  balancing: 'gleicht aus',
  imbalance: 'Zellen ungleich',
};

/**
 * Zellspannung: Zahl in V, „low“ unter 2,61 V, „high“ über 3,85 V. Nicht vorhandene Zellen fehlen in der Liste.
 */
export type VictronCellVoltage = number | 'low' | 'high';

export type VictronReadout =
  /** Lithium Battery Smart (LiFePO4) */
  | {
      type: 'lithium';
      voltageV: number | null;
      temperatureC: number | null;
      cells: VictronCellVoltage[];
      balancer: VictronBalancer | null;
      /** Rohwerte, Bedeutung von Victron nicht veröffentlicht; Fehler ≠ 0 ist eine Störung */
      bmsFlags: number;
      errorFlags: number;
    }
  /** SmartShunt, BMV */
  | {
      type: 'battery-monitor';
      voltageV: number | null;
      currentA: number | null;
      socPct: number | null;
      consumedAh: number | null;
      remainingMin: number | null;
      temperatureC: number | null;
      starterVoltageV: number | null;
      midpointVoltageV: number | null;
      /** Aktive Alarme als Text */
      alarms: string[];
    }
  /** SmartSolar/BlueSolar MPPT */
  | {
      type: 'solar';
      state: number | null;
      error: number | null;
      voltageV: number | null;
      currentA: number | null;
      yieldTodayWh: number | null;
      pvPowerW: number | null;
      loadCurrentA: number | null;
    }
  /** Orion Smart (DC/DC-Lader) */
  | {
      type: 'dcdc';
      state: number | null;
      error: number | null;
      inputVoltageV: number | null;
      outputVoltageV: number | null;
      offReason: number;
    }
  /** Blue Smart / Phoenix Smart Ladegerät */
  | {
      type: 'ac-charger';
      state: number | null;
      error: number | null;
      outputs: { voltageV: number; currentA: number | null }[];
      temperatureC: number | null;
      acCurrentA: number | null;
    }
  /** Gerät sendet, aber diese Art von Messwerten liest ELVIS (noch) nicht */
  | { type: 'unsupported'; readoutType: number };

export const VICTRON_READOUT_LABELS: Record<VictronReadout['type'], string> = {
  lithium: 'Lithium-Batterie',
  'battery-monitor': 'Batteriemonitor',
  solar: 'Solarladeregler',
  dcdc: 'DC/DC-Lader',
  'ac-charger': 'Ladegerät',
  unsupported: 'Victron-Gerät',
};

// --- Zustand des Moduls „Bluetooth“ ---

export interface BluetoothDeviceLive {
  id: string;
  name: string;
  kind: BluetoothKind;
  address: string;
  warnBelowV: number | null;
  /** Letztes gültiges Paket; null = seit dem Start nichts empfangen */
  seenAt: string | null;
  /** Länger nichts empfangen – die Werte sind die zuletzt bekannten */
  stale: boolean;
  rssi: number | null;
  /** Name, unter dem sich das Gerät meldet (in VictronConnect änderbar) */
  advertisedName: string | null;
  readout: VictronReadout | null;
  /** z. B. „Schlüssel passt nicht“ */
  error: string | null;
}

/** In der Nähe empfangenes, auswertbares Gerät – zum Übernehmen in die Geräteliste */
export interface BluetoothNearby {
  address: string;
  kind: BluetoothKind;
  name: string | null;
  /** z. B. „Lithium-Batterie“ */
  type: string;
  rssi: number | null;
  seenAt: string;
  configured: boolean;
}

export interface BluetoothState {
  adapter: {
    /** z. B. „hci0“ oder „Simulation“ */
    name: string;
    /** Adapter bereit und Suche läuft */
    scanning: boolean;
    error: string | null;
  };
  devices: BluetoothDeviceLive[];
  nearby: BluetoothNearby[];
}

/** Ladezustand oder Spannung als kurze Zusammenfassung, z. B. für Kacheln */
export function bluetoothSummary(d: Pick<BluetoothDeviceLive, 'readout'>): string | null {
  const r = d.readout;
  if (!r) return null;
  const v = (x: number | null) => (x === null ? null : `${x.toFixed(2).replace('.', ',')} V`);
  switch (r.type) {
    case 'lithium':
      return v(r.voltageV);
    case 'battery-monitor':
      return [r.socPct === null ? null : `${Math.round(r.socPct)} %`, v(r.voltageV)].filter(Boolean).join(' · ') || null;
    case 'solar':
      return r.pvPowerW === null ? v(r.voltageV) : `${r.pvPowerW} W`;
    case 'dcdc':
      return v(r.outputVoltageV) ?? v(r.inputVoltageV);
    case 'ac-charger':
      return r.outputs[0] ? v(r.outputs[0].voltageV) : null;
    default:
      return null;
  }
}
