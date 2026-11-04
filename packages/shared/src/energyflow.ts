import { z } from 'zod';
import type { BluetoothDeviceLive } from './bluetooth';
import { VICTRON_STATE_LABELS } from './bluetooth';
import { INVERTER_STATE_LABELS, type InverterState } from './inverter';

/**
 * Energiefluss: Quellen und Verbraucher rund um das Fahrzeug, wie auf der Energie-Seite gezeichnet.
 * Sechs feste Plätze um die Mitte; je Platz Art, Bezeichnung und Datenquelle(n). Admins stellen das in den
 * Einstellungen ein, ohne Einstellung ergibt es sich aus den vorhandenen Geräten.
 */

export const ENERGY_SLOTS = ['top', 'left-1', 'left-2', 'right-1', 'right-2', 'bottom'] as const;
export type EnergySlot = (typeof ENERGY_SLOTS)[number];

export const ENERGY_SLOT_LABELS: Record<EnergySlot, string> = {
  top: 'Oben',
  'left-1': 'Links oben',
  'left-2': 'Links unten',
  'right-1': 'Rechts oben',
  'right-2': 'Rechts unten',
  bottom: 'Unten',
};

export const ENERGY_NODE_KINDS = ['shore', 'generator', 'solar', 'alternator', 'charger', 'ac-loads', 'dc-loads', 'battery'] as const;
export type EnergyNodeKind = (typeof ENERGY_NODE_KINDS)[number];

export const ENERGY_KIND_LABELS: Record<EnergyNodeKind, string> = {
  shore: 'Landstrom',
  generator: 'Generator',
  solar: 'Solar',
  alternator: 'Lichtmaschine',
  charger: 'Ladegerät',
  'ac-loads': 'AC-Verbraucher',
  'dc-loads': 'DC-Verbraucher',
  battery: 'Batterie',
};

/** Richtung relativ zur Mitte: Quellen liefern hinein, Verbraucher entnehmen, die Batterie beides */
export const ENERGY_KIND_ROLE: Record<EnergyNodeKind, 'source' | 'sink' | 'storage'> = {
  shore: 'source',
  generator: 'source',
  solar: 'source',
  alternator: 'source',
  charger: 'source',
  'ac-loads': 'sink',
  'dc-loads': 'sink',
  battery: 'storage',
};

/** Woher die Werte eines Platzes kommen */
export type EnergySource =
  /** Wechselrichter am VE.Bus: Landstrom-Eingang, AC-Ausgang oder Batterieseite */
  | { type: 'inverter'; channel: 'ac-in' | 'ac-out' | 'dc' }
  /** Bluetooth-Gerät (Victron Instant Readout) */
  | { type: 'bluetooth'; deviceId: string }
  /** Rest der Bilanz: was nach allen anderen Plätzen übrig bleibt (z. B. DC-Verbraucher ohne eigenen Messpunkt) */
  | { type: 'balance' };

export const INVERTER_CHANNEL_LABELS: Record<'ac-in' | 'ac-out' | 'dc', string> = {
  'ac-in': 'Wechselrichter: Landstrom-Eingang',
  'ac-out': 'Wechselrichter: AC-Ausgang',
  dc: 'Wechselrichter: Batterieseite (DC)',
};

export interface EnergyFlowNode {
  slot: EnergySlot;
  kind: EnergyNodeKind;
  label: string;
  source: EnergySource;
  /** Füllt Werte, die die erste Quelle nicht liefert (z. B. Ladezustand vom SmartShunt) */
  extra: EnergySource | null;
}

export interface EnergyFlowConfig {
  nodes: EnergyFlowNode[];
  /** Bezeichnung der Mitte */
  hubLabel: string;
}

/** Gespeicherte Einstellung; `config` null = automatisch aus den Geräten */
export interface EnergyFlowSettings {
  config: EnergyFlowConfig | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inverter'), channel: z.enum(['ac-in', 'ac-out', 'dc']) }),
  z.object({ type: z.literal('bluetooth'), deviceId: z.string().min(1).max(80) }),
  z.object({ type: z.literal('balance') }),
]);

export const energyFlowConfigSchema = z
  .object({
    nodes: z
      .array(
        z.object({
          slot: z.enum(ENERGY_SLOTS),
          kind: z.enum(ENERGY_NODE_KINDS),
          label: z.string().trim().max(30),
          source: sourceSchema,
          extra: sourceSchema.nullable(),
        }),
      )
      .max(ENERGY_SLOTS.length),
    hubLabel: z.string().trim().max(30),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.nodes.forEach((n, i) => {
      if (seen.has(n.slot)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'slot'], message: `Platz „${ENERGY_SLOT_LABELS[n.slot]}“ ist doppelt belegt` });
      seen.add(n.slot);
      if (n.extra?.type === 'balance') ctx.addIssue({ code: 'custom', path: ['nodes', i, 'extra'], message: 'Die Bilanz taugt nicht als Zusatzquelle' });
    });
    if (c.nodes.filter((n) => n.source.type === 'balance').length > 1) ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'Nur ein Platz kann die Bilanz zeigen' });
  });

export const energyFlowInputSchema = z.object({ config: energyFlowConfigSchema.nullable() });
export type EnergyFlowInput = z.input<typeof energyFlowInputSchema>;

// --- Werte ---

/** Messwerte eines Platzes; Leistung in Richtung der Art (Quelle liefert, Verbraucher nimmt, Batterie lädt > 0) */
export interface EnergyReading {
  w: number | null;
  v: number | null;
  a: number | null;
  socPct: number | null;
  /** z. B. „Konstantstrom (Bulk)“ */
  status: string | null;
  /** Werte veraltet bzw. Quelle nicht verbunden */
  stale: boolean;
  /** Quelle fehlt (Modul aus, Gerät gelöscht) */
  missing: boolean;
}

export interface EnergyData {
  inverter: InverterState | null;
  /** Modul verbunden */
  inverterOnline: boolean;
  bluetooth: BluetoothDeviceLive[];
}

const EMPTY: EnergyReading = { w: null, v: null, a: null, socPct: null, status: null, stale: false, missing: true };
const sum = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);
const mul = (v: number | null, a: number | null) => (v !== null && a !== null ? v * a : null);
const victronState = (s: number | null) => (s === null ? null : (VICTRON_STATE_LABELS[s] ?? null));

function inverterReading(inv: InverterState, online: boolean, channel: 'ac-in' | 'ac-out' | 'dc'): EnergyReading {
  const base = { socPct: null, stale: !online || !inv.link.connected, missing: false };
  const status = inv.opState ? INVERTER_STATE_LABELS[inv.opState] : null;
  if (channel === 'ac-in') {
    const v = inv.phases[0]?.acIn.v ?? null;
    return { ...base, v, a: sum(inv.phases.map((p) => p.acIn.a)), w: sum(inv.phases.map((p) => mul(p.acIn.v, p.acIn.a))), status: v !== null && v < 50 ? 'kein Landstrom' : status };
  }
  if (channel === 'ac-out') {
    return { ...base, v: inv.phases[0]?.acOut.v ?? null, a: sum(inv.phases.map((p) => p.acOut.a)), w: inv.outputW ?? sum(inv.phases.map((p) => mul(p.acOut.v, p.acOut.a))), status: null };
  }
  return { ...base, v: inv.dc.v, a: inv.dc.a, w: mul(inv.dc.v, inv.dc.a), status: null };
}

function bluetoothReading(d: BluetoothDeviceLive): EnergyReading {
  const base = { ...EMPTY, missing: false, stale: d.stale || !d.readout };
  const r = d.readout;
  if (!r) return base;
  switch (r.type) {
    case 'battery-monitor':
      return { ...base, v: r.voltageV, a: r.currentA, w: mul(r.voltageV, r.currentA), socPct: r.socPct };
    case 'lithium':
      return { ...base, v: r.voltageV };
    case 'solar':
      return { ...base, v: r.voltageV, a: r.currentA, w: r.pvPowerW ?? mul(r.voltageV, r.currentA), status: victronState(r.state) };
    case 'dcdc':
      return { ...base, v: r.outputVoltageV, status: victronState(r.state) };
    case 'ac-charger': {
      const v = r.outputs[0]?.voltageV ?? null;
      return { ...base, v, a: sum(r.outputs.map((o) => o.currentA)), w: sum(r.outputs.map((o) => mul(o.voltageV, o.currentA))), status: victronState(r.state) };
    }
    default:
      return base;
  }
}

/** Werte einer Quelle (ohne Bilanz) */
export function energySourceReading(source: EnergySource, data: EnergyData): EnergyReading {
  if (source.type === 'inverter') return data.inverter ? inverterReading(data.inverter, data.inverterOnline, source.channel) : EMPTY;
  if (source.type === 'bluetooth') {
    const d = data.bluetooth.find((x) => x.id === source.deviceId);
    return d ? bluetoothReading(d) : EMPTY;
  }
  return EMPTY;
}

function merge(a: EnergyReading, b: EnergyReading): EnergyReading {
  if (b.missing) return a;
  const w = a.w ?? b.w ?? mul(a.v ?? b.v, a.a ?? b.a);
  return { w, v: a.v ?? b.v, a: a.a ?? b.a, socPct: a.socPct ?? b.socPct, status: a.status ?? b.status, stale: a.missing ? b.stale : a.stale, missing: false };
}

/** Werte aller Plätze; ein Platz mit „Bilanz“ bekommt, was nach allen übrigen Plätzen übrig bleibt */
export function energyReadings(config: EnergyFlowConfig, data: EnergyData): Map<EnergySlot, EnergyReading> {
  const out = new Map<EnergySlot, EnergyReading>();
  for (const n of config.nodes) {
    if (n.source.type === 'balance') continue;
    const r = energySourceReading(n.source, data);
    out.set(n.slot, n.extra ? merge(r, energySourceReading(n.extra, data)) : r);
  }
  const balance = config.nodes.find((n) => n.source.type === 'balance');
  if (balance) {
    // Fluss in die Mitte: Quellen +, Verbraucher −, Batterie − beim Laden
    let net = 0;
    let known = 0;
    for (const n of config.nodes) {
      const r = out.get(n.slot);
      if (!r || r.w === null || n === balance) continue;
      net += energyIntoHub(n.kind, r.w);
      known++;
    }
    // Was in der Mitte übrig bleibt, nimmt ein Verbraucher bzw. die Batterie auf; eine Quelle muss es liefern
    const w = known >= 2 ? (ENERGY_KIND_ROLE[balance.kind] === 'source' ? -net : net) : null;
    out.set(balance.slot, { ...EMPTY, missing: false, w, status: w === null ? null : 'berechnet' });
  }
  return out;
}

/** Leistung in die Mitte hinein (> 0) bzw. aus ihr heraus (< 0) */
export function energyIntoHub(kind: EnergyNodeKind, w: number): number {
  const role = ENERGY_KIND_ROLE[kind];
  return role === 'source' ? w : -w;
}

// --- Automatische Belegung ---

/**
 * Belegung aus den vorhandenen Geräten: Wechselrichter mit Landstrom, AC-Ausgang und Batterie; Bluetooth-Geräte
 * je nach Art (Solar oben, DC/DC-Lader als Lichtmaschine, Ladegerät, Batteriemonitor für die Batterie).
 */
export function defaultEnergyFlow(data: { inverter: boolean; bluetooth: Pick<BluetoothDeviceLive, 'id' | 'name' | 'readout'>[] }): EnergyFlowConfig {
  const nodes: EnergyFlowNode[] = [];
  const free = (slot: EnergySlot) => !nodes.some((n) => n.slot === slot);
  const firstFree = (slots: EnergySlot[]) => slots.find(free) ?? null;
  const bt = (type: string) => data.bluetooth.filter((d) => d.readout?.type === type);
  const monitor = bt('battery-monitor')[0] ?? bt('lithium')[0] ?? null;

  if (data.inverter) {
    nodes.push({ slot: 'left-1', kind: 'shore', label: 'Landstrom', source: { type: 'inverter', channel: 'ac-in' }, extra: null });
    nodes.push({ slot: 'right-1', kind: 'ac-loads', label: '230 V', source: { type: 'inverter', channel: 'ac-out' }, extra: null });
  }
  if (monitor && monitor.readout?.type === 'battery-monitor') {
    nodes.push({ slot: 'bottom', kind: 'battery', label: monitor.name, source: { type: 'bluetooth', deviceId: monitor.id }, extra: null });
  } else if (data.inverter) {
    nodes.push({ slot: 'bottom', kind: 'battery', label: 'Batterie', source: { type: 'inverter', channel: 'dc' }, extra: monitor ? { type: 'bluetooth', deviceId: monitor.id } : null });
  } else if (monitor) {
    nodes.push({ slot: 'bottom', kind: 'battery', label: monitor.name, source: { type: 'bluetooth', deviceId: monitor.id }, extra: null });
  }
  for (const d of bt('solar')) {
    const slot = firstFree(['top', 'left-2', 'right-2']);
    if (slot) nodes.push({ slot, kind: 'solar', label: d.name, source: { type: 'bluetooth', deviceId: d.id }, extra: null });
  }
  for (const d of bt('dcdc')) {
    const slot = firstFree(['left-2', 'top', 'right-2']);
    if (slot) nodes.push({ slot, kind: 'alternator', label: d.name, source: { type: 'bluetooth', deviceId: d.id }, extra: null });
  }
  for (const d of bt('ac-charger')) {
    const slot = firstFree(['left-1', 'left-2', 'top', 'right-2']);
    if (slot) nodes.push({ slot, kind: 'charger', label: d.name, source: { type: 'bluetooth', deviceId: d.id }, extra: null });
  }
  // Misst ein Shunt die Batterie, bleibt in der Bilanz, was die übrigen DC-Verbraucher nehmen (samt Wandlungsverlusten).
  // Der Batteriestrom des Wechselrichters zählt nur dessen eigenen Anteil – dann wäre die Bilanz nur der Verlust.
  const slot = firstFree(['right-2', 'top', 'left-2']);
  const shunt = nodes.some((n) => n.kind === 'battery' && n.source.type === 'bluetooth' && monitor?.readout?.type === 'battery-monitor');
  if (slot && shunt && nodes.length >= 3) {
    nodes.push({ slot, kind: 'dc-loads', label: 'DC-Verbraucher', source: { type: 'balance' }, extra: null });
  }
  return { nodes, hubLabel: '' };
}
