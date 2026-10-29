import { z } from 'zod';
import { tacticalSignSchema, type TacticalSign } from './tactical';

/**
 * Kräfte. Admins pflegen in der Kräfteverwaltung Systemeinheiten: ein Fahrzeug, eine Gruppe von
 * Fahrzeugen (Zug) oder mehrere Züge (Verband) – jede mit Namen, taktischem Zeichen und eigener Stärke.
 * Einheiten setzen sich aus anderen Systemeinheiten zusammen, jedes Mitglied mit einer Rolle
 * (z. B. „Führungsfahrzeug“). Dieselbe Einheit darf in mehreren Einheiten stecken, Zyklen nicht.
 *
 * Im Einsatz wird eine Systemeinheit als Kopie übernommen (ein Baum, einzelne Untereinheiten abwählbar);
 * spätere Änderungen am Katalog wirken nicht auf Einsätze. Im Einsatz neu erfasste Einheiten kann ein
 * Admin als Systemeinheit übernehmen.
 */

/** Stärke nach FwDV: Führer / Unterführer / Mannschaft (Gesamt wird berechnet). */
export interface Strength {
  leaders: number;
  subLeaders: number;
  crew: number;
}

export const ZERO_STRENGTH: Strength = { leaders: 0, subLeaders: 0, crew: 0 };

export const strengthSchema = z.object({
  leaders: z.number().int().min(0).max(999),
  subLeaders: z.number().int().min(0).max(999),
  crew: z.number().int().min(0).max(9999),
});

export function formatStrength(s: Strength): string {
  return `${s.leaders}/${s.subLeaders}/${s.crew}/${s.leaders + s.subLeaders + s.crew}`;
}

export const sumStrength = (list: { strength: Strength }[]): Strength =>
  list.reduce((a, u) => ({ leaders: a.leaders + u.strength.leaders, subLeaders: a.subLeaders + u.strength.subLeaders, crew: a.crew + u.strength.crew }), ZERO_STRENGTH);

export const UNIT_STATUS = {
  geplant: 'Geplant',
  alarmiert: 'Alarmiert',
  anmarsch: 'Auf Anmarsch',
  eingetroffen: 'Eingetroffen',
  ruhe: 'In Ruhe',
  einsatz: 'Im Einsatz',
  abmarsch: 'Auf Abmarsch',
  entlassen: 'Entlassen',
} as const;

export type UnitStatus = keyof typeof UNIT_STATUS;
export const UNIT_STATUSES = Object.keys(UNIT_STATUS) as [UnitStatus, ...UnitStatus[]];

/** Vor Ort: zählt zur Stärke am Einsatzort und setzt beim ersten Mal die Eintreffzeit */
export const ON_SCENE_STATUSES: UnitStatus[] = ['eingetroffen', 'ruhe', 'einsatz'];
export const isOnScene = (s: UnitStatus) => ON_SCENE_STATUSES.includes(s);

export const DEFAULT_UNIT_SIGN: TacticalSign = {
  base: 'vehicle',
  mobility: 'wheeled',
  org: 'feuerwehr',
  size: 'none',
  function: 'none',
  text: '',
  orgLabel: '',
  label: '',
  leader: false,
};

/** Vorschläge für Rollen innerhalb einer Einheit; dazu kommen alle bereits verwendeten */
export const UNIT_ROLE_SUGGESTIONS = [
  'Führungsfahrzeug',
  'Zugtrupp',
  'Löschfahrzeug',
  'Hubrettungsfahrzeug',
  'Wasserversorgung',
  'Technischer Zug',
  'Löschzug',
  'Gefahrgutzug',
  'Logistik',
];

const text = (max: number) => z.string().trim().max(max);
const id = z.number().int().positive();
const email = z.union([z.literal(''), z.string().trim().toLowerCase().email('Ungültige E-Mail-Adresse').max(254)]);
const status = z.enum(UNIT_STATUSES);

// --- Kräfteverwaltung (Systemeinheiten) ---

export interface ForceMember {
  unitId: number;
  role: string;
}

export interface ForceUnit {
  id: number;
  name: string;
  /** Funkrufname, z. B. „Florian Diepholz 1/44-1“ */
  callsign: string;
  organization: string;
  notes: string;
  /** E-Mail-Adresse (z. B. Leitstelle, aus einer eingegangenen Mail gemerkt); geht bei der Übernahme in den Einsatz mit */
  email: string;
  sign: TacticalSign;
  /** Eigene Stärke (ohne Untereinheiten) */
  strength: Strength;
  /** Untereinheiten in Reihenfolge */
  members: ForceMember[];
  createdAt: string;
  updatedAt: string;
}

export const forceUnitInputSchema = z.object({
  name: text(100).min(1, 'Name fehlt'),
  callsign: text(100).default(''),
  organization: text(100).default(''),
  notes: text(1000).default(''),
  /** Fehlt sie (z. B. beim Import), bleibt die gespeicherte Adresse */
  email: email.optional(),
  sign: tacticalSignSchema.default(DEFAULT_UNIT_SIGN),
  strength: strengthSchema.default(ZERO_STRENGTH),
  members: z.array(z.object({ unitId: id, role: text(60).default('') })).max(200).default([]),
});
export type ForceUnitInput = z.input<typeof forceUnitInputSchema>;

/** Alle Einheiten unterhalb von `rootId` (ohne sie selbst), jede einmal */
export function forceDescendants(units: Pick<ForceUnit, 'id' | 'members'>[], rootId: number): Set<number> {
  const byId = new Map(units.map((u) => [u.id, u]));
  const seen = new Set<number>();
  const stack = [...(byId.get(rootId)?.members ?? [])].map((m) => m.unitId);
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next) || next === rootId) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.members ?? []).map((m) => m.unitId));
  }
  return seen;
}

/** Eigene Stärke plus die aller Untereinheiten (mehrfach enthaltene zählen einmal) */
export function forceTotalStrength(units: ForceUnit[], rootId: number): Strength {
  const ids = forceDescendants(units, rootId).add(rootId);
  return sumStrength(units.filter((u) => ids.has(u.id)));
}

// --- Kräfte im Einsatz ---

export interface Unit {
  id: number;
  incidentId: number;
  /** Übergeordnete Einheit im Einsatz; null = oberste Ebene */
  parentId: number | null;
  /** Rolle innerhalb der übergeordneten Einheit */
  role: string;
  /** Systemeinheit, aus der die Einheit übernommen wurde; null = im Einsatz erfasst */
  sourceId: number | null;
  name: string;
  callsign: string;
  organization: string;
  notes: string;
  /** E-Mail-Adresse der Kraft (z. B. aus einer eingegangenen Mail übernommen); leer = keine */
  email: string;
  sign: TacticalSign;
  /** Eigene Stärke (ohne Untereinheiten) */
  strength: Strength;
  section: string;
  status: UnitStatus;
  /** Position auf der Karte; null = noch nicht gesetzt */
  lat: number | null;
  lon: number | null;
  /** Woher die Position stammt: von Hand auf der Karte oder per App; null = keine Position */
  positionSource: 'manual' | 'app' | null;
  positionAt: string | null;
  /** Genauigkeit der App-Ortung in Metern */
  positionAccuracyM: number | null;
  mapVisible: boolean;
  createdAt: string;
  /** Erstmals vor Ort (Eingetroffen, In Ruhe, Im Einsatz) */
  arrivedAt: string | null;
  releasedAt: string | null;
  updatedAt: string;
}

const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

export const newUnitSchema = z.object({
  name: text(100).min(1, 'Name fehlt'),
  callsign: text(100).default(''),
  organization: text(100).default(''),
  notes: text(1000).default(''),
  email: email.default(''),
  sign: tacticalSignSchema.default(DEFAULT_UNIT_SIGN),
  strength: strengthSchema.default(ZERO_STRENGTH),
  section: text(100).default(''),
  parentId: id.nullable().default(null),
  role: text(60).default(''),
  status: status.default('alarmiert'),
});
export type NewUnit = z.input<typeof newUnitSchema>;

export const unitPatchSchema = z
  .object({
    name: text(100).min(1, 'Name fehlt').optional(),
    callsign: text(100).optional(),
    organization: text(100).optional(),
    notes: text(1000).optional(),
    email: email.optional(),
    sign: tacticalSignSchema.optional(),
    strength: strengthSchema.optional(),
    section: text(100).optional(),
    parentId: id.nullable().optional(),
    role: text(60).optional(),
    status: status.optional(),
    lat: lat.nullable().optional(),
    lon: lon.nullable().optional(),
    mapVisible: z.boolean().optional(),
    /** Status und Abschnitt gelten auch für alle Untereinheiten (Vorgabe) */
    cascade: z.boolean().default(true),
  })
  .refine((p) => (p.lat === undefined) === (p.lon === undefined) && (p.lat === null) === (p.lon === null), 'Position nur vollständig (lat und lon)');
export type UnitPatch = z.input<typeof unitPatchSchema>;

/** Übernahme einer Systemeinheit: der ausgewählte Teilbaum */
export interface DeployNode {
  forceUnitId: number;
  children: DeployNode[];
}
export const deployNodeSchema: z.ZodType<DeployNode> = z.lazy(() => z.object({ forceUnitId: id, children: z.array(deployNodeSchema).max(200) }));

export const deployUnitSchema = z.object({
  tree: deployNodeSchema,
  parentId: id.nullable().default(null),
  role: text(60).default(''),
  section: text(100).default(''),
  status: status.default('alarmiert'),
});
export type DeployUnitInput = z.input<typeof deployUnitSchema>;

/** Kinder je übergeordneter Einheit (null = oberste Ebene), in Erfassungsreihenfolge */
export function unitChildren<U extends Pick<Unit, 'id' | 'parentId'>>(units: U[]): Map<number | null, U[]> {
  const ids = new Set(units.map((u) => u.id));
  const map = new Map<number | null, U[]>();
  for (const u of units) {
    // Fehlt die übergeordnete in der Auswahl (z. B. entlassen), steht die Einheit oben
    const key = u.parentId !== null && ids.has(u.parentId) ? u.parentId : null;
    map.set(key, [...(map.get(key) ?? []), u]);
  }
  return map;
}

/** Alle Untereinheiten (beliebig tief) */
export function unitDescendants<U extends Pick<Unit, 'id' | 'parentId'>>(units: U[], rootId: number): U[] {
  const out: U[] = [];
  const stack = [rootId];
  while (stack.length) {
    const p = stack.pop()!;
    for (const u of units) if (u.parentId === p && !out.includes(u)) (out.push(u), stack.push(u.id));
  }
  return out;
}
