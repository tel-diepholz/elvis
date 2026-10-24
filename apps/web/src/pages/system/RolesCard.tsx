import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, UserRoundCog } from 'lucide-react';
import type { RoleInfo, RoleInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Card, EmptyState, Field, Loading, Modal } from '../../components/ui';

function RoleForm({ initial, pending, onSubmit }: { initial?: RoleInfo; pending: boolean; onSubmit: (r: RoleInput) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit({ name, description });
  };
  return (
    <form className="form" onSubmit={submit}>
      <Field label="Name *">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="z. B. Einsatzleiter, Führungsassistent, Funk" required autoFocus />
      </Field>
      <Field label="Beschreibung" hint="Wird bei der Rollenwahl nach der Anmeldung angezeigt">
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </Field>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {initial ? 'Speichern' : 'Rolle anlegen'}
        </button>
      </div>
    </form>
  );
}

/** Rollen im Einsatz, die Benutzer nach der Anmeldung übernehmen. Nur Admins. */
export function RolesCard() {
  const toast = useToast();
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RoleInfo | null>(null);
  const onError = (e: Error) => toast('error', e.message);

  const create = useMutation({ mutationFn: api.createRole, onSuccess: () => setCreating(false), onError });
  const update = useMutation({ mutationFn: ({ id, input }: { id: number; input: RoleInput }) => api.updateRole(id, input), onSuccess: () => setEditing(null), onError });
  const remove = useMutation({ mutationFn: api.removeRole, onError });
  const reorder = useMutation({ mutationFn: api.reorderRoles, onError });

  if (!roles) return <Loading />;
  const move = (i: number, d: -1 | 1) => {
    const ids = roles.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <Card
      title="Rollen im Einsatz"
      icon={<UserRoundCog size={18} />}
      actions={
        <button className="btn btn-sm" onClick={() => setCreating(true)}>
          <Plus size={16} /> Rolle
        </button>
      }
    >
      <p className="muted">Nach der Anmeldung wählt jeder Benutzer eine Rolle; Aufgaben lassen sich an Rollen vergeben.</p>
      {roles.length === 0 ? (
        <EmptyState title="Keine Rollen angelegt">
          <p>Ohne Rollen fragt ELVIS nach der Anmeldung nicht nach einer Rolle.</p>
        </EmptyState>
      ) : (
        <ul className="simple-list">
          {roles.map((r, i) => (
            <li key={r.id}>
              <div className="grow">
                <div className="cell-title">{r.name}</div>
                <div className="cell-sub">{r.holders.length ? `besetzt: ${r.holders.join(', ')}` : 'unbesetzt'}{r.description && ` · ${r.description}`}</div>
              </div>
              <button className="btn btn-ghost btn-icon" aria-label="Nach oben" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                <ArrowUp size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" aria-label="Nach unten" disabled={i === roles.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                <ArrowDown size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" aria-label={`${r.name} bearbeiten`} onClick={() => setEditing(r)}>
                <Pencil size={16} />
              </button>
              <button
                className="btn btn-ghost btn-icon"
                aria-label={`${r.name} löschen`}
                onClick={() => window.confirm(`Rolle „${r.name}“ löschen? Offene Aufgaben dieser Rolle gehen an alle.`) && remove.mutate(r.id)}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={creating} title="Rolle anlegen" onClose={() => setCreating(false)}>
        <RoleForm pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
      <Modal open={!!editing} title="Rolle bearbeiten" onClose={() => setEditing(null)}>
        {editing && <RoleForm initial={editing} pending={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Modal>
    </Card>
  );
}
