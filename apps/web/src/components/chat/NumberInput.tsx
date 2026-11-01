import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatPhone, phoneKey } from '@elvis/shared';
import { api } from '../../lib/api';

/** Text vor dem letzten Trenner und das gerade getippte Stück (Rufnummern enthalten Leerzeichen – nur , und ; trennen) */
const splitLast = (v: string) => {
  const i = Math.max(v.lastIndexOf(','), v.lastIndexOf(';'));
  return { head: i < 0 ? '' : v.slice(0, i + 1), token: v.slice(i + 1).trim() };
};

export const splitNumbers = (v: string) =>
  v
    .split(/[,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);

/**
 * Empfängerzeile einer Nachricht (mehrere Nummern durch Komma) mit Vorschlägen aus den Kontakten und bisherigen
 * Nachrichten – auch per Name. Kennungen wie Threema-IDs gehen ebenfalls. Eine Auswahl ersetzt das gerade getippte Stück durch die Rufnummer.
 */
export function NumberInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const { head, token } = splitLast(value);
  const [query, setQuery] = useState(token);
  useEffect(() => {
    const t = setTimeout(() => setQuery(token), 200);
    return () => clearTimeout(t);
  }, [token]);
  const { data = [] } = useQuery({ queryKey: ['contacts', 'chatSuggest', query], queryFn: () => api.chatSuggest(query), enabled: query.length > 0, staleTime: 30_000 });
  const chosen = new Set(splitNumbers(head).map(phoneKey));
  const matches = token ? data.filter((s) => !chosen.has(s.number) && s.number !== phoneKey(token)) : [];
  const showList = open && matches.length > 0;

  const pick = (number: string) => {
    onChange(`${head ? `${head.trimEnd()} ` : ''}${formatPhone(number)}, `);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && showList && matches[active]) {
      e.preventDefault();
      pick(matches[active].number);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="combo">
      <input
        value={value}
        onChange={(e) => (onChange(e.target.value), setOpen(true), setActive(0))}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {showList && (
        <ul className="combo-list" id={listId} role="listbox">
          {matches.map((s, i) => (
            <li
              key={s.number}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => (e.preventDefault(), pick(s.number))}
              onMouseEnter={() => setActive(i)}
            >
              <span className="combo-name">{s.name || formatPhone(s.number)}</span>
              <span className="combo-sub">
                {s.name ? formatPhone(s.number) : ''}
                {s.label ? ` · ${s.label}` : ''}
                {s.source === 'contact' ? `${s.name ? ' · ' : ''}Kontakt` : ' bisherige Nachricht'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
