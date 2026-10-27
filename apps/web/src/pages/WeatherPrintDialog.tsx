import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FileDown, Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { PrinterSettings, downloadBlob, mediaFor, usePrintForm, usePrintStatus } from '../components/print/PrinterSettings';
import { Field, Segmented } from '../components/ui';

/** Wetterbericht (A4) an einen Drucker der Druckserver-Addons schicken oder als PDF herunterladen */
export function WeatherPrintDialog({ position, onDone }: { position: { lat: number; lon: number }; onDone: () => void }) {
  const toast = useToast();
  const { data: printStatus } = usePrintStatus();
  const hasPrinters = !!printStatus?.printers.length;
  const [target, setTarget] = useState<'pdf' | 'printer' | null>(null);
  const output = target ?? (hasPrinters ? 'printer' : 'pdf');
  const { form, setForm, printer, valid: printerValid } = usePrintForm(printStatus);

  const print = useMutation({
    mutationFn: async () => {
      const report = await api.printWeather(position);
      if (output === 'pdf') return { ...report, job: null };
      const file = new File([report.pdf], report.filename, { type: 'application/pdf' });
      const job = await api.printPdf(file, { ...form, media: mediaFor(printer, 'A4'), orientation: 'auto', pageRanges: '', numberUp: 1 });
      return { ...report, job };
    },
    onSuccess: ({ pdf, filename, job }) => {
      if (!job) downloadBlob(pdf, filename);
      toast('success', job ? `Wetterbericht an ${job.printerName} gesendet${job.archivedPath ? ` und unter „${job.archivedPath}“ abgelegt` : ''}` : 'Wetterbericht als PDF erstellt');
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });

  return (
    <div className="stack">
      <p className="muted">Amtliche Warnungen, Messwerte der Wetterstation sowie Prognose für 24 Stunden und 7 Tage auf A4.</p>
      {hasPrinters && (
        <Field label="Ausgabe">
          <Segmented
            label="Ausgabe"
            value={output}
            onChange={setTarget}
            options={[
              { value: 'printer', label: 'Drucker' },
              { value: 'pdf', label: 'PDF herunterladen' },
            ]}
          />
        </Field>
      )}
      {output === 'printer' && printStatus && <PrinterSettings status={printStatus} form={form} onChange={setForm} fixedLayout />}
      {output === 'printer' ? (
        <button className="btn btn-primary btn-lg" disabled={print.isPending || !printerValid} onClick={() => print.mutate()}>
          <Printer size={18} /> {print.isPending ? 'Wird gedruckt …' : 'Drucken'}
        </button>
      ) : (
        <button className="btn btn-primary btn-lg" disabled={print.isPending} onClick={() => print.mutate()}>
          <FileDown size={18} /> {print.isPending ? 'PDF wird erstellt …' : 'PDF erzeugen'}
        </button>
      )}
    </div>
  );
}
