import { useState, type FormEvent } from 'react';
import { PROCUREMENT_MODE_LABELS, type Incident, type NewIncident, type ProcurementMode } from '@elvis/shared';
import { Field, Segmented } from '../../components/ui';

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
    procurementStaff: initial?.procurementStaff ?? '',
  });
  const [procurementMode, setProcurementMode] = useState<ProcurementMode>(initial?.procurementMode ?? 'self');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.title.trim()) onSubmit({ ...form, procurementMode });
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
      <div className="field">
        <span className="field-label">Beschaffung von Anforderungen</span>
        <Segmented<ProcurementMode>
          label="Beschaffung"
          value={procurementMode}
          onChange={setProcurementMode}
          options={(Object.keys(PROCUREMENT_MODE_LABELS) as ProcurementMode[]).map((m) => ({ value: m, label: PROCUREMENT_MODE_LABELS[m] }))}
        />
        <span className="field-hint">
          {procurementMode === 'self'
            ? 'Die Beschaffungsrolle genehmigt und beschafft selbst und führt den Status.'
            : 'Die Beschaffungsrolle sendet Anforderungen per Ausgangsmeldung an den Stab und trägt dessen Rückmeldungen nach.'}
        </span>
      </div>
      {procurementMode === 'staff' && (
        <Field label="Stab (Empfänger)" hint="Vorgabe für die Ausgangsmeldung, z. B. Stab HVB oder TEL">
          <input value={form.procurementStaff} onChange={set('procurementStaff')} placeholder="z. B. Stab HVB" maxLength={120} />
        </Field>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !form.title.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
