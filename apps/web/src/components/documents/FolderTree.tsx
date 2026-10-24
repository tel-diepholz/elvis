import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderLock } from 'lucide-react';
import { folderPath } from '@elvis/shared';

export interface TreeFolder {
  id: number;
  parentId: number | null;
  name: string;
  /** Aus der Vorgabe (Schloss-Symbol) */
  system?: boolean;
}

/**
 * Ordnerbaum mit Wurzel. `selected` null = Wurzel. Zahlen je Ordner (z. B. Dokumente) optional.
 * Wird für Einsatzdokumente, Vorlagen und die Ordnervorgabe genutzt.
 */
export function FolderTree({
  folders,
  rootLabel,
  selected,
  onSelect,
  counts,
}: {
  folders: TreeFolder[];
  rootLabel: string;
  selected: number | null;
  onSelect: (id: number | null) => void;
  counts?: Map<number | null, number>;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const children = (parentId: number | null) => folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const toggle = (id: number) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const row = (id: number | null, label: ReactNode, icon: ReactNode, depth: number, hasChildren: boolean) => (
    <div className={`tree-row ${selected === id ? 'active' : ''}`} style={{ paddingLeft: 6 + depth * 16 }}>
      {hasChildren && id !== null ? (
        <button type="button" className="tree-toggle" onClick={() => toggle(id)} aria-label={collapsed.has(id) ? 'Aufklappen' : 'Zuklappen'}>
          {collapsed.has(id) ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
      ) : (
        <span className="tree-toggle" />
      )}
      <button type="button" className="tree-label" onClick={() => onSelect(id)} aria-current={selected === id}>
        {icon}
        <span className="tree-name">{label}</span>
        {counts?.get(id) ? <span className="tree-count">{counts.get(id)}</span> : null}
      </button>
    </div>
  );

  const branch = (parentId: number | null, depth: number): ReactNode =>
    children(parentId).map((f) => {
      const kids = children(f.id).length > 0;
      const Icon = f.system ? FolderLock : selected === f.id ? FolderOpen : Folder;
      return (
        <li key={f.id}>
          {row(f.id, f.name, <Icon size={17} />, depth, kids)}
          {kids && !collapsed.has(f.id) && <ul>{branch(f.id, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <ul className="tree" role="tree">
      <li>
        {row(null, rootLabel, <FolderOpen size={17} />, 0, false)}
        <ul>{branch(null, 1)}</ul>
      </li>
    </ul>
  );
}

/** Auswahlliste aller Ordner als „A/B/C“ (z. B. Zielordner) */
export function FolderSelect({
  folders,
  value,
  onChange,
  rootLabel,
  disabled,
}: {
  folders: TreeFolder[];
  value: number | null;
  onChange: (id: number | null) => void;
  rootLabel: string;
  disabled?: boolean;
}) {
  const options = folders.map((f) => ({ id: f.id, path: folderPath(folders, f.id) })).sort((a, b) => a.path.localeCompare(b.path, 'de'));
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} disabled={disabled}>
      <option value="">{rootLabel}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.path}
        </option>
      ))}
    </select>
  );
}
