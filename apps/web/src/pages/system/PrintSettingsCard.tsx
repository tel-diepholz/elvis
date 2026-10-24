import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { DOCUMENT_PLACEHOLDERS, PRINT_JOB_STATE_LABELS, printSettingsInputSchema, type PrintSettingsInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Toggle } from '../../components/ui';

/** Druckserver: Ablage der Drucke in der Dokumentverwaltung, Vorauswahl des Druckers, letzte Aufträge. Nur Admins. */
export function PrintSettingsCard() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['printing', 'system'], queryFn: api.printSettings });
  const { data: status } = useQuery({ queryKey: ['printing'], queryFn: api.printing });
  const [form, setForm] = useState<PrintSettingsInput | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setForm({ archive: data.settings.archive, folderPath: data.settings.folderPath, defaultPrinter: data.settings.defaultPrinter });
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => api.savePrintSettings(form!),
    onSuccess: () => (setDirty(false), toast('success', 'Druckeinstellungen gespeichert')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !form) return <Loading />;
  const change = (patch: Partial<PrintSettingsInput>) => (setForm({ ...form, ...patch }), setDirty(true));
  const valid = printSettingsInputSchema.safeParse(form);
  const printers = status?.printers ?? [];

  return (
    <Card title="Druckserver" icon={<Printer size={18} />} className="span-2">
      <p className="muted">
        Unter <em>Drucken</em> können alle Arbeitsplätze, auch ohne Anmeldung, PDFs auf den Druckern des Addons „Druckserver (CUPS)“ ausgeben.
        {!status?.available && ' Derzeit läuft kein Druckserver-Addon.'}
      </p>
      <Toggle label="Drucke im laufenden Einsatz ablegen" checked={form.archive} onChange={(v) => change({ archive: v })} />
      <div className="form-grid">
        <Field label="Ablageort im Einsatz" hint="Leer = oberste Ebene. Fehlende Ordner werden angelegt.">
          <input value={form.folderPath} onChange={(e) => change({ folderPath: e.target.value })} maxLength={200} placeholder="Drucke/{{datum.iso}}" disabled={!form.archive} />
        </Field>
        <Field label="Vorausgewählter Drucker">
          <select value={form.defaultPrinter ?? ''} onChange={(e) => change({ defaultPrinter: e.target.value || null })}>
            <option value="">erster bereiter Drucker</option>
            {form.defaultPrinter && !printers.some((p) => p.id === form.defaultPrinter) && <option value={form.defaultPrinter}>{form.defaultPrinter} (nicht erreichbar)</option>}
            {printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.info}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {form.archive && (
        <p className="muted">
          Platzhalter:{' '}
          {DOCUMENT_PLACEHOLDERS.filter((p) => p.inPath).map((p, i) => (
            <span key={p.key}>
              {i > 0 && ', '}
              <code title={p.label}>{`{{${p.key}}}`}</code>
            </span>
          ))}
        </p>
      )}
      {!valid.success && <p className="tone-alarm">{valid.error.issues[0]?.message}</p>}
      <div className="form-actions spread">
        <span className="muted">{data.settings.updatedAt ? `Zuletzt geändert ${fmtDateTime(data.settings.updatedAt)} von ${data.settings.updatedBy}` : 'Vorgaben'}</span>
        <span className="btn-row">
          <button className="btn" disabled={!dirty} onClick={() => setDirty(false)}>
            Verwerfen
          </button>
          <button className="btn btn-primary" disabled={!dirty || !valid.success || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>

      {data.jobs.length > 0 && (
        <>
          <h3 className="section-title">Letzte Druckaufträge</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Datei</th>
                  <th>Drucker</th>
                  <th>Von</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr key={j.ref}>
                    <td className="mono">{fmtDateTime(j.createdAt)}</td>
                    <td>
                      {j.filename}
                      {j.archivedPath && <span className="cell-sub">{j.archivedPath}</span>}
                    </td>
                    <td>
                      {j.printerName} <span className="cell-sub">{j.copies}×</span>
                    </td>
                    <td>{j.submittedBy}</td>
                    <td>
                      <Badge tone={j.state === 'completed' ? 'ok' : j.state === 'aborted' || j.state === 'canceled' ? 'alarm' : 'muted'}>{PRINT_JOB_STATE_LABELS[j.state]}</Badge>{' '}
                      {j.stateMessage && <span className="cell-sub">{j.stateMessage}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
