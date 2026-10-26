import { useQuery } from '@tanstack/react-query';
import { messageNeedsAttention, type Incident, type Message, type MessageContext, type MessagePending } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useActiveIncident } from '../../lib/hooks';

export const MESSAGES_PATH = '/einsatz/meldungen';

export function useMessages(incident: Incident | null | undefined) {
  const { user } = useAuth();
  return useQuery({ queryKey: ['messages', incident?.id ?? 0], queryFn: () => api.messages(incident!.id), enabled: !!user && !!incident && !incident.closedAt });
}

/** Eigene Rollen als Fernmelder/Dispatcher und ob ein Dispatcher angemeldet ist */
export function useMessageContext() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['messages', 'context'], queryFn: api.messageContext, enabled: !!user });
}

/** Meldungen im laufenden Einsatz, um die sich der angemeldete Benutzer jetzt kümmern soll */
export function useMessageAttention(now: Date): { incident: Incident | null; messages: Message[]; attention: Message[] } {
  const { data: incident } = useActiveIncident();
  const { data: messages = [] } = useMessages(incident);
  // älteste zuerst
  const attention = messages.filter((m) => messageNeedsAttention(m, now)).sort((a, b) => a.id - b.id);
  return { incident: incident ?? null, messages, attention };
}

export const PENDING_LABEL: Record<MessagePending, string> = {
  radio: 'Ausgangsmeldung übermitteln',
  dispatch: 'Eingangsmeldung verteilen',
  recipient: 'Neue Meldung',
  reply: 'Antwort eingegangen',
  copy: 'Meldung in Kopie',
};

/** Bearbeitet der Benutzer die Meldung als Fernmelder bzw. Dispatcher (solange sie bei diesen liegt)? */
export function canHandle(m: Message, ctx: MessageContext | undefined): boolean {
  if (!ctx || m.doneAt) return false;
  if (m.direction === 'out') return ctx.radio;
  if (m.recipient !== null) return false;
  return ctx.dispatcherPresent ? ctx.dispatcher : ctx.radio;
}
