import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CONTACT_KIND, CONTACT_KINDS, MAX_CONTACT_PHONES, contactInputSchema, folderPath, type ContactCategory, type ContactData } from '@elvis/shared';
import { Field, Segmented } from '../ui';

export const emptyContact = (categoryIds: number[] = []): ContactData => ({
  kind: 'person',
  lastName: '',
  firstName: '',
  organization: '',
  function: '',
  phones: [{ label: '', number: '' }],
  email: '',
  address: '',
  notes: '',
  categoryIds,
});

/** Kontakt anlegen oder bearbeiten; leere Telefonzeilen werden verworfen */
export function ContactForm({
  initial,
  categories,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: ContactData;
  categories: ContactCategory[];
  pending: boolean;
  onSubmit: (c: ContactData) => void;
  onCancel: () => void;
}) {
  const [c, setC] = useState<ContactData>(initial);
  const set = (patch: Partial<ContactData>) => setC({ ...c, ...patch });
  const setText = (k: 'lastName' | 'firstName' | 'organization' | 'function' | 'email' | 'address' | 'notes') => (e: { target: { value: string } }) => set({ [k]: e.target.value });
  const result = contactInputSchema.safeParse({ ...c, phones: c.phones.filter((p) => p.number.trim()) });
  const paths = categories.map((k) => ({ id: k.id, path: folderPath(categories, k.id) })).sort((a, b) => a.path.localeCompare(b.path, 'de'));
  const toggle = (id: number) => set({ categoryIds: c.categoryIds.includes(id) ? c.categoryIds.filter((x) => x !== id) : [...c.categoryIds, id] });
  const org = c.kind === 'organization';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (result.success) onSubmit(result.data);
  };

  return (
    <form className="form" onSubmit={submit}>
      <Segmented label="Art" value={c.kind} onChange={(kind) => set({ kind })} options={CONTACT_KINDS.map((k) => ({ value: k, label: CONTACT_KIND[k] }))} />
      <div className="form-grid">
        {org ? (
          <Field label="Name der Einrichtung *">
            <input value={c.organization} onChange={setText('organization')} maxLength={120} required autoFocus />
          </Field>
        ) : (
          <>
            <Field label="Nachname">
              <input value={c.lastName} onChange={setText('lastName')} maxLength={80} autoFocus />
            </Field>
            <Field label="Vorname">
              <input value={c.firstName} onChange={setText('firstName')} maxLength={80} />
            </Field>
            <Field label="Organisation / Firma">
              <input value={c.organization} onChange={setText('organization')} maxLength={120} />
            </Field>
          </>
        )}
        <Field label={org ? 'Ansprechpartner / Funktion' : 'Funktion'}>
          <input value={c.function} onChange={setText('function')} maxLength={80} />
        </Field>
        <Field label="E-Mail">
          <input type="email" value={c.email} onChange={setText('email')} maxLength={254} />
        </Field>
        <Field label="Anschrift">
          <input value={c.address} onChange={setText('address')} maxLength={200} />
        </Field>
      </div>

      <fieldset className="qual-picker">
        <legend>Telefon</legend>
        <ul className="simple-list">
          {c.phones.map((p, i) => (
            <li key={i} className="contact-phone">
              <input
                value={p.label}
                onChange={(e) => set({ phones: c.phones.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                placeholder="z. B. Mobil"
                aria-label="Bezeichnung"
                maxLength={40}
              />
              <input
                type="tel"
                value={p.number}
                onChange={(e) => set({ phones: c.phones.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)) })}
                placeholder="Nummer"
                aria-label="Telefonnummer"
                maxLength={40}
              />
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => set({ phones: c.phones.filter((_, j) => j !== i) })} aria-label="Nummer entfernen">
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
        {c.phones.length < MAX_CONTACT_PHONES && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ phones: [...c.phones, { label: '', number: '' }] })}>
            <Plus size={16} /> Nummer
          </button>
        )}
      </fieldset>

      <fieldset className="qual-picker">
        <legend>Kategorien</legend>
        {paths.length === 0 ? (
          <p className="muted">Noch keine Kategorien – links im Baum anlegen.</p>
        ) : (
          <ul className="simple-list">
            {paths.map((k) => (
              <li key={k.id}>
                <label className="check">
                  <input type="checkbox" checked={c.categoryIds.includes(k.id)} onChange={() => toggle(k.id)} /> {k.path}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <Field label="Notizen">
        <textarea value={c.notes} onChange={setText('notes')} maxLength={2000} rows={3} />
      </Field>
      {/* „Name fehlt“ zeigt schon der gesperrte Speichern-Knopf */}
      {!result.success && result.error.issues.some((i) => i.path[0] !== 'lastName') && <p className="tone-warn">{result.error.issues.find((i) => i.path[0] !== 'lastName')?.message}</p>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={pending || !result.success}>
          {pending ? 'Speichert …' : 'Speichern'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
