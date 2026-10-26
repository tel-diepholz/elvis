import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Bold, Heading, Italic, List, ListOrdered } from 'lucide-react';
import { Markdown } from './Markdown';

const LIST_ITEM = /^(\s*)([-*+]|(\d+)\.)\s(.*)$/;

/** Textfeld mit kleiner Werkzeugleiste (fett, kursiv, Listen, Überschrift) und Vorschau; Enter setzt Listen fort */
export function MarkdownEditor({
  value,
  onChange,
  maxLength,
  placeholder,
  rows = 6,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  /** Neuen Text setzen und danach die Auswahl wiederherstellen */
  const apply = (next: string, start: number, end = start) => {
    onChange(next);
    requestAnimationFrame(() => {
      const ta = ref.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(start, end);
    });
  };

  const wrap = (marker: string) => {
    const ta = ref.current!;
    const { selectionStart: s, selectionEnd: e } = ta;
    const selected = value.slice(s, e) || 'Text';
    apply(value.slice(0, s) + marker + selected + marker + value.slice(e), s + marker.length, s + marker.length + selected.length);
  };

  /** Ausgewählte Zeilen mit Präfix versehen bzw. es wieder entfernen */
  const prefixLines = (kind: 'bullet' | 'number' | 'heading') => {
    const ta = ref.current!;
    const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    const endBreak = value.indexOf('\n', ta.selectionEnd);
    const end = endBreak === -1 ? value.length : endBreak;
    const lines = value.slice(start, end).split('\n');
    const pattern = kind === 'heading' ? /^#{1,6}\s/ : kind === 'bullet' ? /^\s*[-*+]\s/ : /^\s*\d+\.\s/;
    const has = lines.every((l) => pattern.test(l));
    const next = lines.map((l, i) => {
      if (has) return l.replace(pattern, '');
      const bare = l.replace(/^(#{1,6}|\s*[-*+]|\s*\d+\.)\s/, '');
      return (kind === 'heading' ? '## ' : kind === 'bullet' ? '- ' : `${i + 1}. `) + bare;
    });
    const joined = next.join('\n');
    apply(value.slice(0, start) + joined + value.slice(end), start + joined.length);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const ta = e.currentTarget;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const pos = ta.selectionStart;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const m = LIST_ITEM.exec(value.slice(lineStart, pos));
    if (!m) return;
    e.preventDefault();
    const [, indent, bullet, num, rest] = m;
    // Leerer Listenpunkt beendet die Liste
    if (!rest!.trim()) return apply(value.slice(0, lineStart) + value.slice(pos), lineStart);
    const marker = num ? `${Number(num) + 1}.` : bullet;
    const insert = `\n${indent}${marker} `;
    apply(value.slice(0, pos) + insert + value.slice(pos), pos + insert.length);
  };

  const tool = (label: string, icon: ReactNode, run: () => void) => (
    <button type="button" className="btn btn-ghost btn-icon btn-sm" title={label} aria-label={label} onClick={run} disabled={preview}>
      {icon}
    </button>
  );

  return (
    <div className="md-editor">
      <div className="md-toolbar">
        {tool('Fett', <Bold size={16} />, () => wrap('**'))}
        {tool('Kursiv', <Italic size={16} />, () => wrap('_'))}
        {tool('Aufzählung', <List size={16} />, () => prefixLines('bullet'))}
        {tool('Nummerierte Liste', <ListOrdered size={16} />, () => prefixLines('number'))}
        {tool('Überschrift', <Heading size={16} />, () => prefixLines('heading'))}
        <span className="md-toolbar-spacer" />
        <button type="button" className={`btn btn-sm ${preview ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPreview((p) => !p)} aria-pressed={preview}>
          Vorschau
        </button>
      </div>
      {preview ? (
        <div className="md-preview">{value.trim() ? <Markdown text={value} /> : <p className="muted">Noch kein Text</p>}</div>
      ) : (
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={rows}
          maxLength={maxLength}
          placeholder={placeholder}
          autoFocus={autoFocus}
        />
      )}
    </div>
  );
}
