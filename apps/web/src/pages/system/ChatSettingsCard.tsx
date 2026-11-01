import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MessagesSquare } from 'lucide-react';
import { CHAT_CHANNEL_LABEL, type ChatChannel } from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Card, Loading } from '../../components/ui';
import { ChannelIcon } from '../../components/chat/ChannelIcon';

/** Reihenfolge der Kanäle: eine neue Nachricht geht über den ersten, über den der Empfänger erreichbar ist. Nur Admins. */
export function ChatSettingsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['chat', 'settings'], queryFn: api.chatSettings });
  const { data: avail } = useQuery({ queryKey: ['chat', 'available'], queryFn: api.chatAvailable });
  const [order, setOrder] = useState<ChatChannel[] | null>(null);
  useEffect(() => {
    if (data) setOrder(data.order);
  }, [data]);
  const save = useMutation({
    mutationFn: (o: ChatChannel[]) => api.updateChatSettings({ order: o }),
    onSuccess: () => (toast('success', 'Reihenfolge gespeichert'), void qc.invalidateQueries({ queryKey: ['chat'] })),
    onError: (e) => toast('error', e.message),
  });
  if (!order || !data) return <Loading />;
  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setOrder(next);
  };
  const changed = order.join() !== data.order.join();

  return (
    <Card title="Nachrichten" icon={<MessagesSquare size={18} />} className="span-3">
      <p className="muted">
        Eine neue Nachricht geht über den ersten Kanal, über den der Empfänger erreichbar ist; im Feld „An“ lässt sich der Kanal je Empfänger ändern. Signal, Threema
        und Telegram prüft ELVIS für die Mobilnummern der Kontakte, WhatsApp erst nach der ersten Nachricht. SMS erreichen jede Mobilnummer. Die Messenger sind eigene
        Fahrzeugmodule.
      </p>
      <ol className="chat-order">
        {order.map((c, i) => {
          const info = avail?.channels.find((x) => x.channel === c);
          return (
            <li key={c}>
              <ChannelIcon channel={c} />
              <span className="chat-order-name">
                {CHAT_CHANNEL_LABEL[c]}
                <span className="muted small"> · {info?.available ? (info.account ?? 'aktiv') : 'nicht aktiv'}</span>
              </span>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`${CHAT_CHANNEL_LABEL[c]} nach oben`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`${CHAT_CHANNEL_LABEL[c]} nach unten`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={!changed || save.isPending} onClick={() => save.mutate(order)}>
          Speichern
        </button>
      </div>
    </Card>
  );
}
