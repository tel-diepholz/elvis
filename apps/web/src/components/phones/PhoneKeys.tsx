import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import {
  PHONE_KEY_SOURCE,
  PHONE_KEY_TYPE,
  contactName,
  dialableNumber,
  phoneKeySchema,
  type Phone,
  type PhoneKey,
  type PhoneKeyInput,
  type PhoneKeySlot,
  type PhoneKeyType,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { Badge, Field, Modal, Segmented, type Tone } from '../ui';

const SOURCE_TONE: Record<NonNullable<PhoneKeySlot['source']>, Tone> = { incident: 'warn', phone: 'info', template: 'muted' };

/**
 * Tasten eines Telefons wie am Gerät: Seiten zu je 12 Tasten, links und rechts vom Display. Jede Taste zeigt
 * Beschriftung, Ziel und die Ebene, aus der die Belegung kommt.
 */
export function KeyGrid({
  slots,
  perPage = 12,
  onSelect,
  disabled,
  showSource = true,
}: {
  slots: PhoneKeySlot[];
  perPage?: number;
  onSelect: (slot: PhoneKeySlot) => void;
  disabled?: boolean;
  showSource?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(slots.length / perPage));
  const [page, setPage] = useState(0);
  const visible = slots.slice(page * perPage, (page + 1) * perPage);
  const half = Math.ceil(visible.length / 2);
  const column = (list: PhoneKeySlot[]) => (
    <div className="phone-keys-col">
      {list.map((s) => (
        <button
          key={s.idx}
          type="button"
          className={`phone-key ${s.target ? 'set' : ''} ${s.error ? 'broken' : ''} ${s.source === 'incident' ? 'override' : ''}`}
          onClick={() => onSelect(s)}
          disabled={disabled}
          title={s.error ?? (s.target ? `${s.label} → ${s.target}` : 'frei')}
        >
          <span className="phone-key-no">{s.idx + 1}</span>
          <span className="phone-key-text">
            <span className="phone-key-label">{s.label || (s.target ? s.target : 'frei')}</span>
            {s.target && s.label !== s.target && <span className="phone-key-target mono">{s.target}</span>}
            {s.error && <span className="phone-key-target tone-alarm">{s.error}</span>}
          </span>
          {showSource && s.source && <Badge tone={SOURCE_TONE[s.source]}>{PHONE_KEY_SOURCE[s.source]}</Badge>}
        </button>
      ))}
    </div>
  );
  return (
    <div className="phone-keys">
      {pages > 1 && (
        <Segmented
          label="Tastenseite"
          value={page}
          onChange={setPage}
          options={Array.from({ length: pages }, (_, i) => ({ value: i, label: `Seite ${i + 1}` }))}
        />
      )}
      <div className="phone-keys-face">
        {column(visible.slice(0, half))}
        <div className="phone-keys-display" aria-hidden="true" />
        {column(visible.slice(half))}
      </div>
    </div>
  );
}

interface Draft {
  type: PhoneKeyType;
  label: string;
  number: string;
  extension: string;
  contactId: number | null;
  phone: number;
}

const draftOf = (k: PhoneKey | null): Draft => ({
  type: k?.type ?? 'contact',
  label: k && k.type !== 'empty' ? k.label : '',
  number: k?.type === 'number' ? k.number : '',
  extension: k?.type === 'blf' ? k.extension : '',
  contactId: k?.type === 'contact' ? k.contactId : null,
  phone: k?.type === 'contact' ? k.phone : 0,
});

const keyOf = (d: Draft): PhoneKeyInput | null => {
  switch (d.type) {
    case 'contact':
      return d.contactId === null ? null : { type: 'contact', contactId: d.contactId, phone: d.phone, label: d.label };
    case 'number':
      return { type: 'number', number: d.number, label: d.label };
    case 'blf':
      return { type: 'blf', extension: d.extension, label: d.label };
    case 'empty':
      return { type: 'empty' };
  }
};

/** Kontaktnummer suchen und wählen */
function ContactPicker({ contactId, phone, onPick }: { contactId: number | null; phone: number; onPick: (contactId: number, phone: number) => void }) {
  const { data: contacts } = useQuery({ queryKey: ['contacts'], queryFn: api.contacts });
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (contacts ?? [])
      .flatMap((c) => c.phones.map((p, i) => ({ c, i, label: p.label, number: p.number, name: contactName(c) })))
      .filter((r) => dialableNumber(r.number))
      .filter((r) => !needle || `${r.name} ${r.label} ${r.number} ${r.c.function}`.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [contacts, q]);
  const selected = rows.find((r) => r.c.id === contactId && r.i === phone) ?? (contacts ?? []).flatMap((c) => (c.id === contactId ? [{ name: contactName(c), label: c.phones[phone]?.label ?? '', number: c.phones[phone]?.number ?? '' }] : []))[0];
  return (
    <div className="phone-contact-picker">
      {selected && (
        <p>
          Gewählt: <strong>{selected.name}</strong> {selected.label && `(${selected.label})`} <span className="mono">{selected.number}</span>
        </p>
      )}
      <label className="search-field">
        <Search size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Kontakt suchen …" aria-label="Kontakt suchen" autoFocus />
      </label>
      <ul className="simple-list phone-contact-list">
        {rows.slice(0, 50).map((r) => (
          <li key={`${r.c.id}-${r.i}`}>
            <button type="button" className={`btn btn-ghost phone-contact-row ${r.c.id === contactId && r.i === phone ? 'active' : ''}`} onClick={() => onPick(r.c.id, r.i)}>
              <span>{r.name}</span>
              <span className="cell-sub">
                {r.label && `${r.label} · `}
                <span className="mono">{r.number}</span>
              </span>
            </button>
          </li>
        ))}
        {contacts && rows.length === 0 && <li className="muted">Keine Kontakte mit Telefonnummer gefunden.</li>}
      </ul>
    </div>
  );
}

/**
 * Taste belegen: Kontakt, Nummer, Nebenstelle (BLF) oder ausdrücklich frei. `onClear` nimmt die Belegung dieser Ebene
 * zurück (dann gilt die darunterliegende).
 */
export function KeyEditor({
  slot,
  layer,
  title,
  phones,
  clearLabel,
  pending,
  onSave,
  onClear,
  onClose,
}: {
  slot: PhoneKeySlot;
  /** Belegung der bearbeiteten Ebene (Vorgabe im Formular) */
  layer: PhoneKey | null;
  title: string;
  /** Für die Auswahl der Nebenstellen */
  phones: Phone[];
  clearLabel?: string;
  pending: boolean;
  onSave: (key: PhoneKeyInput) => void;
  onClear?: () => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(layer ?? (slot.source ? (slot.incident ?? slot.phone ?? slot.template) : null)));
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const key = keyOf(d);
  const valid = key !== null && phoneKeySchema.safeParse(key).success;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key && valid) onSave(key);
  };
  const extensions = phones.map((p) => ({ ext: p.extension, name: p.name }));

  return (
    <Modal open title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Segmented
          label="Art der Taste"
          value={d.type}
          onChange={(type) => set({ type })}
          options={(Object.keys(PHONE_KEY_TYPE) as PhoneKeyType[]).map((t) => ({ value: t, label: PHONE_KEY_TYPE[t] }))}
        />
        {d.type === 'contact' && <ContactPicker contactId={d.contactId} phone={d.phone} onPick={(contactId, phone) => set({ contactId, phone })} />}
        {d.type === 'number' && (
          <Field label="Rufnummer" hint="Wird wählbar gemacht: „+49 (0)5441 / 123-4“ → „+4954411234“">
            <input value={d.number} onChange={(e) => set({ number: e.target.value })} maxLength={40} inputMode="tel" required autoFocus />
          </Field>
        )}
        {d.type === 'blf' && (
          <Field label="Nebenstelle" hint="Die Taste leuchtet, solange die Nebenstelle telefoniert; Drücken ruft an bzw. übernimmt einen klingelnden Anruf.">
            <input value={d.extension} onChange={(e) => set({ extension: e.target.value })} list="phone-extensions" maxLength={20} inputMode="tel" required autoFocus />
            <datalist id="phone-extensions">
              {extensions.map((x) => (
                <option key={x.ext} value={x.ext}>
                  {x.name}
                </option>
              ))}
            </datalist>
          </Field>
        )}
        {d.type !== 'empty' ? (
          <Field label="Beschriftung" hint={d.type === 'contact' ? 'Leer = Name des Kontakts' : 'Leer = Nummer'}>
            <input value={d.label} onChange={(e) => set({ label: e.target.value })} maxLength={40} />
          </Field>
        ) : (
          <p className="muted">Die Taste bleibt frei – auch wenn die Vorlage oder die Grundbelegung sie belegt.</p>
        )}
        <div className="form-actions spread">
          <span>
            {onClear && (
              <button type="button" className="btn" disabled={pending} onClick={onClear}>
                {clearLabel ?? 'Belegung entfernen'}
              </button>
            )}
          </span>
          <span className="btn-row">
            <button type="button" className="btn" onClick={onClose}>
              Abbrechen
            </button>
            <button type="submit" className="btn btn-primary" disabled={pending || !valid}>
              Speichern
            </button>
          </span>
        </div>
      </form>
    </Modal>
  );
}
