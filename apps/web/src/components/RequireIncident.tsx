import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { Incident } from '@elvis/shared';
import { useActiveIncident } from '../lib/hooks';
import { EmptyState, Loading } from './ui';
import { StartIncidentButton } from './StartIncidentButton';

/** Gate for incident-scoped areas (Tagebuch, Kräfte, Dokumente). */
export function RequireIncident({ children }: { children: (incident: Incident) => ReactNode }) {
  const { data: incident, isLoading } = useActiveIncident();
  if (isLoading) return <Loading />;
  if (!incident) {
    return (
      <EmptyState icon={<Lock size={40} />} title="Keine Lage aufgelegt">
        <p>Dieser Bereich steht erst zur Verfügung, wenn eine Lage im System angelegt wurde.</p>
        <StartIncidentButton />
      </EmptyState>
    );
  }
  return <>{children(incident)}</>;
}
