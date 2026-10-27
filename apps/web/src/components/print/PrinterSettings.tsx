import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderInput } from 'lucide-react';
import { SIDES, mediaLabel, parsePageRanges, type PrintOptionsInput, type PrintStatus, type PrinterInfo, type Sides } from '@elvis/shared';
import { api } from '../../lib/api';
import { Badge, Field, Segmented, Toggle, type Tone } from '../ui';

export type PrintForm = Required<PrintOptionsInput>;

export const DEFAULT_PRINT_FORM: PrintForm = {
  printerId: '',
  copies: 1,
  sides: 'one-sided',
  color: 'color',
  media: '',
  orientation: 'auto',
  pageRanges: '',
  numberUp: 1,
  fitToPage: true,
};

export const printerTone = (p: PrinterInfo): Tone => (!p.accepting || p.state === 'stopped' ? 'alarm' : p.state === 'processing' ? 'info' : 'ok');
export const printerStateLabel = (p: PrinterInfo) => (!p.accepting ? 'nimmt keine Aufträge an' : p.state === 'stopped' ? 'gestoppt' : p.state === 'processing' ? 'druckt' : 'bereit');

/** Drucker der Druckserver-Addons; aktualisiert sich über das Live-Thema „printing“ und alle 10 s (Druckerstatus). */
export function usePrintStatus(enabled = true) {
  return useQuery({ queryKey: ['printing'], queryFn: api.printing, refetchInterval: 10_000, enabled });
}

/** Erzeugte Datei im Browser herunterladen */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Papierformat des Druckers zu A4/A3/…, falls er es kennt */
export function mediaFor(printer: PrinterInfo | null, paper: string): string {
  return printer?.media.find((m) => m.startsWith(`iso_${paper.toLowerCase()}_`)) ?? '';
}

/**
 * Formularzustand der Druckeinstellungen: wählt den vorgegebenen bzw. ersten bereiten Drucker vor und beschränkt die
 * Einstellungen auf das, was der gewählte Drucker kann.
 */
export function usePrintForm(status: PrintStatus | undefined, initial: Partial<PrintForm> = {}) {
  const [form, setForm] = useState<PrintForm>({ ...DEFAULT_PRINT_FORM, ...initial });
  const printers = status?.printers ?? [];
  const printer = printers.find((p) => p.id === form.printerId) ?? null;

  useEffect(() => {
    if (!status || printers.some((p) => p.id === form.printerId)) return;
    const id = status.defaultPrinter ?? printers.find((p) => p.accepting)?.id ?? printers[0]?.id ?? '';
    if (id) setForm((f) => ({ ...f, printerId: id }));
  }, [status, printers, form.printerId]);

  useEffect(() => {
    if (!printer) return;
    setForm((f) => {
      const next: PrintForm = {
        ...f,
        color: printer.color ? f.color : 'monochrome',
        sides: printer.duplex ? f.sides : 'one-sided',
        media: f.media && printer.media.includes(f.media) ? f.media : '',
        numberUp: !printer.numberUp.length || printer.numberUp.includes(Number(f.numberUp)) ? f.numberUp : 1,
      };
      return JSON.stringify(next) === JSON.stringify(f) ? f : next;
    });
  }, [printer]);

  const valid = !!printer && printer.accepting && parsePageRanges(form.pageRanges) !== null;
  return { form, setForm, printer, valid };
}

/** Hinweis, ob und wo der Druck in der Dokumentverwaltung landet */
export function ArchiveHint({ status }: { status: PrintStatus }) {
  const a = status.archive;
  if (!a.enabled) return null;
  return (
    <p className="muted print-archive">
      <FolderInput size={16} />{' '}
      {a.incident ? `Der Druck wird im Einsatz „${a.incident.title}“ unter „${a.path || 'Einsatz'}“ abgelegt.` : 'Kein Einsatz eröffnet – der Druck wird nicht abgelegt.'}
    </p>
  );
}

/**
 * Drucker und gängige Einstellungen. `fixedLayout` blendet Papier, Ausrichtung, Seiten und Seiten pro Blatt aus –
 * etwa für die Lagekarte, deren PDF Format und Ausrichtung schon festlegt.
 */
export function PrinterSettings({
  status,
  form,
  onChange,
  fixedLayout = false,
}: {
  status: PrintStatus;
  form: PrintForm;
  onChange: (f: PrintForm) => void;
  fixedLayout?: boolean;
}) {
  const printers = status.printers;
  const printer = printers.find((p) => p.id === form.printerId) ?? null;
  const set = <K extends keyof PrintForm>(k: K, v: PrintForm[K]) => onChange({ ...form, [k]: v });
  const ranges = parsePageRanges(form.pageRanges);
  const manyServers = new Set(printers.map((p) => p.serverName)).size > 1;

  return (
    <div className="print-form">
      {status.errors.map((e) => (
        <p key={e} className="tone-alarm">
          {e}
        </p>
      ))}
      <Field label="Drucker" hint={printer ? [printer.location, printer.stateMessage].filter(Boolean).join(' · ') || undefined : undefined}>
        <select value={form.printerId} onChange={(e) => set('printerId', e.target.value)}>
          {printers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.info} – {printerStateLabel(p)}
              {manyServers ? ` (${p.serverName})` : ''}
            </option>
          ))}
        </select>
      </Field>
      {printer && (
        <div>
          <Badge tone={printerTone(printer)}>{printerStateLabel(printer)}</Badge> {printer.color ? <Badge tone="info">Farbe</Badge> : <Badge>schwarzweiß</Badge>}{' '}
          {printer.duplex && <Badge>beidseitig</Badge>}
        </div>
      )}
      <div className="form-grid">
        <Field label="Kopien">
          <input type="number" min={1} max={99} value={form.copies} onChange={(e) => set('copies', Math.max(1, Math.min(99, Number(e.target.value) || 1)))} />
        </Field>
        {!fixedLayout && (
          <Field label="Papier">
            <select value={form.media} onChange={(e) => set('media', e.target.value)}>
              <option value="">Vorgabe{printer?.mediaDefault ? ` (${mediaLabel(printer.mediaDefault)})` : ''}</option>
              {printer?.media.map((m) => (
                <option key={m} value={m}>
                  {mediaLabel(m)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {!fixedLayout && (
        <Field label="Seitenbereich" hint={ranges === null ? 'z. B. „1-3, 5, 8-“' : 'leer = alle Seiten'}>
          <input value={form.pageRanges} onChange={(e) => set('pageRanges', e.target.value)} placeholder="alle" className={ranges === null ? 'invalid' : ''} />
        </Field>
      )}
      <Field label="Beidseitig">
        <select value={form.sides} onChange={(e) => set('sides', e.target.value as Sides)} disabled={!printer?.duplex} aria-label="Einseitig oder beidseitig">
          {Object.entries(SIDES).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Segmented
        label="Farbe"
        value={form.color}
        onChange={(v) => set('color', v)}
        options={[
          { value: 'color', label: 'Farbe' },
          { value: 'monochrome', label: 'Graustufen' },
        ]}
        disabled={!printer?.color}
      />
      {!fixedLayout && (
        <>
          <Segmented
            label="Ausrichtung"
            value={form.orientation}
            onChange={(v) => set('orientation', v)}
            options={[
              { value: 'auto', label: 'Automatisch' },
              { value: 'portrait', label: 'Hoch' },
              { value: 'landscape', label: 'Quer' },
            ]}
          />
          <Field label="Seiten pro Blatt">
            <select value={form.numberUp} onChange={(e) => set('numberUp', Number(e.target.value))}>
              {(printer?.numberUp.length ? printer.numberUp : [1, 2, 4])
                .filter((n) => [1, 2, 4, 6, 9, 16].includes(n))
                .map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
            </select>
          </Field>
        </>
      )}
      <Toggle label="An Papiergröße anpassen" checked={form.fitToPage} onChange={(v) => set('fitToPage', v)} />
      <ArchiveHint status={status} />
    </div>
  );
}
