import type { CSSProperties, ReactNode } from 'react';
import { Battery, BatteryCharging, Car, Fuel, Lightbulb, Plug, PlugZap, Sun, Truck } from 'lucide-react';
import {
  ENERGY_KIND_LABELS,
  ENERGY_KIND_ROLE,
  ENERGY_SLOTS,
  energyIntoHub,
  energyReadings,
  type EnergyData,
  type EnergyFlowConfig,
  type EnergyFlowNode,
  type EnergyNodeKind,
  type EnergyReading,
  type EnergySlot,
} from '@elvis/shared';
import { fmtNum } from '../../lib/format';

const ICONS: Record<EnergyNodeKind, (p: { size: number }) => ReactNode> = {
  shore: (p) => <PlugZap {...p} />,
  generator: (p) => <Fuel {...p} />,
  solar: (p) => <Sun {...p} />,
  alternator: (p) => <Car {...p} />,
  charger: (p) => <BatteryCharging {...p} />,
  'ac-loads': (p) => <Plug {...p} />,
  'dc-loads': (p) => <Lightbulb {...p} />,
  battery: (p) => <Battery {...p} />,
};

/** Mittelpunkt der Plätze in % der (quadratischen) Fläche */
const POS: Record<EnergySlot, { x: number; y: number }> = {
  top: { x: 50, y: 12.5 },
  'left-1': { x: 15, y: 37 },
  'left-2': { x: 15, y: 63 },
  'right-1': { x: 85, y: 37 },
  'right-2': { x: 85, y: 63 },
  bottom: { x: 50, y: 87.5 },
};
const NODE_W = 28;
const NODE_H = 22;
const HUB_W = 26;
const HUB_H = 21;

/** Linie vom Platz zur Mitte (viewBox 0–100) */
function linkPath(slot: EnergySlot): string {
  const { x, y } = POS[slot];
  const hubTop = 50 - HUB_H / 2;
  const hubBottom = 50 + HUB_H / 2;
  if (slot === 'top') return `M 50 ${y + NODE_H / 2} L 50 ${hubTop}`;
  if (slot === 'bottom') return `M 50 ${y - NODE_H / 2} L 50 ${hubBottom}`;
  const left = slot.startsWith('left');
  const x1 = left ? x + NODE_W / 2 : x - NODE_W / 2;
  const x2 = left ? 50 - HUB_W / 2 : 50 + HUB_W / 2;
  const y2 = y < 50 ? 45 : 55;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y} C ${mid} ${y} ${mid} ${y2} ${x2} ${y2}`;
}

/** Unter dieser Leistung fließt nichts Sichtbares */
const IDLE_W = 3;

/** Pfeil in Flussrichtung, vom Platz aus gesehen */
function arrow(slot: EnergySlot, intoHub: boolean): string {
  const toward = slot === 'top' ? '↓' : slot === 'bottom' ? '↑' : slot.startsWith('left') ? '→' : '←';
  const away = slot === 'top' ? '↑' : slot === 'bottom' ? '↓' : slot.startsWith('left') ? '←' : '→';
  return intoHub ? toward : away;
}

const fmtW = (w: number) => (Math.abs(w) >= 10_000 ? `${fmtNum(w / 1000, 1)} kW` : `${fmtNum(Math.round(w), 0)} W`);
const fmtV = (v: number | null) => (v === null ? null : fmtNum(v, v >= 100 ? 0 : 1));
const fmtA = (a: number | null) => (a === null ? null : fmtNum(a, 1));

interface Placed {
  node: EnergyFlowNode;
  r: EnergyReading;
  /** Leistung in die Mitte hinein (> 0) bzw. heraus (< 0) */
  into: number | null;
  active: boolean;
  dim: boolean;
}

function describe(p: Placed): string {
  const { node, r } = p;
  const parts = [
    node.label || ENERGY_KIND_LABELS[node.kind],
    r.missing ? 'keine Quelle' : r.stale ? 'keine aktuellen Werte' : null,
    r.w !== null ? fmtW(r.w) : null,
    r.v !== null ? `${fmtV(r.v)} V` : null,
    r.a !== null ? `${fmtA(r.a)} A` : null,
    r.socPct !== null ? `${fmtNum(r.socPct, 0)} %` : null,
    r.status,
  ];
  return parts.filter(Boolean).join(' · ');
}

function Node({ p }: { p: Placed }) {
  const { node, r } = p;
  const pos = POS[node.slot];
  const battery = node.kind === 'battery';
  const soc = battery && r.socPct !== null ? Math.max(0, Math.min(100, r.socPct)) : null;
  const intoHub = p.into !== null && p.into > 0;
  return (
    <div
      className={`ef-node ef-${node.kind}${p.dim ? ' dim' : ''}`}
      style={{ left: `${pos.x - NODE_W / 2}%`, top: `${pos.y - NODE_H / 2}%`, width: `${NODE_W}%`, height: `${NODE_H}%`, '--soc': soc === null ? '0%' : `${soc}%` } as CSSProperties}
      title={describe(p)}
    >
      <span className="ef-label">{node.label || ENERGY_KIND_LABELS[node.kind]}</span>
      <span className="ef-row">
        <span className="ef-side">{fmtV(r.v) !== null && <>{fmtV(r.v)}<small> V</small></>}</span>
        <span className="ef-icon">{ICONS[node.kind]({ size: 22 })}</span>
        <span className="ef-side">{fmtA(r.a) !== null && <>{fmtA(r.a)}<small> A</small></>}</span>
      </span>
      <span className="ef-power">
        {r.missing ? 'keine Quelle' : r.w === null ? (r.stale ? 'kein Empfang' : '–') : p.active ? `${arrow(node.slot, intoHub)} ${fmtW(Math.abs(r.w))}` : fmtW(0)}
      </span>
      <span className="ef-status">{soc !== null ? `${fmtNum(soc, 0)} %` : r.stale && r.w !== null ? 'veraltet' : (r.status ?? '')}</span>
    </div>
  );
}

/**
 * Energiefluss um das Fahrzeug: Plätze nach der Einstellung, Linien zur Mitte, laufende Punkte in Flussrichtung
 * (je mehr Leistung, desto schneller). Leere oder ruhende Plätze sind blass.
 */
export function EnergyFlow({ config, data, hubLabel }: { config: EnergyFlowConfig; data: EnergyData; hubLabel: string }) {
  const readings = energyReadings(config, data);
  const placed: Placed[] = ENERGY_SLOTS.flatMap((slot) => {
    const node = config.nodes.find((n) => n.slot === slot);
    if (!node) return [];
    const r = readings.get(slot)!;
    const into = r.w === null ? null : energyIntoHub(node.kind, r.w);
    const active = !r.missing && !r.stale && r.w !== null && Math.abs(r.w) >= IDLE_W;
    const noData = r.missing || (r.w === null && r.v === null);
    return [{ node, r, into, active, dim: noData || r.stale || (r.w !== null && !active) }];
  });
  const supply = placed.filter((p) => p.active && p.into! > 0 && ENERGY_KIND_ROLE[p.node.kind] === 'source').reduce((s, p) => s + p.into!, 0);

  return (
    <div className="ef" role="group" aria-label="Energiefluss">
      <div className="ef-stage">
        <svg className="ef-links" viewBox="0 0 100 100" aria-hidden>
          {placed.map((p) => {
            const d = linkPath(p.node.slot);
            const dur = p.active ? Math.max(0.6, Math.min(3, 3.4 - 0.9 * Math.log10(Math.abs(p.r.w!)))) : 0;
            return (
              <g key={p.node.slot} className={`ef-${p.node.kind}${p.dim ? ' dim' : ''}`}>
                <path d={d} className="ef-line" />
                {p.active && <path d={d} className={`ef-dots${p.into! > 0 ? '' : ' reverse'}`} style={{ animationDuration: `${dur}s` }} />}
              </g>
            );
          })}
        </svg>
        <div className="ef-hub" style={{ left: `${50 - HUB_W / 2}%`, top: `${50 - HUB_H / 2}%`, width: `${HUB_W}%`, height: `${HUB_H}%` }}>
          <span className="ef-label">{hubLabel}</span>
          <span className="ef-icon">
            <Truck size={26} />
          </span>
          <span className="ef-power">{supply > 0 ? fmtW(supply) : '–'}</span>
          <span className="ef-status">Einspeisung</span>
        </div>
        {placed.map((p) => (
          <Node key={p.node.slot} p={p} />
        ))}
      </div>
      <details className="ef-table">
        <summary>Werte als Tabelle</summary>
        <table className="table">
          <thead>
            <tr>
              <th>Platz</th>
              <th>Leistung</th>
              <th>Spannung</th>
              <th>Strom</th>
              <th>Zustand</th>
            </tr>
          </thead>
          <tbody>
            {placed.map((p) => (
              <tr key={p.node.slot}>
                <td>{p.node.label || ENERGY_KIND_LABELS[p.node.kind]}</td>
                <td className="mono">{p.r.w === null ? '–' : fmtW(p.r.w)}</td>
                <td className="mono">{p.r.v === null ? '–' : `${fmtV(p.r.v)} V`}</td>
                <td className="mono">{p.r.a === null ? '–' : `${fmtA(p.r.a)} A`}</td>
                <td>{[p.r.socPct !== null ? `${fmtNum(p.r.socPct, 0)} %` : null, p.r.missing ? 'keine Quelle' : p.r.stale ? 'veraltet' : p.r.status].filter(Boolean).join(' · ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
