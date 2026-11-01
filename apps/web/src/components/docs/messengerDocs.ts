import type { MessengerId } from '@elvis/shared';
import signal from '../../../../../docs/fahrzeugmodule/signal-cli.md?raw';
import telegram from '../../../../../docs/fahrzeugmodule/telegram.md?raw';
import threema from '../../../../../docs/fahrzeugmodule/threema-gateway.md?raw';
import whatsapp from '../../../../../docs/fahrzeugmodule/whatsapp-cloud-api.md?raw';

/** Anleitungen der Messenger-Module aus docs/fahrzeugmodule (beim Bauen eingebunden) */
export const MESSENGER_DOCS: Record<MessengerId, { page: string; markdown: string }> = {
  signal: { page: 'fahrzeugmodule/signal-cli.md', markdown: signal },
  telegram: { page: 'fahrzeugmodule/telegram.md', markdown: telegram },
  threema: { page: 'fahrzeugmodule/threema-gateway.md', markdown: threema },
  whatsapp: { page: 'fahrzeugmodule/whatsapp-cloud-api.md', markdown: whatsapp },
};
