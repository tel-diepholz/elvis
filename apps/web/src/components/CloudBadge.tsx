import { Cloud, Lock } from 'lucide-react';
import type { CloudOrigin } from '@elvis/shared';
import { Badge } from './ui';

/** Herkunft beim Cloud-Abgleich: eigene (hier änderbar) oder von einem anderen Bereich (nur lesbar) */
export function CloudBadge({ cloud }: { cloud?: CloudOrigin | null }) {
  if (!cloud) return null;
  return cloud.editable ? (
    <span title="Abgeglichen mit der Cloud">
      <Badge tone="info">
        <Cloud size={12} /> Cloud
      </Badge>
    </span>
  ) : (
    <span title={`Gepflegt von ${cloud.name} in der Cloud – hier nur lesbar`}>
      <Badge>
        <Lock size={12} /> {cloud.name}
      </Badge>
    </span>
  );
}

/** Lokal änderbar (nur lokal oder vom eigenen Bereich) */
export const localEditable = (x: { cloud?: CloudOrigin | null }) => !x.cloud || x.cloud.editable;
