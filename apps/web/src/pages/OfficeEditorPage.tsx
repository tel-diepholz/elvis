import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, ExternalLink, Printer } from 'lucide-react';
import type { OfficeSession } from '@elvis/shared';
import { PrinterSettings, usePrintForm, usePrintStatus } from '../components/print/PrinterSettings';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { Badge, EmptyState, Loading, Modal, PageHeader } from '../components/ui';

/**
 * Drucken aus Collabora: Das PDF liegt auf dem Office-Server; ELVIS lädt es dort und schickt es an den Druckserver.
 * Ohne Drucker bleibt das Öffnen im Browser (Druck über den Browser).
 */
function OfficePrintDialog({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
  const toast = useToast();
  const { data: status, isLoading } = usePrintStatus();
  const { form, setForm, valid } = usePrintForm(status);
  const print = useMutation({
    mutationFn: () => api.printOffice(url, filename, form),
    onSuccess: (job) => {
      toast('success', job.archivedPath ? `An ${job.printerName} gesendet und unter „${job.archivedPath}“ abgelegt` : `An ${job.printerName} gesendet`);
      onClose();
    },
    onError: (e) => toast('error', e.message),
  });
  const hasPrinters = !!status?.printers.length;

  return (
    <Modal
      open
      title={`Drucken: ${filename}`}
      onClose={onClose}
    >
      {isLoading || !status ? (
        <Loading />
      ) : hasPrinters ? (
        <PrinterSettings status={status} form={form} onChange={setForm} />
      ) : (
        <p className="muted">{status.available ? 'Auf dem Druckserver ist kein Drucker eingerichtet.' : 'Kein Druckserver verfügbar (Addon „Druckserver (CUPS)“).'} Das PDF lässt sich im Browser öffnen und dort drucken.</p>
      )}
      <div className="form-actions">
        <div className="btn-row">
          <a className="btn" href={url} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> PDF im Browser öffnen
          </a>
          {hasPrinters && (
            <button className="btn btn-primary" disabled={!valid || print.isPending} onClick={() => print.mutate()}>
              <Printer size={16} /> {print.isPending ? 'Wird gesendet …' : 'Drucken'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Collabora Online im iframe. Nach WOPI wird das Zugriffstoken per POST-Formular übergeben (nicht in der URL).
 * Mehrere Bearbeiter derselben Datei landen automatisch in derselben Sitzung des Office-Servers.
 */
function OfficeFrame({ session, onClose }: { session: OfficeSession; onClose: () => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [printUrl, setPrintUrl] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const officeOrigin = new URL(session.actionUrl).origin;

  useEffect(() => formRef.current?.submit(), [session]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== officeOrigin || typeof e.data !== 'string') return;
      let msg: { MessageId?: string; Values?: { Status?: string; Type?: string; URL?: string } };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.MessageId === 'App_LoadingStatus' && msg.Values?.Status === 'Frame_Ready') {
        frameRef.current?.contentWindow?.postMessage(JSON.stringify({ MessageId: 'Host_PostmessageReady', SendTime: Date.now() }), officeOrigin);
      }
      if (msg.MessageId === 'UI_Close') onClose();
      // DownloadAsPostMessage (CheckFileInfo): Collabora überlässt Drucken, Export und Präsentation der Einbettung
      if (msg.MessageId === 'Download_As' && msg.Values?.URL) {
        const url = new URL(msg.Values.URL, officeOrigin).href;
        if (msg.Values.Type === 'print') setPrintUrl(url);
        else if (msg.Values.Type === 'slideshow') window.open(url, '_blank', 'noopener');
        else {
          const a = document.createElement('a');
          a.href = url;
          a.download = '';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [officeOrigin, onClose]);

  return (
    <>
      <form ref={formRef} action={session.actionUrl} method="post" target="office-frame" hidden>
        <input type="hidden" name="access_token" value={session.accessToken} />
        <input type="hidden" name="access_token_ttl" value={session.accessTokenTtl} />
      </form>
      <iframe ref={frameRef} name="office-frame" title="Dokument bearbeiten" className="office-frame" allow="clipboard-read *; clipboard-write *; fullscreen" />
      {printUrl && <OfficePrintDialog url={printUrl} filename={session.filename} onClose={() => setPrintUrl(null)} />}
    </>
  );
}

function OfficeEditor({ title: fallbackTitle, fixedTitle, subtitle, start, downloadUrl, queryKey }: { title: string; fixedTitle?: boolean; subtitle?: string; start: () => Promise<OfficeSession>; downloadUrl: string; queryKey: unknown[] }) {
  const navigate = useNavigate();
  // Sitzung nur einmal je Aufruf holen – kein erneutes Laden bei Live-Aktualisierungen
  const { data: session, error, isLoading } = useQuery({ queryKey: ['office-session', ...queryKey], queryFn: start, gcTime: 0, staleTime: Infinity, retry: false });
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/einsatz/dokumente'));

  return (
    <div className="office-page">
      <PageHeader
        title={fixedTitle ? fallbackTitle : (session?.filename ?? fallbackTitle)}
        subtitle={subtitle}
        actions={
          <div className="btn-row">
            {session?.readOnly && <Badge tone="muted">nur lesen</Badge>}
            <a className="btn btn-sm" href={downloadUrl}>
              <Download size={16} /> Herunterladen
            </a>
            <button className="btn btn-sm" onClick={back}>
              <ArrowLeft size={16} /> Zurück
            </button>
          </div>
        }
      />
      {isLoading ? <Loading /> : error ? <EmptyState title="Bearbeitung nicht möglich">{(error as Error).message}</EmptyState> : session && <OfficeFrame session={session} onClose={back} />}
    </div>
  );
}

export function DocumentEditorPage() {
  const id = Number(useParams().id);
  const [opened] = useState(() => Date.now());
  return (
    <OfficeEditor
      title="Dokument"
      subtitle="Änderungen speichert Collabora automatisch; andere Bearbeiter sehen sie sofort."
      start={() => api.editDocument(id)}
      downloadUrl={api.documentUrl(id, true)}
      queryKey={['d', id, opened]}
    />
  );
}

export function TemplateEditorPage() {
  const id = Number(useParams().id);
  const [opened] = useState(() => Date.now());
  const { data: tree } = useQuery({ queryKey: ['templates'], queryFn: api.templates });
  const t = tree?.templates.find((x) => x.id === id);
  return (
    <OfficeEditor
      title={t ? `Vorlage: ${t.name}` : 'Vorlage'}
      fixedTitle
      subtitle="Platzhalter wie {{einsatz.stichwort}} werden beim Erstellen eines Dokuments ersetzt."
      start={() => api.editTemplate(id)}
      downloadUrl={api.templateUrl(id, true)}
      queryKey={['t', id, opened]}
    />
  );
}
