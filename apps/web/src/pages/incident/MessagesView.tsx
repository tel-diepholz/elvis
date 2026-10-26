import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Inbox, Mail, Plus, Search } from 'lucide-react';
import { messageNeedsAttention, type Incident, type Message, type MessageDirection, type MessageInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Card, EmptyState, Loading, Modal, Segmented } from '../../components/ui';
import { MessageDialog } from '../../components/messages/MessageDialog';
import { MessageForm } from '../../components/messages/MessageForm';
import { MessageParties, MessageStatus, SnoozeNote } from '../../components/messages/MessageParts';
import { PENDING_LABEL, useMessages } from '../../components/messages/messageHooks';
import { highlight, matchesSearch, searchSnippet, searchTerms } from '../../components/messages/search';

type Filter = 'mine' | 'open' | 'all';
type Direction = 'both' | MessageDirection;

function MessageRow({ message: m, now, terms, onOpen }: { message: Message; now: Date; terms: string[]; onOpen: () => void }) {
  const attention = messageNeedsAttention(m, now);
  const snippet = searchSnippet(m, terms);
  return (
    <li className={`message-item ${attention ? 'message-attention' : ''} ${m.doneAt ? 'message-done' : ''}`}>
      <button type="button" className="message-item-main" onClick={onOpen}>
        <div className="message-item-head">
          <MessageParties message={m} />
          <span className="message-time">{fmtTime(m.createdAt)}</span>
        </div>
        <div className="message-preview">
          {snippet.label && <span className="message-preview-label">{snippet.label}: </span>}
          {highlight(snippet.text, terms)}
        </div>
        <div className="message-item-foot">
          <MessageStatus message={m} />
          {attention && <span className="tone-alarm">{PENDING_LABEL[m.pending!]}</span>}
          <SnoozeNote message={m} />
          <span className="cell-sub">von {m.createdBy}</span>
        </div>
      </button>
    </li>
  );
}

/** Meldungen im Einsatz: Ausgang (Stab → Kräfte) und Eingang (Kräfte → Stab) */
export function MessagesView({ incident }: { incident: Incident }) {
  const toast = useToast();
  const now = useNow();
  const { data: messages, isLoading } = useMessages(incident);
  const [filter, setFilter] = useState<Filter>('mine');
  const [direction, setDirection] = useState<Direction>('both');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  const create = useMutation({
    mutationFn: (input: MessageInput) => api.createMessage(incident.id, input),
    onSuccess: () => (setCreating(false), toast('success', 'Meldung erstellt')),
    onError: (e) => toast('error', e.message),
  });

  if (isLoading || !messages) return <Loading />;

  const byDirection = messages.filter((m) => direction === 'both' || m.direction === direction);
  const lists: Record<Filter, Message[]> = {
    mine: byDirection.filter((m) => m.mine),
    open: byDirection.filter((m) => !m.doneAt || m.pending !== null),
    all: byDirection,
  };
  const terms = searchTerms(query);
  // Eine Suche geht immer über alle Meldungen der gewählten Richtung
  const shown = terms.length ? byDirection.filter((m) => matchesSearch(m, terms)) : lists[filter];
  const attention = messages.filter((m) => messageNeedsAttention(m, now)).length;

  return (
    <>
      <Card
        title={attention ? `${attention} zu bearbeiten` : 'Meldungen'}
        icon={<Mail size={18} />}
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus size={16} /> Meldung
          </button>
        }
      >
        <div className="message-filters">
          <label className="search-field message-search">
            <Search size={16} />
            <input type="search" placeholder="Volltextsuche …" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Meldungen durchsuchen" />
          </label>
          <Segmented<Filter>
            label="Filter"
            value={filter}
            onChange={setFilter}
            disabled={terms.length > 0}
            options={[
              { value: 'mine', label: `Für mich (${lists.mine.length})` },
              { value: 'open', label: `Offen (${lists.open.length})` },
              { value: 'all', label: `Alle (${lists.all.length})` },
            ]}
          />
          <Segmented<Direction>
            label="Richtung"
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'both', label: 'Alle' },
              { value: 'out', label: 'Ausgang' },
              { value: 'in', label: 'Eingang' },
            ]}
          />
        </div>
        {terms.length > 0 && (
          <p className="cell-sub">
            {shown.length} Treffer in allen Meldungen{direction !== 'both' && (direction === 'out' ? ' (Ausgang)' : ' (Eingang)')}
          </p>
        )}
        {shown.length === 0 ? (
          <EmptyState icon={<Inbox size={36} />} title={terms.length ? 'Keine Treffer' : filter === 'mine' ? 'Keine Meldungen für Ihre Rollen' : 'Keine Meldungen'} />
        ) : (
          <ul className="message-list">
            {shown.map((m) => (
              <MessageRow key={m.id} message={m} now={now} terms={terms} onOpen={() => setOpenId(m.id)} />
            ))}
          </ul>
        )}
      </Card>

      <Modal open={creating} title="Neue Meldung" onClose={() => setCreating(false)} wide>
        <MessageForm incidentId={incident.id} pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
      <MessageDialog incident={incident} messageId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
