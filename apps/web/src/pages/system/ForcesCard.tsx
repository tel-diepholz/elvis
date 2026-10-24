import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Users, X } from 'lucide-react';
import {
  DEFAULT_UNIT_SIGN,
  ZERO_STRENGTH,
  forceDescendants,
  forceTotalStrength,
  formatStrength,
  sumStrength,
  type ForceMember,
  type ForceUnit,
  type ForceUnitInput,
  type TacticalSign,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Field, Loading, Modal } from '../../components/ui';
import { TacticalSignEditor } from '../../components/tactical/TacticalSignEditor';
import { TacticalSignImage } from '../../components/tactical/TacticalSign';
import { RoleInput, StrengthFields } from '../../components/forces/fields';

function ForceUnitForm({ initial, all, pending, onSubmit }: { initial?: ForceUnit; all: ForceUnit[]; pending: boolean; onSubmit: (input: ForceUnitInput) => void }) {
  const [f, setF] = useState({
    name: initial?.name ?? '',
    callsign: initial?.callsign ?? '',
    organization: initial?.organization ?? '',
    notes: initial?.notes ?? '',
  });
  const [sign, setSign] = useState<TacticalSign>(initial?.sign ?? DEFAULT_UNIT_SIGN);
  const [strength, setStrength] = useState(initial?.strength ?? ZERO_STRENGTH);
  const [members, setMembers] = useState<ForceMember[]>(initial?.members ?? []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const byId = new Map(all.map((u) => [u.id, u]));
  const roles = all.flatMap((u) => u.members.map((m) => m.role));

  // Wählbar: nicht sie selbst, nicht schon Mitglied und keine Einheit, die diese bereits enthält (Zyklus)
  const candidates = all.filter(
    (u) => u.id !== initial?.id && !members.some((m) => m.unitId === u.id) && !(initial && forceDescendants(all, u.id).has(initial.id)),
  );
  const total = useMemo(() => {
    const ids = new Set<number>();
    for (const m of members) [m.unitId, ...forceDescendants(all, m.unitId)].forEach((id) => ids.add(id));
    return sumStrength([{ strength }, ...all.filter((u) => ids.has(u.id) && u.id !== initial?.id)]);
  }, [members, strength, all, initial?.id]);

  const move = (i: number, d: -1 | 1) =>
    setMembers((list) => {
      const next = [...list];
      [next[i], next[i + d]] = [next[i + d]!, next[i]!];
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.name.trim()) onSubmit({ ...f, sign, strength, members });
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Name *">
          <input value={f.name} onChange={set('name')} placeholder="HLF 20 Diepholz, Löschzug Mitte …" required autoFocus maxLength={100} />
        </Field>
        <Field label="Funkrufname">
          <input value={f.callsign} onChange={set('callsign')} placeholder="Florian Diepholz 1/44-1" maxLength={100} />
        </Field>
        <Field label="Organisation">
          <input value={f.organization} onChange={set('organization')} placeholder="FF Diepholz" maxLength={100} />
        </Field>
        <Field label="Bemerkung">
          <input value={f.notes} onChange={set('notes')} maxLength={1000} />
        </Field>
      </div>
      <StrengthFields value={strength} onChange={setStrength} legend="Eigene Stärke (ohne Untereinheiten)" />

      <fieldset className="force-members">
        <legend>Untereinheiten</legend>
        {members.length === 0 && <p className="muted">Keine – die Einheit ist ein einzelnes Fahrzeug oder ein Trupp.</p>}
        <ul className="simple-list">
          {members.map((m, i) => {
            const u = byId.get(m.unitId);
            return (
              <li key={m.unitId}>
                {u && <TacticalSignImage sign={u.sign} height={28} />}
                <span className="grow cell-title">{u?.name ?? `#${m.unitId}`}</span>
                <span className="force-member-role">
                  <RoleInput value={m.role} used={roles} ariaLabel={`Rolle von ${u?.name ?? ''}`} onChange={(role) => setMembers((list) => list.map((x, j) => (j === i ? { ...x, role } : x)))} />
                </span>
                <button type="button" className="btn btn-ghost btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Nach oben">
                  <ArrowUp size={16} />
                </button>
                <button type="button" className="btn btn-ghost btn-icon" disabled={i === members.length - 1} onClick={() => move(i, 1)} aria-label="Nach unten">
                  <ArrowDown size={16} />
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setMembers((list) => list.filter((_, j) => j !== i))} aria-label="Entfernen">
                  <X size={16} />
                </button>
              </li>
            );
          })}
        </ul>
        <select value="" onChange={(e) => e.target.value && setMembers((list) => [...list, { unitId: Number(e.target.value), role: '' }])} disabled={!candidates.length}>
          <option value="">{candidates.length ? '+ Untereinheit hinzufügen …' : 'Keine weiteren Systemeinheiten verfügbar'}</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.members.length ? ` (${u.members.length} Untereinheiten)` : ''}
            </option>
          ))}
        </select>
        {members.length > 0 && <p className="muted">Gesamtstärke mit Untereinheiten: <span className="mono">{formatStrength(total)}</span></p>}
      </fieldset>

      <fieldset className="force-sign">
        <legend>Taktisches Zeichen</legend>
        <TacticalSignEditor value={sign} onChange={setSign} />
      </fieldset>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !f.name.trim()}>
          {initial ? 'Speichern' : 'Einheit anlegen'}
        </button>
      </div>
    </form>
  );
}

/** Kräfteverwaltung: Systemeinheiten (Fahrzeuge, Züge, Verbände), die im Einsatz übernommen werden. Nur Admins. */
export function ForcesCard() {
  const toast = useToast();
  const { data: units } = useQuery({ queryKey: ['forces'], queryFn: api.forces });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ForceUnit | null>(null);
  const [filter, setFilter] = useState('');
  const onError = (e: Error) => toast('error', e.message);

  const create = useMutation({ mutationFn: api.createForce, onSuccess: () => setCreating(false), onError });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: number; input: ForceUnitInput }) => api.updateForce(id, input),
    onSuccess: () => setEditing(null),
    onError,
  });
  const remove = useMutation({ mutationFn: api.removeForce, onError });

  if (!units) return <Loading />;
  const byId = new Map(units.map((u) => [u.id, u]));
  const q = filter.trim().toLowerCase();
  const shown = q ? units.filter((u) => [u.name, u.callsign, u.organization].some((v) => v.toLowerCase().includes(q))) : units;

  const confirmRemove = (u: ForceUnit) => {
    const parents = units.filter((p) => p.members.some((m) => m.unitId === u.id)).map((p) => p.name);
    const msg = `Systemeinheit „${u.name}“ löschen?${parents.length ? `\nSie wird auch aus ${parents.join(', ')} entfernt.` : ''}\nLaufende und archivierte Einsätze behalten ihre Kopie.`;
    if (window.confirm(msg)) remove.mutate(u.id);
  };

  return (
    <Card
      title="Kräfteverwaltung"
      icon={<Users size={18} />}
      className="span-3"
      actions={
        <button className="btn btn-sm" onClick={() => setCreating(true)}>
          <Plus size={16} /> Einheit
        </button>
      }
    >
      <p className="muted">
        Systemeinheiten lassen sich im Einsatz mit allen Untereinheiten übernehmen. Eine Einheit ist ein Fahrzeug, ein Zug oder ein Verband; dieselbe Einheit darf in
        mehreren Einheiten stecken. Änderungen gelten nur für künftige Übernahmen.
      </p>
      {units.length > 8 && <input className="force-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Einheiten filtern …" aria-label="Einheiten filtern" />}
      {units.length === 0 ? (
        <EmptyState title="Noch keine Systemeinheiten">
          <p>Fahrzeuge anlegen und daraus Züge und Verbände zusammenstellen – oder im Einsatz erfasste Einheiten übernehmen.</p>
        </EmptyState>
      ) : (
        <ul className="simple-list force-list">
          {shown.map((u) => {
            const parents = units.filter((p) => p.members.some((m) => m.unitId === u.id));
            return (
              <li key={u.id}>
                <TacticalSignImage sign={u.sign} height={40} />
                <div className="grow">
                  <div className="cell-title">{u.name}</div>
                  <div className="cell-sub">
                    {[u.callsign, u.organization, `Stärke ${formatStrength(u.members.length ? forceTotalStrength(units, u.id) : u.strength)}`].filter(Boolean).join(' · ')}
                  </div>
                  {u.members.length > 0 && (
                    <div className="chip-row">
                      {u.members.map((m) => (
                        <Badge key={m.unitId} tone="info">
                          {m.role ? `${m.role}: ` : ''}
                          {byId.get(m.unitId)?.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {parents.length > 0 && <div className="cell-sub">gehört zu {parents.map((p) => p.name).join(', ')}</div>}
                </div>
                <button className="btn btn-ghost btn-icon" onClick={() => setEditing(u)} aria-label={`${u.name} bearbeiten`}>
                  <Pencil size={16} />
                </button>
                <button className="btn btn-ghost btn-icon" onClick={() => confirmRemove(u)} aria-label={`${u.name} löschen`}>
                  <Trash2 size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={creating} title="Systemeinheit anlegen" onClose={() => setCreating(false)} wide>
        <ForceUnitForm all={units} pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
      <Modal open={!!editing} title={`${editing?.name ?? ''} bearbeiten`} onClose={() => setEditing(null)} wide>
        {editing && <ForceUnitForm initial={editing} all={units} pending={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Modal>
    </Card>
  );
}
