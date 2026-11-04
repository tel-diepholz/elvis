import { useMutation } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { downloadBlob } from './print/PrinterSettings';

/** Einsatzbericht als PDF herunterladen (laufender Einsatz: Zwischenbericht) */
export function ReportButton({ incidentId, label = 'Einsatzbericht (PDF)' }: { incidentId: number; label?: string }) {
  const toast = useToast();
  const report = useMutation({
    mutationFn: () => api.incidentReport(incidentId),
    onSuccess: ({ pdf, filename }) => downloadBlob(pdf, filename),
    onError: (e) => toast('error', e.message),
  });
  return (
    <button className="btn" onClick={() => report.mutate()} disabled={report.isPending} title="Alle erfassten Daten, Lagekarte und Dokumente in einem PDF">
      <FileDown size={16} /> {report.isPending ? 'Bericht wird erstellt …' : label}
    </button>
  );
}
