import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PackagePlus } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Card, EmptyState, Field, Loading } from '../../components/ui';
import { useRequestSettings } from '../../components/requests/requestParts';

/** Anforderungen: welche Rolle sie führt und die Wiedervorlagen bekommt. Nur Admins. */
export function RequestSettingsCard() {
  const toast = useToast();
  const { data } = useRequestSettings();
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const [roleId, setRoleId] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setRoleId(data.procurementRoleId);
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => api.saveRequestSettings({ procurementRoleId: roleId }),
    onSuccess: () => (setDirty(false), toast('success', 'Beschaffungsrolle gespeichert')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !roles) return <Loading />;

  return (
    <Card title="Anforderungen" icon={<PackagePlus size={18} />} className="span-2">
      <p className="muted">
        Die Beschaffungsrolle genehmigt und bestellt Materialanforderungen – je nach Einsatz selbst oder über den Stab – und bekommt zu jeder Wiedervorlage eine
        Aufgabe. Ohne Beschaffungsrolle, oder solange sie niemand übernommen hat, dürfen alle Anforderungen führen.
      </p>
      {roles.length === 0 ? (
        <EmptyState title="Noch keine Rollen">Rollen zuerst unter „Rollen im Einsatz“ anlegen.</EmptyState>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Beschaffungsrolle">
            <select
              value={roleId ?? ''}
              onChange={(e) => {
                setRoleId(e.target.value ? Number(e.target.value) : null);
                setDirty(true);
              }}
            >
              <option value="">Keine – alle führen Anforderungen</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
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
