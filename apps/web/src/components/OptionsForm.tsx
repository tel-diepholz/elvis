import { optionsSchema, type AddonManifest, type OptionValues } from '@elvis/shared';
import { SerialPortSelect } from './SerialPortSelect';
import { Field, Toggle } from './ui';

/**
 * Prüft Optionswerte mit demselben Schema wie der Server. Leere Passwortfelder gelten als
 * „unverändert“, wenn bereits ein Wert gespeichert ist.
 */
export function validateOptions(options: AddonManifest['options'], values: OptionValues, secretsSet: string[] = []): Record<string, string> {
  const probe = { ...values };
  for (const k of secretsSet) if (probe[k] === '') probe[k] = 'unverändert';
  const res = optionsSchema(options).safeParse(probe);
  if (res.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of res.error.issues) {
    const key = String(issue.path[0] ?? '');
    errors[key] ??= issue.message;
  }
  return errors;
}

/** Erzeugt das Formular eines Addons aus den Konfigurationsfragen seines Manifests. */
export function OptionsForm({
  options,
  values,
  onChange,
  errors,
  secretsSet = [],
  disabled,
  emptyText = 'Dieses Addon hat keine Einstellungen.',
}: {
  options: AddonManifest['options'];
  values: OptionValues;
  onChange: (v: OptionValues) => void;
  errors: Record<string, string>;
  secretsSet?: string[];
  disabled?: boolean;
  emptyText?: string;
}) {
  const set = (k: string, v: OptionValues[string]) => onChange({ ...values, [k]: v });
  const entries = Object.entries(options);
  if (entries.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <div className="options-form">
      {entries.map(([key, o]) => {
        const label = `${o.label}${o.required ? ' *' : ''}`;
        const hint = errors[key] ? undefined : o.help;
        const value = values[key];
        let control;
        switch (o.type) {
          case 'bool':
            return (
              <div key={key} className="options-bool">
                <Toggle label={label} checked={Boolean(value)} onChange={(v) => set(key, v)} disabled={disabled} />
                {o.help && <span className="field-hint">{o.help}</span>}
              </div>
            );
          case 'int':
            control = <input type="number" value={String(value ?? '')} min={o.min} max={o.max} step={1} disabled={disabled} onChange={(e) => set(key, e.target.value === '' ? '' : Number(e.target.value))} />;
            break;
          case 'select':
            control = (
              <select value={String(value ?? '')} disabled={disabled} onChange={(e) => set(key, e.target.value)}>
                {o.choices.map((c) => {
                  const [v, l] = typeof c === 'string' ? [c, c] : [c.value, c.label];
                  return (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  );
                })}
              </select>
            );
            break;
          case 'multiselect': {
            const selected = new Set(Array.isArray(value) ? value : []);
            const toggle = (v: string) => {
              const next = new Set(selected);
              if (next.has(v)) next.delete(v);
              else next.add(v);
              // Reihenfolge wie im Manifest beibehalten
              set(key, o.choices.map((c) => (typeof c === 'string' ? c : c.value)).filter((c) => next.has(c)));
            };
            return (
              <fieldset key={key} className={`multiselect ${errors[key] ? 'field-invalid' : ''}`} disabled={disabled}>
                <legend className="field-label">
                  {label} <span className="muted">({selected.size} gewählt)</span>
                </legend>
                {o.help && <span className="field-hint">{o.help}</span>}
                <div className="multiselect-grid">
                  {o.choices.map((c) => {
                    const [v, l] = typeof c === 'string' ? [c, c] : [c.value, c.label];
                    return (
                      <label key={v} className={`multiselect-item ${selected.has(v) ? 'checked' : ''}`}>
                        <input type="checkbox" checked={selected.has(v)} onChange={() => toggle(v)} /> {l}
                      </label>
                    );
                  })}
                </div>
                {errors[key] && <span className="field-error">{errors[key]}</span>}
              </fieldset>
            );
          }
          case 'password':
            control = (
              <input
                type="password"
                autoComplete="new-password"
                value={String(value ?? '')}
                placeholder={secretsSet.includes(key) ? '•••••• (unverändert)' : ''}
                disabled={disabled}
                onChange={(e) => set(key, e.target.value)}
              />
            );
            break;
          case 'serialport':
            control = <SerialPortSelect value={String(value ?? '')} disabled={disabled} onChange={(v) => set(key, v)} />;
            break;
          case 'ip':
            control = <input inputMode="decimal" value={String(value ?? '')} placeholder="z. B. 192.168.1.10" disabled={disabled} onChange={(e) => set(key, e.target.value.trim())} />;
            break;
          default:
            control = <input value={String(value ?? '')} maxLength={o.maxLength} disabled={disabled} onChange={(e) => set(key, e.target.value)} />;
        }
        return (
          <div key={key} className={errors[key] ? 'field-invalid' : undefined}>
            <Field label={label} hint={hint}>
              {control}
            </Field>
            {errors[key] && <span className="field-error">{errors[key]}</span>}
          </div>
        );
      })}
    </div>
  );
}
