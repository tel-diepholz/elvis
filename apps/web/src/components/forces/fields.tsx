import { useId } from 'react';
import { UNIT_ROLE_SUGGESTIONS, UNIT_STATUS, UNIT_STATUSES, type Strength, type UnitStatus } from '@elvis/shared';

/** Stärke Führer / Unterführer / Mannschaft mit Summe */
export function StrengthFields({ value, onChange, legend = 'Stärke (Führer / Unterführer / Mannschaft)' }: { value: Strength; onChange: (s: Strength) => void; legend?: string }) {
  const set = (k: keyof Strength) => (e: { target: { value: string } }) => onChange({ ...value, [k]: Math.max(0, Number(e.target.value) || 0) });
  return (
    <fieldset className="strength">
      <legend>{legend}</legend>
      <input type="number" min={0} value={value.leaders} onChange={set('leaders')} aria-label="Führer" />
      <span>/</span>
      <input type="number" min={0} value={value.subLeaders} onChange={set('subLeaders')} aria-label="Unterführer" />
      <span>/</span>
      <input type="number" min={0} value={value.crew} onChange={set('crew')} aria-label="Mannschaft" />
      <span>= {value.leaders + value.subLeaders + value.crew}</span>
    </fieldset>
  );
}

/** Rolle als Freitext; vorgeschlagen werden die Standardrollen und alle bereits verwendeten */
export function RoleInput({ value, onChange, used = [], disabled, ariaLabel }: { value: string; onChange: (v: string) => void; used?: string[]; disabled?: boolean; ariaLabel?: string }) {
  const list = useId();
  const options = [...new Set([...UNIT_ROLE_SUGGESTIONS, ...used.filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  return (
    <>
      <input value={value} onChange={(e) => onChange(e.target.value)} list={list} maxLength={60} placeholder="z. B. Führungsfahrzeug" disabled={disabled} aria-label={ariaLabel} />
      <datalist id={list}>
        {options.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </>
  );
}

export function StatusSelect({ value, onChange, className = '', ariaLabel }: { value: UnitStatus; onChange: (s: UnitStatus) => void; className?: string; ariaLabel?: string }) {
  return (
    <select className={`unit-status unit-status-${value} ${className}`} value={value} onChange={(e) => onChange(e.target.value as UnitStatus)} aria-label={ariaLabel}>
      {UNIT_STATUSES.map((s) => (
        <option key={s} value={s}>
          {UNIT_STATUS[s]}
        </option>
      ))}
    </select>
  );
}

export function StatusBadge({ status }: { status: UnitStatus }) {
  return <span className={`unit-status unit-status-${status}`}>{UNIT_STATUS[status]}</span>;
}
