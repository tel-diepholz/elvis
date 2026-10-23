import { Gauge } from 'lucide-react';
import { Card, EmptyState, PageHeader } from '../components/ui';

/** Fahrzeugzustand – wird mit den ersten echten Fahrzeugmodulen neu aufgebaut. */
export function VehiclePage() {
  return (
    <>
      <PageHeader title="Fahrzeugzustand" subtitle="Daten der Fahrzeugsysteme" />
      <Card>
        <EmptyState icon={<Gauge size={40} />} title="Noch keine Fahrzeugmodule">
          <p>Sobald Fahrzeugsysteme angebunden sind, erscheinen ihre Daten und Bedienelemente hier.</p>
        </EmptyState>
      </Card>
    </>
  );
}
