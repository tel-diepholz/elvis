import { z } from 'zod';
import { dv102IdSchema } from './mapobjects';

/**
 * Schadenkonten (Lagedarstellung S2): je Schadenstelle bzw. Einsatzabschnitt ein T-Konto – links Schäden und
 * Gefahren, rechts Kräfte und Maßnahmen. Die Kräfte sind die Einheiten, deren Abschnitt das Konto ist. Unbestätigtes
 * trägt ein „?“, Erledigtes wird durchgestrichen und bleibt lesbar. Dazu je Konto die Personenschäden nach dem
 * Muster der Lagemeldung (Stand je Kategorie, „davon Einsatzkräfte“, Schätzwerte gekennzeichnet).
 */

export type DamageEntrySide = 'schaden' | 'gefahr' | 'massnahme';

export const DAMAGE_ENTRY_SIDE_LABELS: Record<DamageEntrySide, string> = {
  schaden: 'Schaden',
  gefahr: 'Gefahr',
  massnahme: 'Maßnahme',
};
export const DAMAGE_ENTRY_SIDES = Object.keys(DAMAGE_ENTRY_SIDE_LABELS) as [DamageEntrySide, ...DamageEntrySide[]];

export type DamageCountCategory = 'betroffen' | 'tot' | 'sk1' | 'sk2' | 'sk3' | 'sk4' | 'vermisst' | 'evakuiert' | 'unverletzt';

/** Personenschäden in der Reihenfolge der Lagemeldung */
export const DAMAGE_COUNT_LABELS: Record<DamageCountCategory, string> = {
  betroffen: 'Betroffene',
  tot: 'Tote',
  sk1: 'Verletzte SK I',
  sk2: 'Verletzte SK II',
  sk3: 'Verletzte SK III',
  sk4: 'Verletzte SK IV',
  vermisst: 'Vermisste',
  evakuiert: 'Evakuierte',
  unverletzt: 'Unverletzte',
};
export const DAMAGE_COUNT_CATEGORIES = Object.keys(DAMAGE_COUNT_LABELS) as [DamageCountCategory, ...DamageCountCategory[]];
export const DAMAGE_INJURED: DamageCountCategory[] = ['sk1', 'sk2', 'sk3', 'sk4'];

export interface DamageEntry {
  id: number;
  accountId: number;
  side: DamageEntrySide;
  text: string;
  /** DV 102-Zeichen (Katalog-Id), null = keins */
  sign: string | null;
  count: number | null;
  /** Unbestätigt bzw. vermutet („?“) */
  uncertain: boolean;
  /** Erledigt: wird durchgestrichen angezeigt, nie gelöscht */
  doneAt: string | null;
  doneBy: string | null;
  createdAt: string;
  createdBy: string;
}

/** Aktueller Stand einer Kategorie (letzte Buchung) */
export interface DamageCount {
  category: DamageCountCategory;
  value: number;
  /** davon Einsatzkräfte */
  forces: number;
  estimated: boolean;
  note: string;
  at: string;
  by: string;
}

/** Eine Buchung (Verlauf) */
export interface DamageCountBooking extends DamageCount {
  id: number;
  accountId: number;
}

export interface DamageAccount {
  id: number;
  incidentId: number;
  number: number;
  name: string;
  /** Abschnittsleiter als Kraft im Einsatz; leader hält den Anzeigenamen */
  leaderUnitId: number | null;
  leader: string;
  /** Fm-Verbindung, z. B. Kanal oder Rufname */
  radio: string;
  lat: number | null;
  lon: number | null;
  closedAt: string | null;
  closedBy: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  entries: DamageEntry[];
  counts: DamageCount[];
}

export interface DamageTotal {
  category: DamageCountCategory;
  value: number;
  forces: number;
  /** Mindestens ein Konto meldet einen Schätzwert */
  estimated: boolean;
  /** Letzte Änderung über alle Konten */
  at: string;
}

const text = (max: number) => z.string().trim().max(max);
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const count = z.number().int().min(0).max(1_000_000);

export const damageAccountInputSchema = z
  .object({
    name: text(100).min(1, 'Bezeichnung fehlt'),
    leaderUnitId: z.number().int().positive().nullable().default(null),
    leader: text(100).default(''),
    radio: text(100).default(''),
    lat: lat.nullable().default(null),
    lon: lon.nullable().default(null),
  })
  .refine((p) => (p.lat === null) === (p.lon === null), 'Position nur vollständig (lat und lon)');
export type DamageAccountInput = z.input<typeof damageAccountInputSchema>;

export const damageAccountPatchSchema = z
  .object({
    name: text(100).min(1, 'Bezeichnung fehlt').optional(),
    leaderUnitId: z.number().int().positive().nullable().optional(),
    leader: text(100).optional(),
    radio: text(100).optional(),
    lat: lat.nullable().optional(),
    lon: lon.nullable().optional(),
  })
  .refine((p) => (p.lat === undefined) === (p.lon === undefined) && (p.lat === null) === (p.lon === null), 'Position nur vollständig (lat und lon)');
export type DamageAccountPatch = z.input<typeof damageAccountPatchSchema>;

export const damageEntryInputSchema = z
  .object({
    side: z.enum(DAMAGE_ENTRY_SIDES),
    text: text(500).default(''),
    sign: dv102IdSchema.nullable().default(null),
    count: count.nullable().default(null),
    uncertain: z.boolean().default(false),
  })
  .refine((e) => e.text !== '' || e.sign !== null, 'Text oder Zeichen angeben');
export type DamageEntryInput = z.input<typeof damageEntryInputSchema>;

export const damageEntryPatchSchema = z.object({
  text: text(500).optional(),
  sign: dv102IdSchema.nullable().optional(),
  count: count.nullable().optional(),
  uncertain: z.boolean().optional(),
  done: z.boolean().optional(),
});
export type DamageEntryPatch = z.input<typeof damageEntryPatchSchema>;

export const damageCountInputSchema = z
  .object({
    category: z.enum(DAMAGE_COUNT_CATEGORIES),
    value: count,
    forces: count.default(0),
    estimated: z.boolean().default(false),
    note: text(300).default(''),
  })
  .refine((c) => c.forces <= c.value, { message: '„davon Einsatzkräfte“ ist größer als die Anzahl', path: ['forces'] });
export type DamageCountInput = z.input<typeof damageCountInputSchema>;

export const damageAccountLabel = (a: Pick<DamageAccount, 'number' | 'name'>) => `${a.number} ${a.name}`;

/** Zahl mit „~“ für Schätzwerte */
export const formatDamageCount = (c: Pick<DamageCount, 'value' | 'estimated'>) => `${c.estimated ? '~' : ''}${c.value}`;

/** Summe je Kategorie über alle (auch aufgelöste) Konten; Kategorien ohne Buchung fehlen */
export function damageTotals(accounts: Pick<DamageAccount, 'counts'>[]): DamageTotal[] {
  const map = new Map<DamageCountCategory, DamageTotal>();
  for (const c of accounts.flatMap((a) => a.counts)) {
    const t = map.get(c.category);
    map.set(
      c.category,
      t
        ? { category: c.category, value: t.value + c.value, forces: t.forces + c.forces, estimated: t.estimated || c.estimated, at: c.at > t.at ? c.at : t.at }
        : { category: c.category, value: c.value, forces: c.forces, estimated: c.estimated, at: c.at },
    );
  }
  return DAMAGE_COUNT_CATEGORIES.flatMap((k) => map.get(k) ?? []);
}
