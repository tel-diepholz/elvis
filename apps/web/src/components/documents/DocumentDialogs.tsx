import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Search } from 'lucide-react';
import {
  BLANK_KINDS,
  documentPlaceholders,
  extensionOf,
  folderPath,
  fullName,
  renderPlaceholders,
  sanitizeName,
  type BlankKind,
  type DocumentFolder,
  type DocumentListing,
  type DocumentTemplate,
  type Incident,
  type IncidentDocument,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useSettings } from '../../lib/hooks';
import { EmptyState, Field, Loading, Modal } from '../ui';
import { FolderSelect, FolderTree } from './FolderTree';

/** Ablageort, den eine Vorlage jetzt ergäbe (Vorschau; der Server rechnet beim Anlegen erneut) */
function useTargetPreview(incident: Incident, listing: DocumentListing | undefined) {
  const vehicle = useSettings().data?.vehicle;
  const user = useAuth().user;
  return (t: DocumentTemplate): { text: string; error?: boolean } => {
    if (!vehicle || !user) return { text: '' };
    const ctx = { incident, vehicle, userName: fullName(user), now: new Date() };
    try {
      const path = renderPlaceholders(t.targetPath, documentPlaceholders(ctx))
        .split('/')
        .map(sanitizeName)
        .filter(Boolean);
      // Laufende Nummer: Dokumente im Zielordner, falls es ihn schon gibt
      let parentId: number | null = null;
      let exists = true;
      for (const name of path) {
        const f: DocumentFolder | undefined = listing?.folders.find((x) => x.parentId === parentId && x.name.toLowerCase() === name.toLowerCase());
        if (!f) {
          exists = false;
          break;
        }
        parentId = f.id;
      }
      const count = exists ? (listing?.documents.filter((d) => d.folderId === parentId).length ?? 0) : 0;
      const ext = extensionOf(t.filename);
      const stem = sanitizeName(renderPlaceholders(t.filenamePattern || t.name, documentPlaceholders(ctx, count + 1))) || t.name;
      return { text: [...path, ext ? `${stem}.${ext}` : stem].join(' / ') };
    } catch (e) {
      return { text: (e as Error).message, error: true };
    }
  };
}

/** Vorlage suchen und auswählen */
export function TemplatePickerDialog({
  open,
  onClose,
  onPick,
  incident,
  listing,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (t: DocumentTemplate) => void;
  incident: Incident;
  listing: DocumentListing | undefined;
  busy?: boolean;
}) {
  const { data: tree, isLoading } = useQuery({ queryKey: ['templates'], queryFn: api.templates, enabled: open });
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState<number | null>(null);
  const preview = useTargetPreview(incident, listing);

  const matches = useMemo(() => {
    if (!tree) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return tree.templates.filter((t) => t.folderId === folder);
    const words = needle.split(/\s+/);
    return tree.templates.filter((t) => {
      const hay = `${t.name} ${t.description} ${folderPath(tree.folders, t.folderId)} ${t.filename}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [tree, q, folder]);

  return (
    <Modal open={open} title="Dokument aus Vorlage" onClose={onClose} wide>
      <div className="picker">
        <label className="search-field">
          <Search size={18} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Vorlage suchen – Name, Beschreibung, Ordner" autoFocus />
        </label>
        {isLoading || !tree ? (
          <Loading />
        ) : (
          <div className="picker-body">
            {!q.trim() && (
              <div className="picker-tree">
                <FolderTree folders={tree.folders} rootLabel="Alle Vorlagen" selected={folder} onSelect={setFolder} />
              </div>
            )}
            <div className="picker-list">
              {matches.length === 0 ? (
                <EmptyState title={q.trim() ? 'Keine passende Vorlage' : tree.templates.length ? 'Keine Vorlagen in diesem Ordner' : 'Noch keine Vorlagen'}>
                  {!tree.templates.length && 'Vorlagen legen Admins unter Verwaltung › Vorlagen an.'}
                </EmptyState>
              ) : (
                <ul className="doc-list">
                  {matches.map((t) => {
                    const target = preview(t);
                    return (
                      <li key={t.id}>
                        <button type="button" className="doc doc-pick" disabled={busy} onClick={() => onPick(t)}>
                          <FileText size={22} />
                          <span className="doc-main">
                            <span className="doc-name">{t.name}</span>
                            {t.description && <span className="doc-desc">{t.description}</span>}
                            <span className={`cell-sub ${target.error ? 'tone-alarm' : ''}`}>
                              {q.trim() && t.folderId !== null && `${folderPath(tree.folders, t.folderId)} · `}
                              Ablage: {target.text || '–'}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Leeres Dokument: Art, Name und Ordner wählen */
export function NewDocumentDialog({
  open,
  onClose,
  onCreate,
  folders,
  initialFolder,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { kind: BlankKind; name: string; folderId: number | null }) => void;
  folders: DocumentFolder[];
  initialFolder: number | null;
  busy?: boolean;
}) {
  const [kind, setKind] = useState<BlankKind>('text');
  const [name, setName] = useState('');
  const [folderId, setFolderId] = useState<number | null>(initialFolder);
  const [opened, setOpened] = useState(open);
  if (open !== opened) {
    // Beim Öffnen den aktuell gewählten Ordner vorbelegen
    setOpened(open);
    if (open) {
      setFolderId(initialFolder);
      setName('');
    }
  }
  return (
    <Modal open={open} title="Neues Dokument" onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate({ kind, name: name.trim(), folderId });
        }}
      >
        <Field label="Art">
          <select value={kind} onChange={(e) => setKind(e.target.value as BlankKind)}>
            {(Object.keys(BLANK_KINDS) as BlankKind[]).map((k) => (
              <option key={k} value={k}>
                {BLANK_KINDS[k].label} (.{BLANK_KINDS[k].ext})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} required autoFocus placeholder="z. B. Lageskizze Abschnitt Nord" />
        </Field>
        <Field label="Speicherort im Einsatz">
          <FolderSelect folders={folders} value={folderId} onChange={setFolderId} rootLabel="Einsatz (oberste Ebene)" />
        </Field>
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            Anlegen und öffnen
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Umbenennen, verschieben, Beschreibung ändern */
export function DocumentPropertiesDialog({
  doc,
  onClose,
  onSave,
  folders,
  busy,
}: {
  doc: IncidentDocument | null;
  onClose: () => void;
  onSave: (patch: { filename: string; folderId: number | null; description: string }) => void;
  folders: DocumentFolder[];
  busy?: boolean;
}) {
  const [v, setV] = useState({ filename: '', folderId: null as number | null, description: '' });
  const [current, setCurrent] = useState<number | null>(null);
  if (doc && doc.id !== current) {
    setCurrent(doc.id);
    setV({ filename: doc.filename, folderId: doc.folderId, description: doc.description });
  }
  return (
    <Modal open={!!doc} title="Dokument bearbeiten" onClose={() => (setCurrent(null), onClose())}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v);
        }}
      >
        <Field label="Dateiname" hint="Die Dateiendung bleibt erhalten.">
          <input value={v.filename} onChange={(e) => setV({ ...v, filename: e.target.value })} maxLength={200} required />
        </Field>
        <Field label="Ordner">
          <FolderSelect folders={folders} value={v.folderId} onChange={(folderId) => setV({ ...v, folderId })} rootLabel="Einsatz (oberste Ebene)" />
        </Field>
        <Field label="Beschreibung">
          <input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={500} />
        </Field>
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy || !v.filename.trim()}>
            Speichern
          </button>
          <button type="button" className="btn" onClick={() => (setCurrent(null), onClose())}>
            Abbrechen
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Neuen Unterordner anlegen */
export function NewFolderDialog({
  open,
  parentLabel,
  onClose,
  onCreate,
  busy,
}: {
  open: boolean;
  parentLabel: string;
  onClose: () => void;
  onCreate: (name: string) => void;
  busy?: boolean;
}) {
  const [name, setName] = useState('');
  return (
    <Modal open={open} title="Neuer Ordner" onClose={() => (setName(''), onClose())}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim());
          setName('');
        }}
      >
        <Field label={`Name (in „${parentLabel}“)`} hint='Nicht erlaubt: / \ : * ? " < > |'>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        </Field>
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            Anlegen
          </button>
          <button type="button" className="btn" onClick={() => (setName(''), onClose())}>
            Abbrechen
          </button>
        </div>
      </form>
    </Modal>
  );
}
