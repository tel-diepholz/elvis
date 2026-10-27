import { useState, type FormEvent } from 'react';
import { REQUEST_MATERIAL_MAX, requestInputSchema, type MaterialRequest, type MessagePartyInput, type RequestInput, type RequestPatch } from '@elvis/shared';
import { Field, Segmented } from '../ui';
import { UnitSearchInput } from '../messages/UnitSearchInput';
import { fromLocalInput, toLocalInput } from '../tasks/TaskForm';
import { useFollowUp, type NeedMode } from './requestParts';

/** Vorbelegung, z. B. aus einer Meldung */
export interface RequestPrefill {
  unit?: MessagePartyInput;
  material?: string;
  sourceMessageId?: number;
}

/** Kraft, Material und Bedarf – gemeinsam für Anlegen und Bearbeiten */
function useRequestFields(incidentId: number, initial: { unit: MessagePartyInput; material: string; neededBy: string | null }) {
  const [unit, setUnit] = useState<MessagePartyInput>(initial.unit);
  const [material, setMaterial] = useState(initial.material);
  const [need, setNeed] = useState<NeedMode>(initial.neededBy ? 'at' : 'now');
  const [neededAt, setNeededAt] = useState(initial.neededBy ? toLocalInput(initial.neededBy) : '');
  const fields = (
    <>
      <Field label="Anfordernde Kraft *" hint="Kraft aus der Kräfteverwaltung oder Freitext">
        <UnitSearchInput incidentId={incidentId} value={unit} onChange={setUnit} placeholder="z. B. 1. Zug" autoFocus={!initial.unit.text} />
      </Field>
      <Field label={`Material * (${material.length}/${REQUEST_MATERIAL_MAX})`} hint="Was, wie viel, wohin">
        <textarea value={material} onChange={(e) => setMaterial(e.target.value)} rows={4} maxLength={REQUEST_MATERIAL_MAX} placeholder={'z. B. 200 Sandsäcke, 2 Paletten Sand\nan Einsatzabschnitt Nord'} />
      </Field>
      <div className="field">
        <span className="field-label">Bedarf</span>
        <Segmented<NeedMode>
          label="Bedarf"
          value={need}
          onChange={setNeed}
          options={[
            { value: 'now', label: 'Sofort' },
            { value: 'at', label: 'Bis Zeitpunkt' },
          ]}
        />
        {need === 'at' && <input type="datetime-local" value={neededAt} onChange={(e) => setNeededAt(e.target.value)} required />}
      </div>
    </>
  );
  return { fields, values: () => ({ unit, material, neededBy: need === 'at' ? fromLocalInput(neededAt) : null }) };
}

/** Neue Anforderung, mit Pflicht-Wiedervorlage für die Beschaffungsrolle */
export function RequestForm({ incidentId, prefill, pending, onSubmit }: { incidentId: number; prefill?: RequestPrefill; pending: boolean; onSubmit: (input: RequestInput) => void }) {
  const { fields, values } = useRequestFields(incidentId, { unit: prefill?.unit ?? { text: '', unitId: null }, material: prefill?.material ?? '', neededBy: null });
  const followUp = useFollowUp();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const followUpAt = followUp.value();
    if (!followUpAt) return setError('Wiedervorlage fehlt');
    const input: RequestInput = { ...values(), followUpAt, sourceMessageId: prefill?.sourceMessageId ?? null };
    const parsed = requestInputSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Eingaben prüfen');
    setError(null);
    onSubmit(input);
  };

  return (
    <form className="form" onSubmit={submit}>
      {fields}
      {followUp.field}
      <span className="field-hint">Zur Wiedervorlage bekommt die Beschaffungsrolle eine Aufgabe.</span>
      {error && <p className="hint tone-alarm">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Anforderung anlegen
        </button>
      </div>
    </form>
  );
}

/** Kraft, Material und Bedarf einer bestehenden Anforderung korrigieren */
export function RequestEditForm({ incidentId, request: r, pending, onSubmit }: { incidentId: number; request: MaterialRequest; pending: boolean; onSubmit: (input: RequestPatch) => void }) {
  const { fields, values } = useRequestFields(incidentId, { unit: { text: r.unit, unitId: r.unitId }, material: r.material, neededBy: r.neededBy });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(values());
      }}
    >
      {fields}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Speichern
        </button>
      </div>
    </form>
  );
}
