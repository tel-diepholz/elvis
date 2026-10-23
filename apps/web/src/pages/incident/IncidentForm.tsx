import { useState, type FormEvent } from 'react';
import type { Incident, NewIncident } from '@elvis/shared';
import { Field } from '../../components/ui';

export function IncidentForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
}: {
  initial?: Incident;
  submitLabel: string;
  pending: boolean;
  onSubmit: (input: NewIncident) => void;
}) {
  const [form, setForm] = useState({
    keyword: initial?.keyword ?? '',
    title: initial?.title ?? '',
    location: initial?.location ?? '',
    leader: initial?.leader ?? '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.title.trim()) onSubmit(form);
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Einsatzstichwort">
          <input value={form.keyword} onChange={set('keyword')} placeholder="z. B. B3, TH2, ABC1" maxLength={40} />
        </Field>
        <Field label="Bezeichnung *">
          <input value={form.title} onChange={set('title')} placeholder="z. B. Brand Lagerhalle" maxLength={200} required autoFocus />
        </Field>
        <Field label="Einsatzort">
          <input value={form.location} onChange={set('location')} placeholder="Straße, Ort" maxLength={200} />
        </Field>
        <Field label="Einsatzleiter">
          <input value={form.leader} onChange={set('leader')} placeholder="Name / Funktion" maxLength={100} />
        </Field>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !form.title.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
