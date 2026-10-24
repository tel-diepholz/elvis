import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useMutation, useQueries } from '@tanstack/react-query';
import { FileText, Printer, Upload, X } from 'lucide-react';
import { PRINT_JOB_DONE, PRINT_JOB_STATE_LABELS, type PrintJob } from '@elvis/shared';
import { PrinterSettings, usePrintForm, usePrintStatus } from '../components/print/PrinterSettings';
import { api } from '../lib/api';
import { fmtTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Card, EmptyState, Loading, PageHeader, type Tone } from '../components/ui';

const MAX_BYTES = 50 * 1024 * 1024;

const jobTone = (j: PrintJob): Tone =>
  j.state === 'completed' ? 'ok' : j.state === 'aborted' || j.state === 'canceled' || j.state === 'stopped' ? 'alarm' : j.state === 'unknown' ? 'muted' : 'info';

const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

/** PDF hochladen und auf einem Drucker der Druckserver-Addons drucken – auch ohne Anmeldung. */
export function PrintPage() {
  const toast = useToast();
  const { data: status, isLoading } = usePrintStatus();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { form, setForm, valid } = usePrintForm(status);
  const [jobs, setJobs] = useState<PrintJob[]>([]);

  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const choose = (f: File | undefined) => {
    if (!f) return;
    if (!isPdf(f)) return toast('error', 'Bitte eine PDF-Datei wählen');
    if (f.size > MAX_BYTES) return toast('error', 'Die Datei ist größer als 50 MB');
    setFile(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files[0]);
  };

  const print = useMutation({
    mutationFn: () => api.printPdf(file!, form),
    onSuccess: (job) => {
      setJobs((list) => [job, ...list].slice(0, 10));
      toast('success', job.archivedPath ? `An ${job.printerName} gesendet und unter „${job.archivedPath}“ abgelegt` : `An ${job.printerName} gesendet`);
    },
    onError: (e) => toast('error', e.message),
  });

  // Status offener Aufträge nachfragen, bis sie abgeschlossen sind
  const live = useQueries({
    queries: jobs.map((j) => ({
      queryKey: ['printing', 'job', j.ref],
      queryFn: () => api.printJob(j.ref),
      initialData: j,
      refetchInterval: (q: { state: { data?: PrintJob } }) => (q.state.data && (PRINT_JOB_DONE.includes(q.state.data.state) || q.state.data.state === 'unknown') ? false : 2000),
    })),
  });


  if (isLoading || !status) return <Loading />;

  return (
    <>
      <PageHeader title="Drucken" subtitle="PDF hochladen und auf einem Drucker im Fahrzeug ausgeben" />
      {!status.available ? (
        <EmptyState icon={<Printer size={40} />} title="Kein Druckserver verfügbar">
          Ein Admin muss das Addon „Druckserver (CUPS)“ installieren und dort die Drucker einrichten.
        </EmptyState>
      ) : (
        <div className="grid">
          <Card title="Datei" icon={<FileText size={18} />} className="span-2" actions={file && (
            <button className="btn btn-ghost btn-sm" onClick={() => setFile(null)}>
              <X size={16} /> Andere Datei
            </button>
          )}>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ''))} />
            {file && preview ? (
              <div className="pdf-preview">
                <div className="print-file">
                  <strong>{file.name}</strong>
                  <span className="muted">{(file.size / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB</span>
                </div>
                <iframe src={preview} title="Vorschau" />
              </div>
            ) : (
              <div
                className={`dropzone print-drop ${dragging ? 'dragging' : ''}`}
                onDragOver={(e) => (e.preventDefault(), setDragging(true))}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <Upload size={36} />
                <p>PDF hierher ziehen oder auswählen (max. 50 MB)</p>
                <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
                  <Upload size={16} /> PDF auswählen
                </button>
              </div>
            )}
          </Card>

          <Card title="Druckeinstellungen" icon={<Printer size={18} />}>
            {!status.printers.length ? (
              <>
                {status.errors.map((e) => (
                  <p key={e} className="tone-alarm">
                    {e}
                  </p>
                ))}
                <p className="muted">Auf dem Druckserver ist noch kein Drucker eingerichtet.</p>
              </>
            ) : (
              <>
                <PrinterSettings status={status} form={form} onChange={setForm} />
                <button className="btn btn-primary print-submit" disabled={!file || !valid || print.isPending} onClick={() => print.mutate()}>
                  <Printer size={16} /> {print.isPending ? 'Wird gesendet …' : 'Drucken'}
                </button>
              </>
            )}
          </Card>

          {live.length > 0 && (
            <Card title="Meine Druckaufträge" className="span-3">
              <ul className="print-jobs">
                {live.map(({ data: j }) =>
                  j ? (
                    <li key={j.ref}>
                      <span className="mono">{fmtTime(j.createdAt)}</span>
                      <span className="print-job-name">
                        {j.filename}
                        <span className="cell-sub">
                          {j.printerName} · {j.copies} {j.copies === 1 ? 'Kopie' : 'Kopien'}
                          {j.archivedPath && ` · abgelegt unter „${j.archivedPath}“`}
                        </span>
                      </span>
                      <span>
                        <Badge tone={jobTone(j)}>{PRINT_JOB_STATE_LABELS[j.state]}</Badge> {j.stateMessage && <span className="cell-sub">{j.stateMessage}</span>}
                      </span>
                    </li>
                  ) : null,
                )}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
