import type { UplinkKind } from '@elvis/shared';

export const UPLINK_KIND: Record<UplinkKind, string> = {
  '5g': '5G',
  lte: 'LTE',
  sat: 'SAT',
  wan: 'WAN',
};
