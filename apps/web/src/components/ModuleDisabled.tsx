import { PlugZap } from 'lucide-react';
import type { DeviceId } from '@elvis/shared';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useLive } from '../lib/live';
import { EmptyState, Loading } from './ui';

/** Platzhalter, wenn ein Fahrzeugmodul deaktiviert ist (bzw. die Verbindung noch aufgebaut wird). */
export function ModuleDisabled({ name, module }: { name: string; module?: DeviceId }) {
  const { connection } = useLive();
  const admin = !!useAuth().user?.isAdmin;
  if (connection === 'connecting') return <Loading />;
  return (
    <EmptyState icon={<PlugZap size={32} />} title={`${name} ist nicht aktiviert`}>
      {admin ? (
        <>
          Unter <Link to={`/einstellungen${module ? `#modul-${module}` : ''}`}>Einstellungen → Fahrzeugmodule</Link> aktivieren und den Treiber einstellen.
        </>
      ) : (
        'Ein Admin kann das Modul in den Einstellungen aktivieren.'
      )}
    </EmptyState>
  );
}
