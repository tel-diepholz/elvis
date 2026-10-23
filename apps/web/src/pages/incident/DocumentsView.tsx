import { useRef, useState, type DragEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, Eye, File, FileImage, FileSpreadsheet, FileText, Trash2, Upload } from 'lucide-react';
import type { Incident, IncidentDocument } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Card, EmptyState, Field, Loading } from '../../components/ui';

function DocIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <FileImage size={22} />;
  if (mime.includes('pdf') || mime.startsWith('text/')) return <FileText size={22} />;
  if (mime.includes('sheet') || mime.includes('excel') || mime.includes('csv')) return <FileSpreadsheet size={22} />;
  return <File size={22} />;
}

export function DocumentsView({ incident, readOnly }: { incident: Incident; readOnly?: boolean }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState('');
  const [dragging, setDragging] = useState(false);
  const { data: docs, isLoading } = useQuery({ queryKey: ['documents', incident.id], queryFn: () => api.documents(incident.id) });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) await api.uploadDocument(incident.id, f, description);
      return files.length;
    },
    onSuccess: (n) => {
      setDescription('');
      toast('success', n === 1 ? 'Dokument hochgeladen' : `${n} Dokumente hochgeladen`);
    },
    onError: (e) => toast('error', e.message),
  });
  const remove = useMutation({
    mutationFn: (d: IncidentDocument) => api.removeDocument(d.id),
    onError: (e) => toast('error', e.message),
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (readOnly) return;
    const files = [...e.dataTransfer.files];
    if (files.length) upload.mutate(files);
  };

  return (
    <div className="grid">
      {!readOnly && (
        <Card title="Dokument hinzufügen" className="span-3">
          <div
            className={`dropzone ${dragging ? 'dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Upload size={28} />
            <p>Dateien hierher ziehen oder auswählen (Fotos, Pläne, Lagemeldungen, PDFs – max. 50 MB)</p>
            <div className="form-grid">
              <Field label="Beschreibung (optional)">
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="z. B. Objektplan Halle 3" maxLength={500} />
              </Field>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length) upload.mutate(files);
                e.target.value = '';
              }}
            />
            <button className="btn btn-primary" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
              {upload.isPending ? 'Lädt hoch …' : 'Dateien auswählen'}
            </button>
          </div>
        </Card>
      )}
      <Card title={`Dokumente (${docs?.length ?? 0})`} className="span-3">
        {isLoading ? (
          <Loading />
        ) : !docs?.length ? (
          <EmptyState title="Keine Dokumente" />
        ) : (
          <ul className="doc-list">
            {docs.map((d) => (
              <li key={d.id} className="doc">
                <DocIcon mime={d.mimeType} />
                <div className="doc-main">
                  <a href={api.documentUrl(d.id)} target="_blank" rel="noreferrer" className="doc-name">
                    {d.filename}
                  </a>
                  {d.description && <div>{d.description}</div>}
                  <div className="cell-sub">
                    {fmtBytes(d.sizeBytes)} · {d.uploadedBy} · {fmtDateTime(d.uploadedAt)}
                  </div>
                </div>
                <div className="cell-actions">
                  <a className="btn btn-ghost btn-icon" href={api.documentUrl(d.id)} target="_blank" rel="noreferrer" aria-label="Anzeigen">
                    <Eye size={18} />
                  </a>
                  <a className="btn btn-ghost btn-icon" href={api.documentUrl(d.id, true)} aria-label="Herunterladen">
                    <Download size={18} />
                  </a>
                  {!readOnly && (
                    <button
                      className="btn btn-ghost btn-icon"
                      onClick={() => window.confirm(`„${d.filename}“ entfernen? Der Vorgang wird im Einsatztagebuch protokolliert.`) && remove.mutate(d)}
                      aria-label="Entfernen"
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
