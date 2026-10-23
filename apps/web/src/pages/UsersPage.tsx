import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, Search, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { fullName, type User } from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { ChangePinForm, UserCreateForm, UserEditForm } from '../components/auth/UserForms';
import { Badge, Card, EmptyState, Loading, Modal, PageHeader } from '../components/ui';

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const { data: users, isLoading } = useQuery({ queryKey: ['users', 'list'], queryFn: api.users });
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [changingPin, setChangingPin] = useState(false);

  const remove = useMutation({
    mutationFn: (u: User) => api.deleteUser(u.id),
    onSuccess: (_, u) => toast('success', `${fullName(u)} gelöscht`),
    onError: (e) => toast('error', e.message),
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? []).filter((u) => !q || fullName(u).toLowerCase().includes(q));
  }, [users, query]);

  return (
    <>
      <PageHeader
        title="Benutzer"
        subtitle="Anmeldung per Namensauswahl und 4-stelliger PIN. Admins verwalten Benutzer, Addons und Docker-Hosts."
        actions={
          <>
            <button className="btn" onClick={() => setChangingPin(true)}>
              Eigene PIN ändern
            </button>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <UserPlus size={18} /> Benutzer anlegen
            </button>
          </>
        }
      />
      <Card title={`${users?.length ?? 0} Benutzer`} icon={<Users size={18} />}>
        <label className="search-field">
          <Search size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Suchen …" aria-label="Benutzer suchen" />
        </label>
        {isLoading ? (
          <Loading />
        ) : !filtered.length ? (
          <EmptyState title="Keine Benutzer gefunden" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Rolle</th>
                  <th>Letzte Anmeldung</th>
                  <th>Angelegt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => {
                  const canEdit = me?.isAdmin || me?.id === u.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="cell-title">
                          {u.firstName} {u.lastName}
                          {me?.id === u.id && <Badge tone="info">Sie</Badge>}
                        </div>
                      </td>
                      <td>{u.isAdmin ? <Badge tone="warn"><ShieldCheck size={12} /> Admin</Badge> : <span className="muted">Benutzer</span>}</td>
                      <td>{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : <span className="muted">noch nie</span>}</td>
                      <td>
                        {fmtDateTime(u.createdAt)}
                        <div className="cell-sub">von {u.createdBy}</div>
                      </td>
                      <td className="cell-actions">
                        {canEdit && (
                          <button className="btn btn-ghost btn-icon" onClick={() => setEditing(u)} aria-label={`${fullName(u)} bearbeiten`}>
                            <Pencil size={16} />
                          </button>
                        )}
                        {me?.isAdmin && me.id !== u.id && (
                          <button
                            className="btn btn-ghost btn-icon"
                            onClick={() => window.confirm(`${fullName(u)} löschen? Bestehende Einträge im Einsatztagebuch bleiben erhalten.`) && remove.mutate(u)}
                            aria-label={`${fullName(u)} löschen`}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={creating} title="Benutzer anlegen" onClose={() => setCreating(false)}>
        <UserCreateForm mode="create" onDone={() => setCreating(false)} />
      </Modal>
      <Modal open={!!editing} title={editing ? `${fullName(editing)} bearbeiten` : ''} onClose={() => setEditing(null)}>
        {editing && <UserEditForm target={editing} onDone={() => setEditing(null)} />}
      </Modal>
      <Modal open={changingPin} title="Eigene PIN ändern" onClose={() => setChangingPin(false)}>
        <ChangePinForm onDone={() => setChangingPin(false)} />
      </Modal>
    </>
  );
}
