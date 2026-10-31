import { History, Radio } from 'lucide-react';
import { useDevice } from '../lib/live';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { Badge, Card, PageHeader } from '../components/ui';
import { RadioTable } from './funk/RadioTable';
import { RadioTimeline } from './funk/RadioTimeline';

export function FunkPage() {
  const radio = useDevice('radio');

  if (!radio)
    return (
      <>
        <PageHeader title="Funk" subtitle="Funkverkehr und Funkgeräte" />
        <ModuleDisabled name="Funk" module="radio" />
      </>
    );

  const { link, devices, activity } = radio.state;
  const linkBadge = link ? (
    <Badge tone={link.connected ? 'ok' : 'alarm'}>
      {link.connected ? `Verbunden mit ${link.target}` : `Keine Verbindung zu ${link.target}${link.error ? ` (${link.error})` : ''}`}
    </Badge>
  ) : (
    <Badge tone="info">Simulation</Badge>
  );

  return (
    <>
      <PageHeader title="Funk" subtitle="Funkverkehr und Funkgeräte" actions={linkBadge} />
      <div className="grid">
        <Card title="Funkverkehr" icon={<History size={18} />} className="span-3">
          <RadioTimeline devices={devices} live={activity} />
        </Card>
        <Card title="Funkgeräte" icon={<Radio size={18} />} className="span-3">
          <RadioTable radio={radio} />
        </Card>
      </div>
    </>
  );
}
