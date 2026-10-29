import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound, LogIn, LogOut, ShieldCheck, UserRound, UserRoundCog, Users } from 'lucide-react';
import { fullName } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { Modal, Segmented } from '../ui';
import { LoginDialog } from './LoginDialog';
import { RestoreForm } from './RestoreForm';
import { RoleDialog } from './RoleDialog';
import { ChangePinForm, UserCreateForm } from './UserForms';

type View = 'menu' | 'login' | 'pin' | 'role' | null;

/** Kopfzeile: anmelden, Rollen wählen, Benutzer wechseln, PIN ändern, abmelden – plus erzwungene Ersteinrichtung und Rollenwahl. */
export function AccountMenu() {
  const { user, roles: myRoles, roleChosen, hasUsers, loading, refresh } = useAuth();
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: api.roles, enabled: !!user });
  const toast = useToast();
  const [view, setView] = useState<View>(null);
  const [setupMode, setSetupMode] = useState<'new' | 'restore'>('new');

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      await refresh();
      toast('success', 'Abgemeldet');
    },
  });

  const close = () => setView(null);

  return (
    <>
      {user ? (
        <button className="btn btn-ghost operator-btn" onClick={() => setView('menu')} title="Konto">
          {user.isAdmin ? <ShieldCheck size={18} /> : <UserRound size={18} />}
          <span className="desktop-only operator-name">
            {fullName(user)}
            {myRoles.length > 0 && <span className="operator-role">{myRoles.map((r) => r.name).join(', ')}</span>}
          </span>
        </button>
      ) : (
        <button className="btn btn-primary btn-sm login-btn" onClick={() => setView('login')}>
          <LogIn size={16} /> <span className="desktop-only">Anmelden</span>
        </button>
      )}

      <Modal open={view === 'login'} title="Anmelden" onClose={close}>
        <LoginDialog onDone={close} />
      </Modal>

      <Modal open={view === 'menu' && !!user} title={user ? fullName(user) : ''} onClose={close}>
        {user && (
          <div className="account-menu">
            <p className="muted">{user.isAdmin ? 'Admin' : 'Benutzer'} · Einträge und Bedienaktionen werden unter diesem Namen protokolliert.</p>
            {!!roles?.length && (
              <button className="btn" onClick={() => setView('role')}>
                <UserRoundCog size={18} /> Rollen wählen <span className="muted">({myRoles.length ? myRoles.map((r) => r.name).join(', ') : 'ohne Rolle'})</span>
              </button>
            )}
            <button
              className="btn"
              onClick={async () => {
                await logout.mutateAsync();
                setView('login');
              }}
            >
              <Users size={18} /> Benutzer wechseln
            </button>
            <button className="btn" onClick={() => setView('pin')}>
              <KeyRound size={18} /> PIN ändern
            </button>
            <button className="btn btn-danger" onClick={() => (logout.mutate(), close())}>
              <LogOut size={18} /> Abmelden
            </button>
          </div>
        )}
      </Modal>

      <Modal open={view === 'pin'} title="Eigene PIN ändern" onClose={close}>
        <ChangePinForm onDone={close} />
      </Modal>

      <Modal open={view === 'role'} title="Rollen wählen" onClose={close}>
        <RoleDialog onDone={close} />
      </Modal>

      {/* Direkt nach der Anmeldung: welche Rollen übernimmt der Benutzer im Einsatz? */}
      <Modal open={!!user && !roleChosen && !!roles?.length && view === null} title="Welche Rollen übernehmen Sie?" onClose={() => undefined} dismissible={false}>
        <RoleDialog onDone={() => undefined} />
      </Modal>

      {/* Allererster Start: ohne Benutzer geht es erst nach dem Anlegen des Admins weiter. */}
      <Modal open={!loading && !hasUsers} title="Ersteinrichtung" onClose={() => undefined} dismissible={false}>
        <Segmented
          label="Art der Einrichtung"
          value={setupMode}
          onChange={setSetupMode}
          options={[
            { value: 'new', label: 'Neu einrichten' },
            { value: 'restore', label: 'Aus Backup wiederherstellen' },
          ]}
        />
        {setupMode === 'new' ? <UserCreateForm mode="setup" onDone={() => undefined} /> : <RestoreForm />}
      </Modal>
    </>
  );
}
