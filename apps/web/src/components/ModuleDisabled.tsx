import { PlugZap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useLive } from '../lib/live';
import { EmptyState, Loading } from './ui';

/** Platzhalter, wenn ein Fahrzeugmodul deaktiviert ist (bzw. die Verbindung noch aufgebaut wird). */
export function ModuleDisabled({ name }: { name: string }) {
  const { connection } = useLive();
  const admin = !!useAuth().user?.isAdmin;
  if (connection === 'connecting') return <Loading />;
  return (
    <EmptyState icon={<PlugZap size={32} />} title={`${name} ist nicht aktiviert`}>
      {admin ? (
        <>
          Unter <Link to="/system">System → Fahrzeugmodule</Link> aktivieren und den Treiber einstellen.
        </>
      ) : (
        'Ein Admin kann das Modul in den Systemeinstellungen aktivieren.'
      )}
    </EmptyState>
  );
}
