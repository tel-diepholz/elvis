import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { INCIDENT_KINDS, INCIDENT_KIND_LABELS, kindHasSite, type Incident, type IncidentKind, type NewIncident } from '@elvis/shared';
import { api } from '../../lib/api';
import { Field, Segmented } from '../../components/ui';

const KIND_HINT: Record<IncidentKind, string> = {
  area: 'Viele Einsätze in einem Gebiet, z. B. Unwetter. Die Beschaffungsrolle genehmigt und beschafft selbst und führt den Status.',
  rescue: 'Einzelne Einsatzstelle mit Stichwort und Einsatzort. Die Beschaffungsrolle genehmigt und beschafft selbst und führt den Status.',
  staff: 'Führung durch einen Stab. Die Beschaffungsrolle sendet Anforderungen per Ausgangsmeldung an den Stab und trägt dessen Rückmeldungen nach.',
};

export function useIncidentSettings() {
  return useQuery({ queryKey: ['settings', 'incident'], queryFn: api.incidentSettings });
}

/** Lage anlegen/bearbeiten: Bezeichnung und Art; Stichwort/Einsatzort nur bei Brand/TH, Stab-Empfänger nur bei Stab */
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
  const [kind, setKind] = useState<IncidentKind>(initial?.kind ?? 'rescue');
  const { data: settings } = useIncidentSettings();
  const keywords = settings?.keywords ?? [];
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.title.trim()) onSubmit({ ...form, kind });
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Bezeichnung *">
        <input value={form.title} onChange={set('title')} placeholder="z. B. Orkan Kyrill" maxLength={200} required autoFocus />
      </Field>
      <div className="field">
        <span className="field-label">Art *</span>
        <Segmented<IncidentKind> label="Art der Lage" value={kind} onChange={setKind} options={INCIDENT_KINDS.map((k) => ({ value: k, label: INCIDENT_KIND_LABELS[k] }))} />
        <span className="field-hint">{KIND_HINT[kind]}</span>
      </div>
      <div className="form-grid">
        {kindHasSite(kind) && (
          <>
            <Field label="Einsatzstichwort" hint={keywords.length ? undefined : 'Noch keine Stichworte vorgegeben – Einstellungen → Lage → Einsatzstichworte'}>
              <select value={form.keyword} onChange={set('keyword')} disabled={!keywords.length && !form.keyword}>
                <option value="">– kein Stichwort –</option>
                {keywords.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                {/* Bestehender Wert, der nicht (mehr) vorgegeben ist, bleibt wählbar */}
                {form.keyword && !keywords.includes(form.keyword) && <option value={form.keyword}>{form.keyword}</option>}
              </select>
            </Field>
            <Field label="Einsatzort">
              <input value={form.location} onChange={set('location')} placeholder="Straße, Ort" maxLength={200} />
            </Field>
          </>
        )}
        <Field label="Einsatzleiter">
          <input value={form.leader} onChange={set('leader')} placeholder="Name / Funktion" maxLength={100} />
        </Field>
        {kind === 'staff' && (
          <Field label="Stab (Empfänger)" hint="Vorgabe für die Ausgangsmeldung, z. B. Stab HVB oder TEL">
            <input value={form.procurementStaff} onChange={set('procurementStaff')} placeholder="z. B. Stab HVB" maxLength={120} />
          </Field>
        )}
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !form.title.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
