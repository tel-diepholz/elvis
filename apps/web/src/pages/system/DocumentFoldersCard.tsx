import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, FolderPlus, FolderTree as FolderTreeIcon, Plus, Trash2 } from 'lucide-react';
import { folderSpecsSchema, type FolderSpec } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Card, Loading } from '../../components/ui';

type Path = number[];

/** Baum unveränderlich an einer Stelle ändern */
function update(list: FolderSpec[], path: Path, fn: (siblings: FolderSpec[], index: number) => FolderSpec[]): FolderSpec[] {
  const [head, ...rest] = path;
  if (rest.length === 0) return fn(list, head!);
  return list.map((f, i) => (i === head ? { ...f, children: update(f.children, rest, fn) } : f));
}

/** Ordnerstruktur, die jeder neue Einsatz erhält. Nur Admins. */
export function DocumentFoldersCard() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'documentFolders'], queryFn: api.documentFolderSpec });
  const [tree, setTree] = useState<FolderSpec[] | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setTree(data.folders);
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => api.saveDocumentFolderSpec(tree!),
    onSuccess: () => (setDirty(false), toast('success', 'Ordnervorgabe gespeichert – gilt für neue Einsätze')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !tree) return <Loading />;
  const change = (next: FolderSpec[]) => (setTree(next), setDirty(true));
  const valid = folderSpecsSchema.safeParse(tree);

  const node = (f: FolderSpec, path: Path, siblings: number) => (
    <li key={path.join('.')}>
      <div className="spec-row">
        <input
          value={f.name}
          onChange={(e) => change(update(tree, path, (l, i) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))))}
          maxLength={120}
          aria-label="Ordnername"
        />
        <button type="button" className="btn btn-ghost btn-icon" title="Unterordner" aria-label="Unterordner anlegen" onClick={() => change(update(tree, path, (l, i) => l.map((x, j) => (j === i ? { ...x, children: [...x.children, { name: 'Neuer Ordner', children: [] }] } : x))))}>
          <FolderPlus size={17} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Nach oben" disabled={path.at(-1) === 0} onClick={() => change(update(tree, path, (l, i) => { const n = [...l]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; return n; }))}>
          <ArrowUp size={17} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Nach unten" disabled={path.at(-1) === siblings - 1} onClick={() => change(update(tree, path, (l, i) => { const n = [...l]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; return n; }))}>
          <ArrowDown size={17} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Entfernen" onClick={() => change(update(tree, path, (l, i) => l.filter((_, j) => j !== i)))}>
          <Trash2 size={17} />
        </button>
      </div>
      {f.children.length > 0 && <ul>{f.children.map((c, i) => node(c, [...path, i], f.children.length))}</ul>}
    </li>
  );

  return (
    <Card title="Ordnervorgabe für Dokumente" icon={<FolderTreeIcon size={18} />} className="span-2">
      <p className="muted">
        Diese Ordner erhält jeder neu eröffnete Einsatz. Im Einsatz können Benutzer weitere Ordner anlegen, die vorgegebenen aber nicht löschen. Änderungen gelten
        nur für künftige Einsätze.
      </p>
      <ul className="spec-tree">{tree.map((f, i) => node(f, [i], tree.length))}</ul>
      {!valid.success && <p className="tone-alarm">{valid.error.issues[0]?.message}</p>}
      <div className="btn-row">
        <button type="button" className="btn btn-sm" onClick={() => change([...tree, { name: 'Neuer Ordner', children: [] }])}>
          <Plus size={16} /> Ordner
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || !valid.success || save.isPending} onClick={() => save.mutate()}>
          Speichern
        </button>
        {dirty && (
          <button type="button" className="btn btn-sm" onClick={() => (setDirty(false), setTree(data.folders))}>
            Verwerfen
          </button>
        )}
      </div>
      {data.updatedAt && (
        <p className="cell-sub">
          Zuletzt geändert {fmtDateTime(data.updatedAt)} von {data.updatedBy}
        </p>
      )}
    </Card>
  );
}
