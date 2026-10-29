import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Square, SquareCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { Loading } from '../ui';

/** Rollen der Sitzung wählen (beliebig viele, auch keine) – nach der Anmeldung und über das Profilmenü. */
export function RoleDialog({ onDone }: { onDone: () => void }) {
  const { roles: current, roleChosen, lastRoleIds, refresh } = useAuth();
  const toast = useToast();
  const { data: roles, isLoading } = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const [selected, setSelected] = useState(() => new Set(roleChosen ? current.map((r) => r.id) : lastRoleIds));

  const choose = useMutation({
    mutationFn: api.chooseRoles,
    onSuccess: async ({ roles }) => {
      await refresh();
      toast('success', roles.length ? `Rollen übernommen: ${roles.map((r) => r.name).join(', ')}` : 'Ohne Rolle angemeldet');
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });

  if (isLoading || !roles) return <Loading />;

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="role-picker">
      <p className="muted">Sie können mehrere Rollen übernehmen. Aufgaben für Ihre Rollen erscheinen unter „Meine Aufgaben“. Ist eine Rolle von niemandem besetzt, sehen alle ihre Aufgaben.</p>
      <ul className="role-list">
        {roles.map((r) => {
          const active = selected.has(r.id);
          return (
            <li key={r.id}>
              <button type="button" className={`role-option ${active ? 'active' : ''}`} aria-pressed={active} disabled={choose.isPending} onClick={() => toggle(r.id)}>
                {active ? <SquareCheck size={22} /> : <Square size={22} />}
                <span className="role-option-main">
                  <strong>{r.name}</strong>
                  {r.description && <span className="cell-sub">{r.description}</span>}
                </span>
                <span className="role-option-holders cell-sub">{r.holders.length ? r.holders.join(', ') : 'unbesetzt'}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-primary" disabled={choose.isPending} onClick={() => choose.mutate(roles.filter((r) => selected.has(r.id)).map((r) => r.id))}>
        <Check size={18} /> {selected.size ? `${selected.size === 1 ? 'Rolle' : `${selected.size} Rollen`} übernehmen` : 'Ohne Rolle fortfahren'}
      </button>
    </div>
  );
}
