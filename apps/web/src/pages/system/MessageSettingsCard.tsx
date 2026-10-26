import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import type { MessageSettingsInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Card, EmptyState, Loading } from '../../components/ui';

type Form = { radioRoleIds: number[]; dispatcherRoleIds: number[]; copyInRoleIds: number[]; copyOutRoleIds: number[] };

/** Meldungen: welche Rollen Fernmelder und welche Dispatcher sind. Nur Admins. */
export function MessageSettingsCard() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['messages', 'system'], queryFn: api.messageSettings });
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const [form, setForm] = useState<Form | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setForm({ radioRoleIds: data.radioRoleIds, dispatcherRoleIds: data.dispatcherRoleIds, copyInRoleIds: data.copyInRoleIds, copyOutRoleIds: data.copyOutRoleIds });
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: (input: MessageSettingsInput) => api.saveMessageSettings(input),
    onSuccess: () => (setDirty(false), toast('success', 'Einstellungen für Meldungen gespeichert')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !form || !roles) return <Loading />;

  // Eine Rolle ist entweder Fernmelder oder Dispatcher; Kopien sind unabhängig davon
  const EXCLUSIVE: Partial<Record<keyof Form, keyof Form>> = { radioRoleIds: 'dispatcherRoleIds', dispatcherRoleIds: 'radioRoleIds' };
  const toggle = (key: keyof Form, id: number, on: boolean) => {
    const next = { ...form, [key]: on ? [...form[key], id] : form[key].filter((x) => x !== id) };
    const other = EXCLUSIVE[key];
    if (other && on) next[other] = form[other].filter((x) => x !== id);
    setForm(next);
    setDirty(true);
  };

  const group = (key: keyof Form, label: string, hint: string) => (
    <fieldset className="field">
      <legend className="field-label">{label}</legend>
      <div className="checkbox-list">
        {roles.map((r) => (
          <label key={r.id} className="checkbox">
            <input type="checkbox" checked={form[key].includes(r.id)} onChange={(e) => toggle(key, r.id, e.target.checked)} />
            {r.name}
          </label>
        ))}
      </div>
      <span className="field-hint">{hint}</span>
    </fieldset>
  );

  return (
    <Card title="Meldungen" icon={<Mail size={18} />} className="span-2">
      <p className="muted">
        Rollen mit <em>Meldung</em> schreiben Ausgangsmeldungen an Kräfte. Fernmelder werden benachrichtigt, übernehmen und übermitteln sie und erfassen
        Eingangsmeldungen für den Stab. Ist ein Dispatcher angemeldet, verteilt er die Eingangsmeldungen an die Zielrollen.
      </p>
      {roles.length === 0 ? (
        <EmptyState title="Noch keine Rollen">Rollen zuerst unter „Rollen im Einsatz“ anlegen.</EmptyState>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form);
          }}
        >
          {group('radioRoleIds', 'Fernmelder', 'Werden bei neuen Ausgangsmeldungen benachrichtigt')}
          {group('dispatcherRoleIds', 'Dispatcher', 'Optional – ohne angemeldeten Dispatcher wählt der Fernmelder die Zielrolle selbst')}
          {group('copyInRoleIds', 'Alle Eingangsmeldungen in Kopie', 'z. B. S2 für ein vollständiges Lagebild – das Lesen der Kopie gilt nicht für die Zielrolle')}
          {group('copyOutRoleIds', 'Alle Ausgangsmeldungen in Kopie', 'Die Absenderrolle selbst bekommt keine Kopie ihrer eigenen Meldung')}
          <div className="form-actions spread">
            <span className="cell-sub">{data.updatedAt && `Zuletzt geändert ${fmtDateTime(data.updatedAt)} von ${data.updatedBy}`}</span>
            <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>
              Speichern
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}
