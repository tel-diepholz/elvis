import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, RadioTower, X } from 'lucide-react';
import { crewLabel, vehicleLabel, type MessagingConversation } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { beep } from '../messages/MessageAlerts';
import { PeerContacts } from './VehicleSearch';

/**
 * Eingehende Chat-Anfragen anderer Fahrzeuge (Cloud Messaging) unten links für alle Angemeldeten, mit Ton.
 * „Annehmen“ öffnet den Fahrzeug-Chat; die Gegenseite sieht danach Name und Rolle der Angemeldeten hier.
 */
export function ChatRequestPanel() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const { data: status } = useQuery({ queryKey: ['messaging', 'status'], queryFn: api.messagingStatus, enabled: !!user });
  const { data: conversations = [] } = useQuery({ queryKey: ['messaging', 'conversations'], queryFn: api.messagingConversations, enabled: !!user && !!status?.registered });
  const pending = conversations.filter((c) => c.direction === 'in' && c.state === 'requested');

  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const fresh = pending.filter((c) => !seen.current?.has(c.id));
    if (seen.current && fresh.length) {
      beep();
      setCollapsed(false);
    }
    seen.current = new Set(pending.map((c) => c.id));
  }, [pending.map((c) => c.id).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = useMutation({
    mutationFn: ({ c, action }: { c: MessagingConversation; action: 'accept' | 'decline' }) => api.messagingDecide(c.id, action),
    onSuccess: (c, { action }) => {
      void qc.invalidateQueries({ queryKey: ['messaging'] });
      void qc.invalidateQueries({ queryKey: ['chat'] });
      if (action === 'accept') navigate(`/nachrichten?t=${encodeURIComponent(c.threadKey)}`);
      else toast('success', `Anfrage von ${vehicleLabel(c.peer.vehicle)} abgelehnt`);
    },
    onError: (e) => toast('error', e.message),
  });

  if (!pending.length) return null;
  if (collapsed) {
    return (
      <button className="due-panel due-panel-collapsed" onClick={() => setCollapsed(false)}>
        <RadioTower size={18} /> {pending.length} {pending.length === 1 ? 'Chat-Anfrage' : 'Chat-Anfragen'}
      </button>
    );
  }
  return (
    <section className="due-panel" role="alert" aria-label="Chat-Anfragen anderer Fahrzeuge">
      <header className="due-panel-head">
        <RadioTower size={18} />
        <strong>{pending.length === 1 ? 'Chat-Anfrage' : `${pending.length} Chat-Anfragen`}</strong>
        <button className="btn btn-ghost btn-icon" onClick={() => setCollapsed(true)} aria-label="Einklappen">
          <ChevronDown size={18} />
        </button>
      </header>
      <ul className="due-list">
        {pending.slice(0, 3).map((c) => (
          <li key={c.id} className="chat-request">
            <span className="due-summary">
              {c.requestedBy ? crewLabel(c.requestedBy) : 'Jemand'} möchte einen Chat aufbauen
            </span>
            <span className="cell-sub">
              {vehicleLabel(c.peer.vehicle)} · {c.peer.vehicle.organization}
            </span>
            <span className="cell-sub muted">{c.peer.regionLabel}</span>
            <PeerContacts peer={c.peer} />
            <span className="btn-row">
              <button className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ c, action: 'accept' })}>
                <Check size={14} /> Annehmen
              </button>
              <button className="btn btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ c, action: 'decline' })}>
                <X size={14} /> Ablehnen
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
