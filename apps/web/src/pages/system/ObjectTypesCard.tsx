import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Library, Pencil, Plus, Trash2, X } from 'lucide-react';
import { BUILTIN_TYPES, OBJECT_FIELD_TYPES, OBJECT_FIELD_TYPE_LABELS, OBJECT_VISIBILITIES, OBJECT_VISIBILITY_LABELS, type ObjectFieldInput, type ObjectFieldType, type ObjectType, type ObjectTypeInput, type ObjectVisibility } from '@elvis/shared';
import { CloudBadge, localEditable } from '../../components/CloudBadge';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Card, Field, Loading, Modal } from '../../components/ui';
import { MapIcon, MapIconPicker } from '../../components/map/mapIcons';

/** Schlüssel aus der Beschriftung: „Leistung (l/min)“ → „leistung_l_min“ */
function keyOf(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'f$1')
      .slice(0, 36) || 'feld';
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
  return key;
}

type FieldRow = Required<Omit<ObjectFieldInput, 'options'>> & { options: string; fixed: boolean; isNew: boolean };

const toRow = (f: ObjectType['fields'][number], fixed: boolean): FieldRow => ({ ...f, options: f.options.join(', '), fixed, isNew: false });

function TypeForm({ initial, pending, onSubmit }: { initial?: ObjectType; pending: boolean; onSubmit: (t: ObjectTypeInput) => void }) {
  const fixedKeys = initial?.builtin ? (BUILTIN_TYPES[initial.builtin].fields ?? []).map((f) => f.key) : [];
  const [name, setName] = useState(initial?.name ?? '');
  const [icon, setIcon] = useState<string | null>(initial?.icon ?? 'MapPin');
  const [color, setColor] = useState(initial?.color ?? '#7c3aed');
  const [visibility, setVisibility] = useState<ObjectVisibility>(initial?.visibility ?? 'both');
  const [fields, setFields] = useState<FieldRow[]>(() => (initial?.fields ?? []).map((f) => toRow(f, fixedKeys.includes(f.key))));
  const set = (i: number, patch: Partial<FieldRow>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = () => setFields((fs) => [...fs, { key: '', label: '', type: 'text', options: '', unit: '', badge: false, fixed: false, isNew: true }]);
  const move = (i: number, d: -1 | 1) =>
    setFields((fs) => {
      const next = [...fs];
      [next[i], next[i + d]] = [next[i + d]!, next[i]!];
      return next;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !icon) return;
    const keys: string[] = [];
    const out = fields
      .filter((f) => f.label.trim())
      .map((f) => {
        const key = f.isNew ? keyOf(f.label, [...keys, ...fields.filter((x) => !x.isNew).map((x) => x.key)]) : f.key;
        keys.push(key);
        return {
          key,
          label: f.label.trim(),
          type: f.type,
          options: f.type === 'select' ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : [],
          unit: f.type === 'number' ? f.unit.trim() : '',
          badge: f.badge,
        };
      });
    onSubmit({ name, icon, color, fields: out, visibility });
  };
  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Name *">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="z. B. Sammelplatz, Gefahrstofflager" required autoFocus />
        </Field>
        <Field label="Farbe">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </Field>
        <Field label="Sichtbar beim Cloud-Abgleich für" hint="Gilt für alle Objekte dieses Typs">
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as ObjectVisibility)}>
            {OBJECT_VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {OBJECT_VISIBILITY_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Symbol *">
        <MapIconPicker value={icon} label="Symbol" onPick={(n) => n && setIcon(n)} />
      </Field>
      <fieldset className="object-fields">
        <legend>Felder</legend>
        {fields.length === 0 && <p className="muted">Ohne eigene Felder haben Objekte Name, Adresse, Bemerkung und Dateien.</p>}
        {fields.map((f, i) => (
          <div key={i} className="object-field-row">
            <input aria-label="Beschriftung" placeholder="Beschriftung" value={f.label} maxLength={60} onChange={(e) => set(i, { label: e.target.value })} />
            <select aria-label="Art" value={f.type} disabled={f.fixed} onChange={(e) => set(i, { type: e.target.value as ObjectFieldType })}>
              {OBJECT_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {OBJECT_FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            {f.type === 'select' && <input aria-label="Auswahlwerte" placeholder="Werte, durch Komma getrennt" value={f.options} onChange={(e) => set(i, { options: e.target.value })} />}
            {f.type === 'number' && <input aria-label="Einheit" placeholder="Einheit" className="object-field-unit" value={f.unit} maxLength={12} onChange={(e) => set(i, { unit: e.target.value })} />}
            <label className="checkbox" title="Wert erscheint als Schild am Kartensymbol">
              <input type="checkbox" checked={f.badge} onChange={(e) => setFields((fs) => fs.map((x, j) => ({ ...x, badge: j === i ? e.target.checked : false })))} /> Schild
            </label>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Nach oben" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={16} />
            </button>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Nach unten" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={16} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Feld entfernen"
              disabled={f.fixed}
              title={f.fixed ? 'Gehört zum vordefinierten Typ' : 'Werte dieses Feldes bleiben gespeichert, werden aber nicht mehr angezeigt'}
              onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
            >
              <X size={16} />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={add}>
          <Plus size={16} /> Feld
        </button>
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !icon}>
          {initial ? 'Speichern' : 'Typ anlegen'}
        </button>
      </div>
    </form>
  );
}

/** Objekttypen der Objektbibliothek (vordefiniert und eigene). Nur Admins. */
export function ObjectTypesCard() {
  const toast = useToast();
  const { data: types } = useQuery({ queryKey: ['library', 'types'], queryFn: api.libraryTypes });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ObjectType | null>(null);
  const onError = (e: Error) => toast('error', e.message);
  const create = useMutation({ mutationFn: api.createObjectType, onSuccess: () => setCreating(false), onError });
  const update = useMutation({ mutationFn: ({ id, input }: { id: number; input: ObjectTypeInput }) => api.updateObjectType(id, input), onSuccess: () => setEditing(null), onError });
  const remove = useMutation({ mutationFn: api.removeObjectType, onError });
  const reorder = useMutation({ mutationFn: api.reorderObjectTypes, onError });

  if (!types) return <Loading />;
  const move = (i: number, d: -1 | 1) => {
    const ids = types.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };
  return (
    <Card
      title="Objekttypen"
      icon={<Library size={18} />}
      actions={
        <button className="btn btn-sm" onClick={() => setCreating(true)}>
          <Plus size={16} /> Typ
        </button>
      }
    >
      <p className="muted">Typen der Objektbibliothek mit eigenen Feldern. Wasserentnahmestelle und Einsatzobjekt sind vorgegeben, ihre Felder lassen sich ergänzen.</p>
      <ul className="simple-list">
        {types.map((t, i) => (
          <li key={t.id}>
            <span style={{ color: t.color, display: 'inline-flex' }}>
              <MapIcon name={t.icon} size={20} />
            </span>
            <div className="grow">
              <div className="cell-title">
                {t.name} <CloudBadge cloud={t.cloud} />
              </div>
              <div className="cell-sub">
                {t.count} {t.count === 1 ? 'Objekt' : 'Objekte'}
                {t.fields.length > 0 && ` · ${t.fields.map((f) => f.label).join(', ')}`}
                {t.builtin && ' · vorgegeben'}
              </div>
            </div>
            <button className="btn btn-ghost btn-icon" aria-label="Nach oben" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
              <ArrowUp size={16} />
            </button>
            <button className="btn btn-ghost btn-icon" aria-label="Nach unten" disabled={i === types.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
              <ArrowDown size={16} />
            </button>
            <button className="btn btn-ghost btn-icon" aria-label={`${t.name} bearbeiten`} disabled={!localEditable(t)} title={localEditable(t) ? undefined : 'Quelle: Cloud – Änderungen im Portal'} onClick={() => setEditing(t)}>
              <Pencil size={16} />
            </button>
            <button
              className="btn btn-ghost btn-icon"
              aria-label={`${t.name} löschen`}
              disabled={!!t.builtin || t.count > 0 || !localEditable(t)}
              title={t.builtin ? 'Vorgegebener Typ' : t.count > 0 ? 'Typ hat noch Objekte' : undefined}
              onClick={() => window.confirm(`Objekttyp „${t.name}“ löschen?`) && remove.mutate(t.id)}
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      <Modal open={creating} title="Objekttyp anlegen" onClose={() => setCreating(false)} wide>
        <TypeForm pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
      <Modal open={!!editing} title="Objekttyp bearbeiten" onClose={() => setEditing(null)} wide>
        {editing && <TypeForm key={editing.id} initial={editing} pending={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Modal>
    </Card>
  );
}
