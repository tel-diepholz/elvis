import { useState, type ReactNode } from 'react';
import { Eye, Lock } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { EmptyState, Loading, Modal } from '../ui';
import { LoginDialog } from './LoginDialog';

export function LoginButton({ className = 'btn btn-primary', label = 'Anmelden' }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      <Modal open={open} title="Anmelden" onClose={() => setOpen(false)}>
        <LoginDialog onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

/** Bereiche, die eine Anmeldung bzw. Admin-Rechte erfordern. */
export function RequireLogin({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) {
    return (
      <EmptyState icon={<Lock size={40} />} title="Anmeldung erforderlich">
        <p>Ohne Anmeldung steht nur der Fahrzeugzustand zur Ansicht bereit.</p>
        <LoginButton />
      </EmptyState>
    );
  }
  if (admin && !user.isAdmin) return <EmptyState icon={<Lock size={40} />} title="Nur für Admins" />;
  return <>{children}</>;
}

/**
 * Ohne Anmeldung nur ansehen: ein deaktiviertes fieldset sperrt alle Bedienelemente darin
 * (der Server lehnt Befehle ohne Anmeldung ohnehin ab).
 */
export function ViewOnlyUnlessLoggedIn({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <>
      {!user && (
        <div className="banner banner-info view-only">
          <Eye size={16} /> Nur Ansicht – zum Bedienen anmelden.
          <LoginButton className="btn btn-sm btn-primary" />
        </div>
      )}
      <fieldset className="view-only-fieldset" disabled={!user}>
        {children}
      </fieldset>
    </>
  );
}
