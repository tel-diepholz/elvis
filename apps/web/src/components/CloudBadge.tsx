import { Cloud } from 'lucide-react';
import type { CloudOrigin } from '@elvis/shared';
import { Badge } from './ui';

/** Quelle: Cloud – gepflegt im Portal, hier nur lesbar */
export function CloudBadge({ cloud }: { cloud?: CloudOrigin | null }) {
  if (!cloud) return null;
  return (
    <span title={`Quelle: Cloud${cloud.name ? ` (${cloud.name})` : ''} – hier nur lesbar, Änderungen im Portal`}>
      <Badge tone="info">
        <Cloud size={12} /> Cloud
      </Badge>
    </span>
  );
}

/** Lokal änderbar (nur lokale Datensätze; die aus der Cloud pflegt das Portal) */
export const localEditable = (x: { cloud?: CloudOrigin | null }) => !x.cloud;
