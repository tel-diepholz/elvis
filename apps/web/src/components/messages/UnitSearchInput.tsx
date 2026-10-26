import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MESSAGE_PARTY_MAX, type MessagePartyInput } from '@elvis/shared';
import { api } from '../../lib/api';

interface Suggestion {
  key: string;
  /** Kraft im Einsatz – Katalogeinträge werden nur als Text übernommen */
  unitId: number | null;
  name: string;
  sub: string;
  search: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Freitextfeld mit Vorschlägen aus der Kräfteverwaltung (Kräfte im Einsatz, im Einsatz bereits verwendete Freitexte,
 * dann Katalog). Ein gewählter Vorschlag
 * verknüpft die Kraft; was keiner Kraft entspricht, bleibt Freitext.
 */
export function UnitSearchInput({
  incidentId,
  value,
  onChange,
  placeholder,
  autoFocus,
  id,
}: {
  incidentId: number;
  value: MessagePartyInput;
  onChange: (v: MessagePartyInput) => void;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
}) {
  const listId = useId();
  const { data: units = [] } = useQuery({ queryKey: ['units', incidentId], queryFn: () => api.units(incidentId) });
  const { data: catalog = [] } = useQuery({ queryKey: ['forces'], queryFn: api.forces });
  const { data: messages = [] } = useQuery({ queryKey: ['messages', incidentId], queryFn: () => api.messages(incidentId) });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const all = useMemo<Suggestion[]>(() => {
    const deployed = new Set(units.map((u) => u.sourceId).filter((s) => s !== null));
    const entry = (key: string, unitId: number | null, f: { name: string; callsign: string; organization: string }, extra?: string): Suggestion => ({
      key,
      unitId,
      name: f.name,
      sub: [f.callsign, f.organization, extra].filter(Boolean).join(' · '),
      search: [f.name, f.callsign, f.organization].join(' ').toLowerCase(),
    });
    const known = new Set([...units.map((u) => norm(u.name)), ...catalog.map((f) => norm(f.name))]);
    // Freitext-Gegenstellen aus bisherigen Meldungen dieses Einsatzes (Empfänger im Ausgang, Absender im Eingang), neueste zuerst
    const freeTexts = new Map<string, string>();
    for (const m of messages) {
      const text = m.direction === 'out' ? (m.recipientUnitId === null ? m.recipient : null) : m.senderUnitId === null ? m.sender : null;
      if (text && !known.has(norm(text)) && !freeTexts.has(norm(text))) freeTexts.set(norm(text), text);
    }
    return [
      ...units.filter((u) => u.status !== 'entlassen').map((u) => entry(`u${u.id}`, u.id, u, 'im Einsatz')),
      ...[...freeTexts.values()].map((text) => entry(`t${norm(text)}`, null, { name: text, callsign: '', organization: '' }, 'bereits verwendet')),
      ...catalog.filter((f) => !deployed.has(f.id)).map((f) => entry(`f${f.id}`, null, f)),
    ];
  }, [units, catalog, messages]);

  const q = norm(value.text);
  const matches = (q ? all.filter((s) => s.search.includes(q)) : all).slice(0, 8);

  const type = (text: string) => {
    // Genau getippter Name einer Kraft im Einsatz verknüpft auch ohne Auswahl
    const exact = all.find((s) => s.unitId !== null && norm(s.name) === norm(text));
    onChange({ text, unitId: exact?.unitId ?? null });
    setOpen(true);
    setActive(0);
  };

  const pick = (s: Suggestion) => {
    onChange({ text: s.name, unitId: s.unitId });
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
    } else if (e.key === 'Enter' && open && matches[active]) {
      e.preventDefault();
      pick(matches[active]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const showList = open && matches.length > 0;

  return (
    <div className="combo">
      <input
        id={id}
        value={value.text}
        onChange={(e) => type(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        maxLength={MESSAGE_PARTY_MAX}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {value.text.trim() && <span className={`combo-tag ${value.unitId ? 'tone-ok' : ''}`}>{value.unitId ? 'Kraft im Einsatz' : 'Freitext'}</span>}
      {showList && (
        <ul className="combo-list" id={listId} role="listbox">
          {matches.map((s, i) => (
            <li
              key={s.key}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              // mousedown statt click: sonst schließt das blur die Liste vorher
              onMouseDown={(e) => (e.preventDefault(), pick(s))}
              onMouseEnter={() => setActive(i)}
            >
              <span className="combo-name">{s.name}</span>
              {s.sub && <span className="combo-sub">{s.sub}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
