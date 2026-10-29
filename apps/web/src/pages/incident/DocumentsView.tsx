import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, Eye, File, FileImage, FilePlus, FileSpreadsheet, FileStack, FileText, FolderPlus, Layers, Pencil, Search, SquarePen, Trash2, Upload, Wrench } from 'lucide-react';
import { extensionOf, folderPath, type Incident, type IncidentDocument } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Loading } from '../../components/ui';
import { FolderTree } from '../../components/documents/FolderTree';
import { DocumentPropertiesDialog, NewDocumentDialog, NewFolderDialog, TemplatePickerDialog } from '../../components/documents/DocumentDialogs';
import { PdfToMapDialog } from '../../components/documents/PdfToMapDialog';
import { Dropdown } from '../map/toolbar';

function DocIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <FileImage size={22} />;
  if (mime.includes('pdf') || mime.startsWith('text/') || mime.includes('word') || mime.includes('opendocument.text')) return <FileText size={22} />;
  if (mime.includes('sheet') || mime.includes('excel') || mime.includes('csv')) return <FileSpreadsheet size={22} />;
  return <File size={22} />;
}

type Dialog = 'template' | 'blank' | 'folder' | 'pdf-map' | null;

const isPdf = (d: IncidentDocument) => d.mimeType === 'application/pdf' || extensionOf(d.filename) === 'pdf';

export function DocumentsView({ incident, readOnly }: { incident: Incident; readOnly?: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const admin = !!useAuth().user?.isAdmin;
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState<IncidentDocument | null>(null);
  /** PDF, mit dem „PDF in Karte integrieren“ startet (null = Auswahl im Dialog) */
  const [toMap, setToMap] = useState<IncidentDocument | null>(null);
  const [dragging, setDragging] = useState(false);
  const { data: listing, isLoading } = useQuery({ queryKey: ['documents', incident.id], queryFn: () => api.documents(incident.id) });
  const { data: office } = useQuery({ queryKey: ['office'], queryFn: api.office });

  const folders = listing?.folders ?? [];
  const docs = listing?.documents ?? [];
  const path = (id: number | null) => folderPath(folders, id);
  const here = path(folder) || 'Einsatz';
  const counts = useMemo(() => {
    const m = new Map<number | null, number>();
    for (const d of docs) m.set(d.folderId, (m.get(d.folderId) ?? 0) + 1);
    return m;
  }, [docs]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return docs.filter((d) => d.folderId === folder);
    return docs.filter((d) => {
      const hay = `${d.filename} ${d.description} ${folderPath(folders, d.folderId)} ${d.uploadedBy}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [docs, folders, folder, q]);

  const editable = (d: IncidentDocument) => !!office?.available && (office.editable.includes(extensionOf(d.filename)) || office.viewable.includes(extensionOf(d.filename)));
  const open = (d: IncidentDocument) => navigate(`/dokument/${d.id}`);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) await api.uploadDocument(incident.id, f, '', folder);
      return files.length;
    },
    onSuccess: (n) => toast('success', n === 1 ? `Dokument in „${here}“ hochgeladen` : `${n} Dokumente in „${here}“ hochgeladen`),
    onError: (e) => toast('error', e.message),
  });
  const fromTemplate = useMutation({
    mutationFn: (templateId: number) => api.createFromTemplate(incident.id, templateId),
    onSuccess: (d) => {
      setDialog(null);
      if (editable(d)) open(d);
      else toast('success', `„${d.filename}“ angelegt – Bearbeitung im Browser ist nicht verfügbar, bitte herunterladen`);
    },
    onError: (e) => toast('error', e.message),
  });
  const blank = useMutation({
    mutationFn: (input: Parameters<typeof api.createBlankDocument>[1]) => api.createBlankDocument(incident.id, input),
    onSuccess: (d) => {
      setDialog(null);
      open(d);
    },
    onError: (e) => toast('error', e.message),
  });
  const newFolder = useMutation({
    mutationFn: (name: string) => api.createFolder(incident.id, { parentId: folder, name }),
    onSuccess: (f) => (setDialog(null), setFolder(f.id)),
    onError: (e) => toast('error', e.message),
  });
  const removeFolder = useMutation({
    mutationFn: (id: number) => api.removeFolder(id),
    onSuccess: () => setFolder(null),
    onError: (e) => toast('error', e.message),
  });
  const patch = useMutation({
    mutationFn: ({ id, ...p }: { id: number; filename: string; folderId: number | null; description: string }) => api.patchDocument(id, p),
    onSuccess: () => setEditing(null),
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

  const current = folder === null ? null : folders.find((f) => f.id === folder);
  const canRemoveFolder = admin && !readOnly && current && !current.system && !counts.get(current.id) && !folders.some((f) => f.parentId === current.id);

  return (
    <div className="grid">
      <Card
        title="Ordner"
        className="docs-tree-card"
        actions={
          !readOnly && (
            <button className="btn btn-ghost btn-icon" onClick={() => setDialog('folder')} aria-label="Neuer Ordner" title={`Neuer Ordner in „${here}“`}>
              <FolderPlus size={18} />
            </button>
          )
        }
      >
        {isLoading ? <Loading /> : <FolderTree folders={folders} rootLabel="Einsatz" selected={folder} onSelect={(id) => (setFolder(id), setQ(''))} counts={counts} />}
        {canRemoveFolder && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => window.confirm(`Leeren Ordner „${here}“ entfernen?`) && removeFolder.mutate(current.id)}
          >
            <Trash2 size={16} /> Ordner entfernen
          </button>
        )}
        {!readOnly && <p className="muted docs-hint">Ordner mit Schloss stammen aus der Vorgabe. Ordner lassen sich ergänzen, aber nicht löschen.</p>}
      </Card>

      <Card
        title={q.trim() ? `Suche (${shown.length})` : `${here} (${shown.length})`}
        className="span-2"
        actions={
          !readOnly && (
            <div className="btn-row">
              <button className="btn btn-primary btn-sm" onClick={() => setDialog('template')}>
                <FileStack size={16} /> Aus Vorlage
              </button>
              <button className="btn btn-sm" onClick={() => setDialog('blank')} disabled={!office?.available} title={office?.available ? undefined : 'Office-Server (Collabora) nicht verfügbar'}>
                <FilePlus size={16} /> Neues Dokument
              </button>
              <button className="btn btn-sm" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
                <Upload size={16} /> {upload.isPending ? 'Lädt hoch …' : 'Hochladen'}
              </button>
              <Dropdown
                small
                align="right"
                label="Tools"
                button={
                  <>
                    <Wrench size={16} /> Tools
                  </>
                }
              >
                {(close) => (
                  <button type="button" role="menuitem" className="map-dropdown-item" onClick={() => (close(), setToMap(null), setDialog('pdf-map'))}>
                    <Layers size={18} /> PDF in Karte integrieren …
                  </button>
                )}
              </Dropdown>
            </div>
          )
        }
      >
        <div
          className={`docs-pane ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            if (readOnly) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <label className="search-field">
            <Search size={18} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Alle Dokumente des Einsatzes durchsuchen" />
          </label>
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
          {isLoading ? (
            <Loading />
          ) : !shown.length ? (
            <EmptyState title={q.trim() ? 'Nichts gefunden' : 'Keine Dokumente in diesem Ordner'}>
              {!readOnly && !q.trim() && 'Dateien hierher ziehen (Fotos, Pläne, PDFs – max. 50 MB) oder ein Dokument aus einer Vorlage erstellen.'}
            </EmptyState>
          ) : (
            <ul className="doc-list">
              {shown.map((d) => (
                <li key={d.id} className="doc">
                  <DocIcon mime={d.mimeType} />
                  <div className="doc-main">
                    {editable(d) ? (
                      <button type="button" className="doc-name link-button" onClick={() => open(d)}>
                        {d.filename}
                      </button>
                    ) : (
                      <a href={api.documentUrl(d.id)} target="_blank" rel="noreferrer" className="doc-name">
                        {d.filename}
                      </a>
                    )}{' '}
                    {d.draft && <Badge tone="warn">Entwurf – erst nach dem Speichern für alle sichtbar</Badge>}
                    {d.description && <div>{d.description}</div>}
                    <div className="cell-sub">
                      {q.trim() && `${path(d.folderId) || 'Einsatz'} · `}
                      {fmtBytes(d.sizeBytes)} · {d.updatedBy} · {fmtDateTime(d.updatedAt)}
                      {d.version > 1 && ` · Version ${d.version}`}
                    </div>
                  </div>
                  <div className="cell-actions">
                    {editable(d) && (
                      <button className="btn btn-ghost btn-icon" onClick={() => open(d)} aria-label={readOnly ? 'Öffnen' : 'Bearbeiten'} title={readOnly ? 'Öffnen' : 'Im Browser bearbeiten'}>
                        <SquarePen size={18} />
                      </button>
                    )}
                    <a className="btn btn-ghost btn-icon" href={api.documentUrl(d.id)} target="_blank" rel="noreferrer" aria-label="Anzeigen">
                      <Eye size={18} />
                    </a>
                    <a className="btn btn-ghost btn-icon" href={api.documentUrl(d.id, true)} aria-label="Herunterladen">
                      <Download size={18} />
                    </a>
                    {!readOnly && (
                      <>
                        {isPdf(d) && (
                          <button className="btn btn-ghost btn-icon" onClick={() => (setToMap(d), setDialog('pdf-map'))} aria-label="In Karte integrieren" title="In Karte integrieren">
                            <Layers size={18} />
                          </button>
                        )}
                        <button className="btn btn-ghost btn-icon" onClick={() => setEditing(d)} aria-label="Umbenennen oder verschieben">
                          <Pencil size={18} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={() =>
                            window.confirm(d.draft ? `Entwurf „${d.filename}“ verwerfen?` : `„${d.filename}“ entfernen? Der Vorgang wird im Einsatztagebuch protokolliert.`) &&
                            remove.mutate(d)
                          }
                          aria-label="Entfernen"
                        >
                          <Trash2 size={18} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {!readOnly && (
        <>
          <TemplatePickerDialog
            open={dialog === 'template'}
            onClose={() => setDialog(null)}
            onPick={(t) => fromTemplate.mutate(t.id)}
            incident={incident}
            listing={listing}
            busy={fromTemplate.isPending}
          />
          <NewDocumentDialog open={dialog === 'blank'} onClose={() => setDialog(null)} onCreate={(i) => blank.mutate(i)} folders={folders} initialFolder={folder} busy={blank.isPending} />
          <NewFolderDialog open={dialog === 'folder'} parentLabel={here} onClose={() => setDialog(null)} onCreate={(name) => newFolder.mutate(name)} busy={newFolder.isPending} />
          <DocumentPropertiesDialog doc={editing} onClose={() => setEditing(null)} onSave={(p) => editing && patch.mutate({ id: editing.id, ...p })} folders={folders} busy={patch.isPending} />
          {dialog === 'pdf-map' && <PdfToMapDialog incident={incident} documents={docs} initial={toMap} onClose={() => setDialog(null)} />}
        </>
      )}
    </div>
  );
}
