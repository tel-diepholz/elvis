import { useMutation, useQuery } from '@tanstack/react-query';
import { BadgeCheck, CircleSlash, UserRoundCog } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { Loading } from '../ui';

/** Rolle der Sitzung wählen – nach der Anmeldung und über das Profilmenü. */
export function RoleDialog({ onDone }: { onDone: () => void }) {
  const { role: current, roleChosen, refresh } = useAuth();
  const toast = useToast();
  const { data: roles, isLoading } = useQuery({ queryKey: ['roles'], queryFn: api.roles });

  const choose = useMutation({
    mutationFn: api.chooseRole,
    onSuccess: async ({ role }) => {
      await refresh();
      toast('success', role ? `Rolle „${role.name}“ übernommen` : 'Ohne Rolle angemeldet');
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });

  if (isLoading || !roles) return <Loading />;

  return (
    <div className="role-picker">
      <p className="muted">Aufgaben für Ihre Rolle erscheinen unter „Meine Aufgaben“. Ist eine Rolle von niemandem besetzt, sehen alle ihre Aufgaben.</p>
      <ul className="role-list">
        {roles.map((r) => {
          const active = roleChosen && current?.id === r.id;
          return (
            <li key={r.id}>
              <button type="button" className={`role-option ${active ? 'active' : ''}`} disabled={choose.isPending} onClick={() => choose.mutate(r.id)}>
                {active ? <BadgeCheck size={22} /> : <UserRoundCog size={22} />}
                <span className="role-option-main">
                  <strong>{r.name}</strong>
                  {r.description && <span className="cell-sub">{r.description}</span>}
                </span>
                <span className="role-option-holders cell-sub">{r.holders.length ? r.holders.join(', ') : 'unbesetzt'}</span>
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className={`role-option ${roleChosen && !current ? 'active' : ''}`} disabled={choose.isPending} onClick={() => choose.mutate(null)}>
            <CircleSlash size={22} />
            <span className="role-option-main">
              <strong>Ohne Rolle</strong>
              <span className="cell-sub">Nur Aufgaben für alle und eigene Aufgaben</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  );
}
