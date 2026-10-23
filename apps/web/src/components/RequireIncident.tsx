import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import type { Incident } from '@elvis/shared';
import { useActiveIncident } from '../lib/hooks';
import { EmptyState, Loading } from './ui';

/** Gate for incident-scoped areas (Tagebuch, Kräfte, Dokumente). */
export function RequireIncident({ children }: { children: (incident: Incident) => ReactNode }) {
  const { data: incident, isLoading } = useActiveIncident();
  if (isLoading) return <Loading />;
  if (!incident) {
    return (
      <EmptyState icon={<Lock size={40} />} title="Kein Einsatz aufgelegt">
        <p>Dieser Bereich steht erst zur Verfügung, wenn ein Einsatz im System angelegt wurde.</p>
        <Link to="/einsatz" className="btn btn-primary">
          Einsatz anlegen
        </Link>
      </EmptyState>
    );
  }
  return <>{children(incident)}</>;
}
