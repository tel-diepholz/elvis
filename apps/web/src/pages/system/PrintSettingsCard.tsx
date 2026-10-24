import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import {
  DOCUMENT_PLACEHOLDERS,
  GUEST_PRINT_MODES,
  GUEST_PRINT_RETENTION_HOURS,
  PRINT_JOB_STATE_LABELS,
  SIDES,
  printSettingsInputSchema,
  type GuestPrintMode,
  type GuestPrintSettings,
  type PrintSettingsInput,
  type Sides,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Segmented, Toggle } from '../../components/ui';

/** Druckserver: Ablage der Drucke, Vorauswahl des Druckers, Gastdrucker, letzte Aufträge. Nur Admins. */
export function PrintSettingsCard() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['printing', 'system'], queryFn: api.printSettings });
  const { data: status } = useQuery({ queryKey: ['printing'], queryFn: api.printing });
  const [form, setForm] = useState<PrintSettingsInput | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setForm({ archive: data.settings.archive, folderPath: data.settings.folderPath, defaultPrinter: data.settings.defaultPrinter, guest: data.settings.guest });
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => api.savePrintSettings(form!),
    onSuccess: () => (setDirty(false), toast('success', 'Druckeinstellungen gespeichert')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !form) return <Loading />;
  const change = (patch: Partial<PrintSettingsInput>) => (setForm({ ...form, ...patch }), setDirty(true));
  const changeGuest = (patch: Partial<GuestPrintSettings>) => change({ guest: { ...form.guest, ...patch } });
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

      <h3 className="section-title">Gastdrucker</h3>
      <p className="muted">
        Gäste im Gast-WLAN finden einen Drucker ohne App (iPhone/iPad per AirPrint, Android, Windows 10/11). Einschalten in den Optionen des
        Addons „Druckserver (CUPS)“.{' '}
        {status?.guest.available ? 'Der Gastdrucker des Addons ist verbunden.' : 'Derzeit meldet kein laufendes Addon einen Gastdrucker.'}
      </p>
      <Segmented<GuestPrintMode>
        label="Aufträge aus dem Gastnetz"
        value={form.guest.mode}
        onChange={(v) => changeGuest({ mode: v })}
        options={(Object.keys(GUEST_PRINT_MODES) as GuestPrintMode[]).map((k) => ({ value: k, label: GUEST_PRINT_MODES[k] }))}
      />
      {form.guest.mode !== 'off' && (
        <>
          <p className="muted">
            {form.guest.mode === 'direct'
              ? 'Jeder Auftrag wird sofort auf dem gewählten Drucker ausgegeben.'
              : `Aufträge warten unter „Drucken“ auf Freigabe (Anmeldung nötig) und werden nach ${GUEST_PRINT_RETENTION_HOURS} Stunden verworfen.`}{' '}
            Abgelegt wird wie bei jedem anderen Druck.
          </p>
          <div className="form-grid">
            <Field label="Höchstens Kopien je Auftrag">
              <input type="number" min={1} max={99} value={form.guest.maxCopies} onChange={(e) => changeGuest({ maxCopies: Number(e.target.value) })} />
            </Field>
            {form.guest.mode === 'direct' && (
              <>
                <Field label="Drucker">
                  <select value={form.guest.printer ?? ''} onChange={(e) => changeGuest({ printer: e.target.value || null })}>
                    <option value="">bitte wählen</option>
                    {form.guest.printer && !printers.some((p) => p.id === form.guest.printer) && <option value={form.guest.printer}>{form.guest.printer} (nicht erreichbar)</option>}
                    {printers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.info}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Farbe">
                  <select value={form.guest.color} onChange={(e) => changeGuest({ color: e.target.value as 'color' | 'monochrome' })}>
                    <option value="monochrome">Schwarzweiß</option>
                    <option value="color">Farbe (wenn der Drucker kann)</option>
                  </select>
                </Field>
                <Field label="Seiten">
                  <select value={form.guest.sides} onChange={(e) => changeGuest({ sides: e.target.value as Sides })}>
                    {(Object.keys(SIDES) as Sides[]).map((k) => (
                      <option key={k} value={k}>
                        {SIDES[k]}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>
          <Toggle label="Nur annehmen, solange das Gast-WLAN läuft (Einsatz eröffnet)" checked={form.guest.onlyWithGuestWifi} onChange={(v) => changeGuest({ onlyWithGuestWifi: v })} />
        </>
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
