import { Fragment, useId, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  MAX_SHEET_PERSONS,
  PERSON_GRADE,
  PERSON_GRADES,
  QUALIFICATION_SUGGESTIONS,
  personInputSchema,
  personName,
  type Person,
  type PersonData,
  type PersonGrade,
} from '@elvis/shared';
import { Badge, Field } from '../ui';

export const emptyPerson = (organization = ''): PersonData => ({
  lastName: '',
  firstName: '',
  birthDate: '',
  grade: 'crew',
  function: '',
  qualifications: [],
  organization,
  phone: '',
  address: '',
  employer: '',
  emergencyContact: '',
  notes: '',
});

const FUNCTIONS = ['Verbandsführer', 'Zugführer', 'Gruppenführer', 'Staffelführer', 'Truppführer', 'Maschinist', 'Melder', 'Angriffstrupp', 'Wassertrupp', 'Schlauchtrupp', 'Sanitäter'];

/** Qualifikationen zum Ankreuzen; eigene kommagetrennt dazu */
function QualificationPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const extra = value.filter((q) => !QUALIFICATION_SUGGESTIONS.includes(q));
  const [more, setMore] = useState(extra.join(', '));
  const toggle = (q: string) => onChange(value.includes(q) ? value.filter((x) => x !== q) : [...value, q]);
  const setExtra = (text: string) => {
    setMore(text);
    const own = text
      .split(',')
      .map((s) => s.trim().slice(0, 40))
      .filter(Boolean);
    onChange([...new Set([...value.filter((q) => QUALIFICATION_SUGGESTIONS.includes(q)), ...own])].slice(0, 30));
  };
  return (
    <fieldset className="qual-picker">
      <legend>Qualifikationen</legend>
      <div className="chip-row">
        {QUALIFICATION_SUGGESTIONS.map((q) => (
          <label key={q} className={`qual-chip ${value.includes(q) ? 'on' : ''}`}>
            <input type="checkbox" checked={value.includes(q)} onChange={() => toggle(q)} />
            {q}
          </label>
        ))}
      </div>
      <input value={more} onChange={(e) => setExtra(e.target.value)} placeholder="weitere, durch Komma getrennt" maxLength={300} aria-label="Weitere Qualifikationen" />
    </fieldset>
  );
}

/** Felder eines Personalbogens für eine Person */
export function PersonFields({ value, onChange, autoFocus }: { value: PersonData; onChange: (p: PersonData) => void; autoFocus?: boolean }) {
  const list = useId();
  const set = (k: keyof PersonData) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <>
      <div className="form-grid">
        <Field label="Nachname *">
          <input value={value.lastName} onChange={set('lastName')} required maxLength={80} autoFocus={autoFocus} />
        </Field>
        <Field label="Vorname *">
          <input value={value.firstName} onChange={set('firstName')} required maxLength={80} />
        </Field>
        <Field label="Geburtsdatum">
          <input type="date" value={value.birthDate} onChange={set('birthDate')} />
        </Field>
        <Field label="Einordnung">
          <select value={value.grade} onChange={(e) => onChange({ ...value, grade: e.target.value as PersonGrade })}>
            {PERSON_GRADES.map((g) => (
              <option key={g} value={g}>
                {PERSON_GRADE[g]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Funktion">
          <input value={value.function} onChange={set('function')} list={list} maxLength={60} placeholder="z. B. Maschinist" />
          <datalist id={list}>
            {FUNCTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <Field label="Feuerwehr / Organisation">
          <input value={value.organization} onChange={set('organization')} maxLength={100} />
        </Field>
        <Field label="Telefon">
          <input type="tel" value={value.phone} onChange={set('phone')} maxLength={40} />
        </Field>
        <Field label="Anschrift">
          <input value={value.address} onChange={set('address')} maxLength={200} />
        </Field>
        <Field label="Arbeitgeber" hint="für Freistellung und Verdienstausfall">
          <input value={value.employer} onChange={set('employer')} maxLength={200} />
        </Field>
        <Field label="Im Notfall benachrichtigen" hint="Name und Telefon">
          <input value={value.emergencyContact} onChange={set('emergencyContact')} maxLength={200} />
        </Field>
      </div>
      <QualificationPicker value={value.qualifications} onChange={(qualifications) => onChange({ ...value, qualifications })} />
      <Field label="Bemerkung">
        <input value={value.notes} onChange={set('notes')} maxLength={500} />
      </Field>
    </>
  );
}

const valid = (p: PersonData) => personInputSchema.safeParse(p).success;

/** Personalbogen: eine oder mehrere Personen auf einmal (Organisation wird für die nächste übernommen) */
export function PersonnelSheetForm({ defaultOrganization = '', pending, onSubmit }: { defaultOrganization?: string; pending: boolean; onSubmit: (persons: PersonData[]) => void }) {
  const [persons, setPersons] = useState<PersonData[]>([emptyPerson(defaultOrganization)]);
  const ok = persons.length > 0 && persons.every(valid);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok) onSubmit(persons);
  };
  return (
    <form className="form" onSubmit={submit}>
      {persons.map((p, i) => (
        <fieldset key={i} className="person-card">
          <legend>
            Person {i + 1}
            {persons.length > 1 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPersons((list) => list.filter((_, j) => j !== i))}>
                Entfernen
              </button>
            )}
          </legend>
          <PersonFields value={p} autoFocus={i === persons.length - 1} onChange={(next) => setPersons((list) => list.map((x, j) => (j === i ? next : x)))} />
        </fieldset>
      ))}
      <div className="form-actions spread">
        <button
          type="button"
          className="btn"
          disabled={persons.length >= MAX_SHEET_PERSONS}
          onClick={() => setPersons((list) => [...list, emptyPerson(list.at(-1)?.organization ?? defaultOrganization)])}
        >
          <Plus size={16} /> Person
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || !ok}>
          {persons.length === 1 ? 'Person erfassen' : `${persons.length} Personen erfassen`}
        </button>
      </div>
    </form>
  );
}

export function PersonForm({ initial, pending, onSubmit }: { initial: PersonData; pending: boolean; onSubmit: (p: PersonData) => void }) {
  const [p, setP] = useState<PersonData>(initial);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid(p)) onSubmit(p);
      }}
    >
      <PersonFields value={p} onChange={setP} autoFocus />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !valid(p)}>
          Speichern
        </button>
      </div>
    </form>
  );
}

const fmtBirth = (iso: string) => (iso ? iso.split('-').reverse().join('.') : '');

/** Personal als Tabelle; Kontakt und Weiteres in der zweiten Zeile */
export function PersonnelTable({ persons, onEdit, onRemove }: { persons: (PersonData & { id?: number })[]; onEdit?: (p: Person) => void; onRemove?: (p: Person) => void }) {
  return (
    <div className="table-wrap">
      <table className="table personnel-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Funktion</th>
            <th>Qualifikationen</th>
            <th>Kontakt</th>
            {(onEdit || onRemove) && <th />}
          </tr>
        </thead>
        <tbody>
          {persons.map((p, i) => (
            <Fragment key={p.id ?? i}>
              <tr>
                <td>
                  <div className="cell-title">{personName(p)}</div>
                  <div className="cell-sub">{[fmtBirth(p.birthDate) && `geb. ${fmtBirth(p.birthDate)}`, p.organization].filter(Boolean).join(' · ') || '–'}</div>
                </td>
                <td>
                  {p.function || '–'}
                  <div className="cell-sub">{PERSON_GRADE[p.grade]}</div>
                </td>
                <td>
                  <span className="chip-row">
                    {p.qualifications.length ? p.qualifications.map((q) => <Badge key={q}>{q}</Badge>) : '–'}
                  </span>
                </td>
                <td>
                  {p.phone || '–'}
                  {p.address && <div className="cell-sub">{p.address}</div>}
                  {p.employer && <div className="cell-sub">Arbeitgeber: {p.employer}</div>}
                  {p.emergencyContact && <div className="cell-sub">Notfall: {p.emergencyContact}</div>}
                  {p.notes && <div className="cell-sub">{p.notes}</div>}
                </td>
                {(onEdit || onRemove) && (
                  <td className="cell-actions">
                    {onEdit && (
                      <button className="btn btn-ghost btn-icon" onClick={() => onEdit(p as Person)} aria-label={`${personName(p)} bearbeiten`} title="Bearbeiten">
                        <Pencil size={16} />
                      </button>
                    )}
                    {onRemove && (
                      <button
                        className="btn btn-ghost btn-icon"
                        onClick={() => window.confirm(`${personName(p)} aus dem Personal entfernen?`) && onRemove(p as Person)}
                        aria-label={`${personName(p)} entfernen`}
                        title="Entfernen"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
