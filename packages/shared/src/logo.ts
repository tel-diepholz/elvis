import { z } from 'zod';
import type { AlertSeverity } from './protocol';

/**
 * Siemens LOGO! 8 (0BA8 und neuer) per S7: ELVIS liest den Prozessabbild-Bereich der LOGO (Datenbaustein 1,
 * „VM-Adressen“) und zeigt Ein- und Ausgänge, Merker und Netzwerk-Ein-/Ausgänge. Admins und Bediener vergeben
 * Bezeichnungen, legen Meldungsregeln an („NI1 = 1 → Lichtmast ausgefahren“) und verknüpfen Taster (NI) mit
 * dem Schaltausgang (Q), dessen Zustand das Ergebnis zeigt.
 */

export type LogoSignalKind = 'I' | 'Q' | 'M' | 'NI' | 'NQ' | 'AI' | 'AQ' | 'AM' | 'NAI' | 'NAQ';

export interface LogoSignalSpec {
  kind: LogoSignalKind;
  label: string;
  /** Analogwert (16 Bit, vorzeichenbehaftet) statt Bit */
  analog: boolean;
  /** Anzahl der Signale dieser Art in der LOGO! 8 */
  count: number;
  /** Byteadresse in DB1 (VM-Adresse), Signal 1 beginnt hier */
  offset: number;
}

/**
 * Adressen laut Siemens-Handbuch LOGO! 8 („VM-Adressen“). Bits: Signal n liegt in Byte offset + (n − 1) / 8, Bit
 * (n − 1) mod 8. Analogwerte: Wort (zwei Byte, High-Byte zuerst) bei offset + 2 · (n − 1).
 * Nur hier stehen die Adressen – sie sind mit der verbauten LOGO zu prüfen.
 */
export const LOGO_SIGNALS: readonly LogoSignalSpec[] = [
  { kind: 'I', label: 'Eingänge', analog: false, count: 24, offset: 1024 },
  { kind: 'AI', label: 'Analogeingänge', analog: true, count: 8, offset: 1032 },
  { kind: 'Q', label: 'Ausgänge', analog: false, count: 20, offset: 1064 },
  { kind: 'AQ', label: 'Analogausgänge', analog: true, count: 8, offset: 1072 },
  { kind: 'M', label: 'Merker', analog: false, count: 64, offset: 1104 },
  { kind: 'AM', label: 'Analogmerker', analog: true, count: 64, offset: 1118 },
  { kind: 'NI', label: 'Netzwerk-Eingänge', analog: false, count: 64, offset: 1246 },
  { kind: 'NAI', label: 'Netzwerk-Analogeingänge', analog: true, count: 32, offset: 1262 },
  { kind: 'NQ', label: 'Netzwerk-Ausgänge', analog: false, count: 64, offset: 1390 },
  { kind: 'NAQ', label: 'Netzwerk-Analogausgänge', analog: true, count: 16, offset: 1406 },
];

export const LOGO_SIGNAL_KINDS: readonly LogoSignalKind[] = LOGO_SIGNALS.map((s) => s.kind);

export function logoSpec(kind: LogoSignalKind): LogoSignalSpec {
  return LOGO_SIGNALS.find((s) => s.kind === kind)!;
}

/** Kennung eines Signals, wie sie in der LOGO heißt: „NI4“, „Q7“, „AI2“ */
export function logoSignalId(kind: LogoSignalKind, n: number): string {
  return `${kind}${n}`;
}

/** „NI4“ → { kind: 'NI', n: 4 }; null bei unbekannter Art oder Nummer außerhalb des Bereichs */
export function parseLogoSignalId(id: string): { kind: LogoSignalKind; n: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(id);
  if (!m) return null;
  const spec = LOGO_SIGNALS.find((s) => s.kind === m[1]);
  const n = Number(m[2]);
  if (!spec || n < 1 || n > spec.count) return null;
  return { kind: spec.kind, n };
}

export function isLogoSignalId(id: string): boolean {
  return parseLogoSignalId(id) !== null;
}

export function isLogoAnalog(id: string): boolean {
  const p = parseLogoSignalId(id);
  return !!p && logoSpec(p.kind).analog;
}

/** Alle Signale in Anzeigereihenfolge */
export function allLogoSignalIds(): string[] {
  return LOGO_SIGNALS.flatMap((s) => Array.from({ length: s.count }, (_, i) => logoSignalId(s.kind, i + 1)));
}

/** Lage eines Bits in DB1: Byte und Bit */
export function logoBitAddress(kind: LogoSignalKind, n: number): { byte: number; bit: number } {
  const spec = logoSpec(kind);
  return { byte: spec.offset + Math.floor((n - 1) / 8), bit: (n - 1) % 8 };
}

/** Bytebereiche in DB1, die gelesen werden müssen (je Art Anfang und Länge) */
export function logoReadRanges(): { kind: LogoSignalKind; offset: number; length: number }[] {
  return LOGO_SIGNALS.map((s) => ({ kind: s.kind, offset: s.offset, length: s.analog ? s.count * 2 : Math.ceil(s.count / 8) }));
}

/** Rohbytes eines Bereichs (siehe logoReadRanges) in Signalwerte umrechnen: Bits 0/1, Analogwerte als Zahl */
export function decodeLogoRange(kind: LogoSignalKind, bytes: Uint8Array): Record<string, number> {
  const spec = logoSpec(kind);
  const out: Record<string, number> = {};
  for (let n = 1; n <= spec.count; n++) {
    if (spec.analog) {
      const hi = bytes[(n - 1) * 2] ?? 0;
      const lo = bytes[(n - 1) * 2 + 1] ?? 0;
      const v = (hi << 8) | lo;
      out[logoSignalId(kind, n)] = v >= 0x8000 ? v - 0x10000 : v;
    } else {
      out[logoSignalId(kind, n)] = ((bytes[Math.floor((n - 1) / 8)] ?? 0) >> ((n - 1) % 8)) & 1;
    }
  }
  return out;
}

// --- Konfiguration ---

export type LogoOp = '=' | '!=' | '>' | '<' | '>=' | '<=';
export const LOGO_OPS: readonly LogoOp[] = ['=', '!=', '>', '<', '>=', '<='];

const signalIdSchema = z.string().refine(isLogoSignalId, 'Unbekanntes Signal');
const digitalOutputKinds: LogoSignalKind[] = ['Q', 'M', 'NQ'];

export const logoRuleInputSchema = z.object({
  signal: signalIdSchema,
  op: z.enum(['=', '!=', '>', '<', '>=', '<=']).default('='),
  value: z.number().int().default(1),
  severity: z.enum(['alarm', 'warn', 'info']).default('warn'),
  title: z.string().trim().min(1, 'Meldungstext fehlt').max(100),
  detail: z.string().trim().max(200).optional(),
  enabled: z.boolean().default(true),
});
export type LogoRuleInput = z.input<typeof logoRuleInputSchema>;
export interface LogoRule {
  id: string;
  signal: string;
  op: LogoOp;
  value: number;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  enabled: boolean;
}

export const logoLinkInputSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt').max(60),
  /** Tasteingang: NI, das ELVIS kurz auf 1 und wieder auf 0 setzt */
  button: signalIdSchema.refine((id) => parseLogoSignalId(id)?.kind === 'NI', 'Der Taster muss ein Netzwerk-Eingang (NI) sein'),
  /** Schaltausgang, dessen Zustand „an“ bedeutet (Q, M oder NQ) */
  output: signalIdSchema.refine((id) => digitalOutputKinds.includes(parseLogoSignalId(id)!.kind), 'Der Ausgang muss Q, M oder NQ sein'),
});
export type LogoLinkInput = z.input<typeof logoLinkInputSchema>;
export interface LogoLink {
  id: string;
  name: string;
  button: string;
  output: string;
}

export const logoLabelInputSchema = z.object({ label: z.string().trim().max(60) });

export interface LogoConfig {
  /** Bezeichnungen je Signal („Q7“ → „Umfeldbeleuchtung“) */
  labels: Record<string, string>;
  rules: LogoRule[];
  links: LogoLink[];
}

export const EMPTY_LOGO_CONFIG: LogoConfig = { labels: {}, rules: [], links: [] };

export interface LogoState extends LogoConfig {
  /** Letzte Abfrage hat geklappt */
  connected: boolean;
  error: string | null;
  /** Zeitpunkt der letzten erfolgreichen Abfrage */
  updatedAt: string | null;
  /** Aktuelle Werte je Signal; leer, solange noch nie gelesen wurde */
  values: Record<string, number>;
}

// --- Regeln ---

export function logoRuleActive(rule: LogoRule, values: Record<string, number>): boolean {
  const v = values[rule.signal];
  if (v === undefined) return false;
  switch (rule.op) {
    case '=': return v === rule.value;
    case '!=': return v !== rule.value;
    case '>': return v > rule.value;
    case '<': return v < rule.value;
    case '>=': return v >= rule.value;
    case '<=': return v <= rule.value;
  }
}

export interface LogoAlertDraft {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail?: string;
}

/** Aktive Regeln als Meldungen; Kennung stabil je Regel */
export function evaluateLogoRules(state: Pick<LogoState, 'rules' | 'values' | 'labels'>): LogoAlertDraft[] {
  const out: LogoAlertDraft[] = [];
  for (const r of state.rules) {
    if (!r.enabled || !logoRuleActive(r, state.values)) continue;
    out.push({ id: `logo:rule:${r.id}`, severity: r.severity, title: r.title, detail: r.detail || undefined });
  }
  return out;
}

/** Anzeigename eines Signals: Bezeichnung, sonst die Kennung */
export function logoName(labels: Record<string, string>, id: string): string {
  return labels[id] || id;
}

export const LOGO_DEFAULT_PORT = 102;
