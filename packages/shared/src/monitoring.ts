import { z } from 'zod';

/**
 * Einfaches Monitoring: ELVIS fragt Geräte im Fahrzeugnetz regelmäßig ab (Drucker und andere Geräte per SNMP,
 * Rechner per Prometheus Node Exporter) und meldet Probleme in der Meldungsleiste. Die Ziele legen Admins in den
 * Einstellungen an; abgefragt wird vom Fahrzeugmodul „Monitoring“.
 */

export type MonitoringKind = 'snmp-printer' | 'snmp' | 'node-exporter';

export const MONITORING_KIND_LABELS: Record<MonitoringKind, string> = {
  'snmp-printer': 'Drucker (SNMP)',
  snmp: 'Gerät (SNMP)',
  'node-exporter': 'Rechner (Node Exporter)',
};

export const MONITORING_DEFAULT_PORTS: Record<MonitoringKind, number> = { 'snmp-printer': 161, snmp: 161, 'node-exporter': 9100 };

/** Schwellen der fest eingebauten Prüfungen; welche gelten, hängt von der Art des Ziels ab */
export interface MonitoringLimits {
  /** Drucker: Verbrauchsmaterial (Toner, Trommel, Resttonerbehälter) unter … % */
  suppliesWarnPct: number;
  /** Node Exporter: Last je CPU-Kern über … */
  loadWarn: number;
  /** Node Exporter: freier Arbeitsspeicher unter … % */
  memWarnPct: number;
  /** Node Exporter: freier Platz je Dateisystem unter … % */
  diskWarnPct: number;
  diskAlarmPct: number;
  /** Node Exporter: höchste Temperatur über … °C */
  tempWarnC: number;
  tempAlarmC: number;
}

export const MONITORING_DEFAULT_LIMITS: MonitoringLimits = {
  suppliesWarnPct: 10,
  loadWarn: 2,
  memWarnPct: 10,
  diskWarnPct: 10,
  diskAlarmPct: 5,
  tempWarnC: 80,
  tempAlarmC: 90,
};

/**
 * Eigene Prüfung: bei SNMP eine OID, beim Node Exporter eine Metrik mit optionalen Labels,
 * z. B. node_filesystem_avail_bytes{mountpoint="/data"}. Leere Grenzen werden nicht geprüft.
 */
export interface MonitoringCheck {
  label: string;
  query: string;
  /** Rohwert × Faktor, z. B. 0.1 für Zehntelgrad oder 1e-9 für Bytes → GB */
  scale: number;
  unit: string;
  warnBelow: number | null;
  warnAbove: number | null;
  alarmBelow: number | null;
  alarmAbove: number | null;
}

export interface MonitoringTargetConfig {
  id: string;
  name: string;
  kind: MonitoringKind;
  host: string;
  port: number;
  /** nur SNMP */
  snmpVersion: '1' | '2c';
  community: string;
  /**
   * Dauerhaft eingeschaltet: Ist das Gerät nicht erreichbar, gibt es einen Alarm. Sonst (z. B. Drucker, der nur im
   * Einsatz eingeschaltet wird) gilt „nicht erreichbar“ als ausgeschaltet – gemeldet werden nur Probleme in den Messwerten.
   */
  alwaysOn: boolean;
  limits: MonitoringLimits;
  checks: MonitoringCheck[];
  enabled: boolean;
  sort: number;
}

const num = z.number().finite();
const limit = num.nullable();

export const monitoringCheckSchema = z.object({
  label: z.string().trim().min(1, 'Bezeichnung fehlt').max(60),
  query: z.string().trim().min(1, 'OID bzw. Metrik fehlt').max(300),
  scale: num.refine((v) => v !== 0, 'Faktor darf nicht 0 sein'),
  unit: z.string().trim().max(12),
  warnBelow: limit,
  warnAbove: limit,
  alarmBelow: limit,
  alarmAbove: limit,
});

export const monitoringTargetInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Name fehlt').max(60),
    kind: z.enum(['snmp-printer', 'snmp', 'node-exporter']),
    host: z
      .string()
      .trim()
      .min(1, 'Adresse fehlt')
      .max(200)
      .regex(/^[\w.\-:[\]]*$/, 'Nur Hostname oder IP-Adresse'),
    port: z.number().int().min(1).max(65535),
    snmpVersion: z.enum(['1', '2c']),
    community: z.string().max(100),
    alwaysOn: z.boolean(),
    limits: z.object({
      suppliesWarnPct: num.min(0).max(100),
      loadWarn: num.min(0),
      memWarnPct: num.min(0).max(100),
      diskWarnPct: num.min(0).max(100),
      diskAlarmPct: num.min(0).max(100),
      tempWarnC: num,
      tempAlarmC: num,
    }),
    checks: z.array(monitoringCheckSchema).max(30),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== 'node-exporter' && !v.community) ctx.addIssue({ code: 'custom', path: ['community'], message: 'Community fehlt' });
    v.checks.forEach((c, i) => {
      const ok = v.kind === 'node-exporter' ? /^[a-zA-Z_:][\w:]*(\{.*\})?$/.test(c.query) : /^\.?\d+(\.\d+)+$/.test(c.query);
      if (!ok) ctx.addIssue({ code: 'custom', path: ['checks', i, 'query'], message: v.kind === 'node-exporter' ? 'Metrikname, ggf. mit {label="wert"}' : 'OID in Punktschreibweise, z. B. 1.3.6.1.2.1.1.3.0' });
    });
  });

export type MonitoringTargetInput = z.input<typeof monitoringTargetInputSchema>;

export type MonitoringSeverity = 'ok' | 'info' | 'warn' | 'alarm';

export interface MonitoringMetric {
  /** eindeutig je Ziel, z. B. supply:1 oder fs:/ */
  id: string;
  label: string;
  /** Zahlenwert (bereits skaliert) oder null bei Textwerten */
  value: number | null;
  /** Anzeige, z. B. „42 %“ oder „bereit“ */
  text: string;
  severity: MonitoringSeverity;
  /** Grund bei einem Problem, z. B. „unter 10 %“ */
  problem: string | null;
}

/** Zustand eines Ziels im Modul „Monitoring“ (live für alle) */
export interface MonitoringTargetLive {
  id: string;
  name: string;
  kind: MonitoringKind;
  alwaysOn: boolean;
  /** null = noch nicht abgefragt */
  reachable: boolean | null;
  error: string | null;
  /** Letzte Abfrage */
  checkedAt: string | null;
  /** Letzte erfolgreiche Abfrage; bei nicht erreichbaren Zielen sind die Messwerte von dort */
  seenAt: string | null;
  /** z. B. Gerätename und Modell laut SNMP bzw. Kernel-Version */
  description: string | null;
  metrics: MonitoringMetric[];
}

export interface MonitoringState {
  targets: MonitoringTargetLive[];
}

/** Ergebnis von „Verbindung testen“ */
export interface MonitoringTestResult {
  ok: boolean;
  message: string;
  metrics: MonitoringMetric[];
}

/** Bewertung eines Zahlenwerts gegen die Grenzen einer eigenen Prüfung */
export function rateValue(value: number, c: Pick<MonitoringCheck, 'warnBelow' | 'warnAbove' | 'alarmBelow' | 'alarmAbove' | 'unit'>): { severity: MonitoringSeverity; problem: string | null } {
  const u = c.unit ? ` ${c.unit}` : '';
  if (c.alarmBelow !== null && value < c.alarmBelow) return { severity: 'alarm', problem: `unter ${c.alarmBelow}${u}` };
  if (c.alarmAbove !== null && value > c.alarmAbove) return { severity: 'alarm', problem: `über ${c.alarmAbove}${u}` };
  if (c.warnBelow !== null && value < c.warnBelow) return { severity: 'warn', problem: `unter ${c.warnBelow}${u}` };
  if (c.warnAbove !== null && value > c.warnAbove) return { severity: 'warn', problem: `über ${c.warnAbove}${u}` };
  return { severity: 'ok', problem: null };
}
