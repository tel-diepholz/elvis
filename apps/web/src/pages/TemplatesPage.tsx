import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, FilePlus, FileText, FolderPlus, Pencil, Replace, SquarePen, Trash2 } from 'lucide-react';
import { DOCUMENT_PLACEHOLDERS, extensionOf, folderPath, type DocumentTemplate, type TemplateMeta } from '@elvis/shared';
import { api } from '../lib/api';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { Card, EmptyState, Field, Loading, Modal, PageHeader, Toggle } from '../components/ui';
import { FolderSelect, FolderTree } from '../components/documents/FolderTree';

const EMPTY: TemplateMeta = { folderId: null, name: '', description: '', targetPath: '', filenamePattern: '', fillContent: true };

/** Formular für neue und bestehende Vorlagen; Platzhalter per Klick ins zuletzt gewählte Feld */
function TemplateForm({
  initial,
  folders,
  withFile,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: TemplateMeta;
  folders: { id: number; parentId: number | null; name: string }[];
  withFile: boolean;
  busy: boolean;
  onSubmit: (meta: TemplateMeta, file: File | null) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<'targetPath' | 'filenamePattern'>('filenamePattern');
  const set = (patch: Partial<TemplateMeta>) => setV({ ...v, ...patch });

  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v, file);
      }}
    >
      {withFile && (
        <Field label="Datei" hint="Word, Excel, PowerPoint oder OpenDocument; Platzhalter im Text werden beim Erstellen ersetzt.">
          <input
            type="file"
            required
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !v.name) set({ name: f.name.replace(/\.[^.]+$/, '') });
            }}
          />
        </Field>
      )}
      <Field label="Name">
        <input value={v.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} required />
      </Field>
      <Field label="Beschreibung" hint="Hilft beim Suchen.">
        <input value={v.description} onChange={(e) => set({ description: e.target.value })} maxLength={500} />
      </Field>
      <Field label="Ordner (Vorlagen)">
        <FolderSelect folders={folders} value={v.folderId} onChange={(folderId) => set({ folderId })} rootLabel="Vorlagen (oberste Ebene)" />
      </Field>
      <Field label="Ablageort im Einsatz" hint="Ordnerpfad mit / getrennt, fehlende Ordner werden angelegt. Leer = oberste Ebene.">
        <input value={v.targetPath} onChange={(e) => set({ targetPath: e.target.value })} onFocus={() => setTarget('targetPath')} placeholder="z. B. Lagemeldungen/{{datum.iso}}" maxLength={300} />
      </Field>
      <Field label="Dateiname (ohne Endung)" hint="Leer = Name der Vorlage.">
        <input
          value={v.filenamePattern}
          onChange={(e) => set({ filenamePattern: e.target.value })}
          onFocus={() => setTarget('filenamePattern')}
          placeholder="z. B. Lagemeldung {{ordner.laufnummer}} {{datum.zeitkurz}}"
          maxLength={300}
        />
      </Field>
      <Toggle label="Platzhalter auch im Dokument ersetzen" checked={v.fillContent} onChange={(fillContent) => set({ fillContent })} />
      <details className="placeholder-help">
        <summary>Platzhalter (anklicken zum Einfügen in „{target === 'targetPath' ? 'Ablageort' : 'Dateiname'}“)</summary>
        <ul>
          {DOCUMENT_PLACEHOLDERS.filter((p) => target === 'filenamePattern' || p.inPath).map((p) => (
            <li key={p.key}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ [target]: `${v[target]}{{${p.key}}}` })}>
                <code>{`{{${p.key}}}`}</code>
              </button>{' '}
              <span className="muted">{p.label}</span>
            </li>
          ))}
        </ul>
      </details>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={busy || !v.name.trim() || (withFile && !file)}>
          {busy ? 'Speichert …' : 'Speichern'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

/** Vorlagen in einem Ordnerbaum pflegen (nur Admins) */
export function TemplatesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const replaceRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<number | null>(null);
  const [editing, setEditing] = useState<DocumentTemplate | 'new' | null>(null);
  const [folderDialog, setFolderDialog] = useState<'new' | 'rename' | null>(null);
  const [folderName, setFolderName] = useState('');
  const [replacing, setReplacing] = useState<DocumentTemplate | null>(null);
  const { data: tree, isLoading } = useQuery({ queryKey: ['templates'], queryFn: api.templates });
  const { data: office } = useQuery({ queryKey: ['office'], queryFn: api.office });

  const folders = tree?.folders ?? [];
  const here = folderPath(folders, folder) || 'Vorlagen';
  const current = folders.find((f) => f.id === folder);
  const templates = (tree?.templates ?? []).filter((t) => t.folderId === folder);
  const counts = new Map<number | null, number>();
  for (const t of tree?.templates ?? []) counts.set(t.folderId, (counts.get(t.folderId) ?? 0) + 1);

  const err = (e: Error) => toast('error', e.message);
  const save = useMutation({
    mutationFn: ({ meta, file }: { meta: TemplateMeta; file: File | null }) =>
      editing === 'new' ? api.uploadTemplate(meta, file!) : api.updateTemplate((editing as DocumentTemplate).id, meta),
    onSuccess: (t) => (setEditing(null), toast('success', `Vorlage „${t.name}“ gespeichert`)),
    onError: err,
  });
  const replace = useMutation({
    mutationFn: ({ id, file }: { id: number; file: File }) => api.replaceTemplateFile(id, file),
    onSuccess: (t) => toast('success', `Datei von „${t.name}“ ersetzt`),
    onError: err,
  });
  const remove = useMutation({ mutationFn: (id: number) => api.removeTemplate(id), onError: err });
  const saveFolder = useMutation({
    mutationFn: (name: string) =>
      folderDialog === 'rename' && current ? api.updateTemplateFolder(current.id, { parentId: current.parentId, name }) : api.createTemplateFolder({ parentId: folder, name }),
    onSuccess: (f) => (setFolderDialog(null), setFolder(f.id)),
    onError: err,
  });
  const removeFolder = useMutation({ mutationFn: (id: number) => api.removeTemplateFolder(id), onSuccess: () => setFolder(current?.parentId ?? null), onError: err });

  const editable = (t: DocumentTemplate) => !!office?.available && office.editable.includes(extensionOf(t.filename));

  return (
    <>
      <PageHeader title="Vorlagen" subtitle="Dokumentvorlagen für Einsätze – Benutzer finden sie unter Dokumente › Aus Vorlage" />
      <div className="grid">
        <Card
          title="Ordner"
          actions={
            <>
              <button className="btn btn-ghost btn-icon" onClick={() => (setFolderName(''), setFolderDialog('new'))} aria-label="Neuer Ordner" title={`Neuer Ordner in „${here}“`}>
                <FolderPlus size={18} />
              </button>
              {current && (
                <>
                  <button className="btn btn-ghost btn-icon" onClick={() => (setFolderName(current.name), setFolderDialog('rename'))} aria-label="Ordner umbenennen">
                    <Pencil size={18} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => window.confirm(`Ordner „${here}“ entfernen? Nur leere Ordner lassen sich entfernen.`) && removeFolder.mutate(current.id)}
                    aria-label="Ordner entfernen"
                  >
                    <Trash2 size={18} />
                  </button>
                </>
              )}
            </>
          }
        >
          {isLoading ? <Loading /> : <FolderTree folders={folders} rootLabel="Vorlagen" selected={folder} onSelect={setFolder} counts={counts} />}
        </Card>

        <Card
          title={`${here} (${templates.length})`}
          className="span-2"
          actions={
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              <FilePlus size={16} /> Neue Vorlage
            </button>
          }
        >
          {!office?.available && (
            <p className="muted">Ohne Office-Server (Addon „Office (Collabora)“) lassen sich Vorlagen nur hochladen, nicht im Browser bearbeiten.</p>
          )}
          {!templates.length ? (
            <EmptyState title="Keine Vorlagen in diesem Ordner" />
          ) : (
            <ul className="doc-list">
              {templates.map((t) => (
                <li key={t.id} className="doc">
                  <FileText size={22} />
                  <div className="doc-main">
                    <div className="doc-name">{t.name}</div>
                    {t.description && <div>{t.description}</div>}
                    <div className="cell-sub">
                      Ablage: <code>{[t.targetPath, `${t.filenamePattern || t.name}.${extensionOf(t.filename)}`].filter(Boolean).join('/')}</code>
                      {t.fillContent ? ' · Inhalt wird gefüllt' : ''}
                    </div>
                    <div className="cell-sub">
                      {t.filename} · {fmtBytes(t.sizeBytes)} · {t.updatedBy} · {fmtDateTime(t.updatedAt)}
                    </div>
                  </div>
                  <div className="cell-actions">
                    {editable(t) && (
                      <button className="btn btn-ghost btn-icon" onClick={() => navigate(`/vorlagen/${t.id}/bearbeiten`)} aria-label="Im Browser bearbeiten" title="Im Browser bearbeiten">
                        <SquarePen size={18} />
                      </button>
                    )}
                    <button className="btn btn-ghost btn-icon" onClick={() => setEditing(t)} aria-label="Eigenschaften" title="Name, Ablageort, Platzhalter">
                      <Pencil size={18} />
                    </button>
                    <button className="btn btn-ghost btn-icon" onClick={() => (setReplacing(t), replaceRef.current?.click())} aria-label="Datei ersetzen" title="Datei ersetzen">
                      <Replace size={18} />
                    </button>
                    <a className="btn btn-ghost btn-icon" href={api.templateUrl(t.id, true)} aria-label="Herunterladen">
                      <Download size={18} />
                    </a>
                    <button className="btn btn-ghost btn-icon" onClick={() => window.confirm(`Vorlage „${t.name}“ löschen?`) && remove.mutate(t.id)} aria-label="Löschen">
                      <Trash2 size={18} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={replaceRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && replacing) replace.mutate({ id: replacing.id, file: f });
              e.target.value = '';
            }}
          />
        </Card>
      </div>

      <Modal open={!!editing} title={editing === 'new' ? 'Neue Vorlage' : 'Vorlage bearbeiten'} onClose={() => setEditing(null)} wide>
        {editing && (
          <TemplateForm
            initial={editing === 'new' ? { ...EMPTY, folderId: folder } : { ...editing }}
            folders={folders}
            withFile={editing === 'new'}
            busy={save.isPending}
            onSubmit={(meta, file) => save.mutate({ meta, file })}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <Modal open={!!folderDialog} title={folderDialog === 'rename' ? 'Ordner umbenennen' : 'Neuer Ordner'} onClose={() => setFolderDialog(null)}>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (folderName.trim()) saveFolder.mutate(folderName.trim());
          }}
        >
          <Field label={folderDialog === 'rename' ? 'Name' : `Name (in „${here}“)`}>
            <input value={folderName} onChange={(e) => setFolderName(e.target.value)} maxLength={120} required autoFocus />
          </Field>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={saveFolder.isPending || !folderName.trim()}>
              Speichern
            </button>
            <button type="button" className="btn" onClick={() => setFolderDialog(null)}>
              Abbrechen
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
