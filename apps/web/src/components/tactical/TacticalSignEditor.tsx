import {
  TACTICAL_ABOVE,
  TACTICAL_BASES,
  TACTICAL_INSIDE,
  TACTICAL_FUNCTIONS,
  TACTICAL_MOBILITY,
  TACTICAL_ORGS,
  TACTICAL_SIZES,
  type TacticalSign,
} from '@elvis/shared';
import { Field, Toggle } from '../ui';
import { TacticalSignImage } from './TacticalSign';

function Select<K extends string>({ label, value, options, onChange, disabled }: { label: string; value: K; options: Record<K, string | { label: string }>; onChange: (v: K) => void; disabled?: boolean }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value as K)} disabled={disabled}>
        {(Object.entries(options) as [K, string | { label: string }][]).map(([k, v]) => (
          <option key={k} value={k}>
            {typeof v === 'string' ? v : v.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Zusammenstellen eines taktischen Zeichens mit Live-Vorschau; bases schränkt die Grundzeichen ein (eines = keine Auswahl). */
export function TacticalSignEditor({
  value,
  onChange,
  disabled,
  bases,
}: {
  value: TacticalSign;
  onChange: (s: TacticalSign) => void;
  disabled?: boolean;
  bases?: TacticalSign['base'][];
}) {
  const set = <K extends keyof TacticalSign>(k: K, v: TacticalSign[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="sign-editor">
      <div className="sign-preview" aria-live="polite">
        <TacticalSignImage sign={value} height={150} />
      </div>
      <div className="sign-controls">
        {(!bases || bases.length > 1) && (
          <Select
            label="Grundzeichen"
            value={value.base}
            options={bases ? (Object.fromEntries(bases.map((b) => [b, TACTICAL_BASES[b]])) as Record<TacticalSign['base'], string>) : TACTICAL_BASES}
            onChange={(v) => set('base', v)}
            disabled={disabled}
          />
        )}
        {value.base === 'vehicle' && <Select label="Fahrzeugart" value={value.mobility} options={TACTICAL_MOBILITY} onChange={(v) => set('mobility', v)} disabled={disabled} />}
        <Select label="Organisation (Farbe)" value={value.org} options={TACTICAL_ORGS} onChange={(v) => set('org', v)} disabled={disabled} />
        <Select label="Fachaufgabe" value={value.function} options={TACTICAL_FUNCTIONS} onChange={(v) => set('function', v)} disabled={disabled} />
        <Select label="Symbol über dem Zeichen" value={value.above} options={TACTICAL_ABOVE} onChange={(v) => set('above', v)} disabled={disabled} />
        <Select label="Symbol im Zeichen" value={value.inside} options={TACTICAL_INSIDE} onChange={(v) => set('inside', v)} disabled={disabled} />
        <Select label="Größenordnung" value={value.size} options={TACTICAL_SIZES} onChange={(v) => set('size', v)} disabled={disabled} />
        <Field label="Text im Zeichen" hint="z. B. ELW 2, LF 20, TEL">
          <input value={value.text} maxLength={12} onChange={(e) => set('text', e.target.value)} disabled={disabled} />
        </Field>
        <Field label="Organisationskürzel" hint="unten rechts, z. B. FW, THW">
          <input value={value.orgLabel} maxLength={6} onChange={(e) => set('orgLabel', e.target.value)} disabled={disabled} />
        </Field>
        <Field label="Bezeichnung rechts" hint="z. B. Funkrufname oder Herkunft">
          <input value={value.label} maxLength={40} onChange={(e) => set('label', e.target.value)} disabled={disabled} />
        </Field>
        {value.base === 'person' && <Toggle label="Führer (Spitze ausgefüllt)" checked={value.leader} onChange={(v) => set('leader', v)} disabled={disabled} />}
      </div>
    </div>
  );
}
