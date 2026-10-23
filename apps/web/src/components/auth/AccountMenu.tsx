import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, LogIn, LogOut, ShieldCheck, UserRound, Users } from 'lucide-react';
import { fullName } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { Modal } from '../ui';
import { LoginDialog } from './LoginDialog';
import { ChangePinForm, UserCreateForm } from './UserForms';

type View = 'menu' | 'login' | 'pin' | null;

/** Kopfzeile: anmelden, Benutzer wechseln, PIN ändern, abmelden – plus erzwungene Ersteinrichtung. */
export function AccountMenu() {
  const { user, hasUsers, loading, refresh } = useAuth();
  const toast = useToast();
  const [view, setView] = useState<View>(null);

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
          <span className="desktop-only">{fullName(user)}</span>
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

      {/* Allererster Start: ohne Benutzer geht es erst nach dem Anlegen des Admins weiter. */}
      <Modal open={!loading && !hasUsers} title="Ersteinrichtung" onClose={() => undefined} dismissible={false}>
        <UserCreateForm mode="setup" onDone={() => undefined} />
      </Modal>
    </>
  );
}
