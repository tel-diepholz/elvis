import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileText, Paperclip, Search, X } from 'lucide-react';
import { folderPath, isChatImage, type ChatAttachment, type IncidentDocument } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtBytes } from '../../lib/format';
import { useActiveIncident } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { EmptyState, Loading, Modal } from '../ui';

/**
 * Anhang aus den Dokumenten des aktiven Einsatzes wählen (Anhänge vom eigenen Rechner gibt es nicht). Der Server kopiert
 * das Dokument in die Nachrichten-Dateien; die Nachricht behält es, auch wenn das Dokument später geändert wird.
 */
export function DocumentAttachButton({
  compact,
  disabledReason,
  onAttached,
}: {
  /** Nur Symbol (Antwortzeile) statt Knopf mit Text */
  compact?: boolean;
  /** Gesetzt = Knopf gesperrt, Text als Hinweis (z. B. „Anhänge gehen nicht per SMS“) */
  disabledReason?: string | null;
  onAttached: (a: ChatAttachment) => void;
}) {
  const toast = useToast();
  const { data: incident } = useActiveIncident();
  const [open, setOpen] = useState(false);
  const take = useMutation({
    mutationFn: (doc: IncidentDocument) => api.chatFileFromDocument(doc.id),
    onSuccess: (a) => (onAttached(a), setOpen(false)),
    onError: (e) => toast('error', e.message),
  });
  const reason = !incident ? 'Anhänge kommen aus den Dokumenten – dafür muss ein Einsatz laufen' : (disabledReason ?? null);
  const title = reason ?? 'Dokument aus dem Einsatz anhängen';
  return (
    <>
      <button
        type="button"
        className={compact ? 'btn btn-ghost btn-icon' : 'btn btn-sm'}
        title={title}
        aria-label="Dokument anhängen"
        disabled={!!reason || take.isPending}
        onClick={() => setOpen(true)}
      >
        <Paperclip size={compact ? 18 : 14} />
        {!compact && (take.isPending ? ' Lädt …' : ' Dokument')}
      </button>
      {incident && (
        <Modal open={open} title={`Dokument anhängen – ${incident.title}`} onClose={() => setOpen(false)} wide>
          <DocumentPicker incidentId={incident.id} busy={take.isPending} onPick={(d) => take.mutate(d)} />
        </Modal>
      )}
    </>
  );
}

/** Dokumente des Einsatzes mit Ordner, Größe und Suche; Klick wählt */
function DocumentPicker({ incidentId, busy, onPick }: { incidentId: number; busy: boolean; onPick: (d: IncidentDocument) => void }) {
  const { data } = useQuery({ queryKey: ['documents', incidentId], queryFn: () => api.documents(incidentId) });
  const [q, setQ] = useState('');
  const items = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.documents
      .map((d) => ({ doc: d, path: folderPath(data.folders, d.folderId) }))
      .filter(({ doc, path }) => !needle || `${doc.filename} ${doc.description} ${path}`.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path, 'de') || a.doc.filename.localeCompare(b.doc.filename, 'de'));
  }, [data, q]);
  if (!data) return <Loading />;
  if (!data.documents.length)
    return (
      <EmptyState icon={<FileText size={28} />} title="Keine Dokumente im Einsatz">
        Dateien zuerst unter Einsatz → Dokumente hochladen oder anlegen.
      </EmptyState>
    );
  return (
    <div className="stack">
      <label className="chat-threads-search doc-pick-search">
        <Search size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Dokument suchen …" autoFocus />
      </label>
      {items.length === 0 ? (
        <p className="muted">Kein Treffer</p>
      ) : (
        <ul className="doc-pick-list">
          {items.map(({ doc, path }) => (
            <li key={doc.id}>
              <button type="button" className="doc-pick-item" disabled={busy} onClick={() => onPick(doc)}>
                <FileText size={16} />
                <span className="doc-pick-name">{doc.filename}</span>
                <span className="doc-pick-meta muted small">
                  {path || 'oberste Ebene'} · {fmtBytes(doc.sizeBytes)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Gewählter Anhang vor dem Senden: Bild als Vorschau, sonst Dateiname */
export function AttachmentChip({ attachment, onRemove }: { attachment: ChatAttachment; onRemove: () => void }) {
  return (
    <span className="chat-chip">
      {isChatImage(attachment.mimeType) ? <img src={api.chatFileUrl(attachment.id)} alt="" /> : <FileText size={16} />}
      {attachment.name}
      <span className="muted small">{fmtBytes(attachment.size)}</span>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Anhang entfernen" onClick={onRemove}>
        <X size={14} />
      </button>
    </span>
  );
}

/** Warum der Anhang über diesen Kanal nicht geht; null = geht */
export function attachmentProblem(attachment: ChatAttachment | null, channels: { label: string; images: boolean; files: boolean }[]): string | null {
  if (!attachment) return null;
  const image = isChatImage(attachment.mimeType);
  const bad = channels.find((c) => (image ? !c.images : !c.files));
  return bad ? `${image ? 'Bilder' : 'Dateien'} gehen nicht per ${bad.label}` : null;
}
