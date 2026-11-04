import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Send } from 'lucide-react';
import { MESSAGING_STATE_LABEL, VEHICLE_CONTACT_KIND_LABEL, vehicleLabel, type MessagingConversation, type MessagingPeer } from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Badge, EmptyState, Field, Loading } from '../ui';
import { RegionPicker } from './RegionPicker';

/** Kontaktdaten der Gegenseite (Telefon als Link) */
export function PeerContacts({ peer }: { peer: MessagingPeer }) {
  if (!peer.vehicle.contacts.length) return null;
  return (
    <span className="messaging-contacts small">
      {peer.vehicle.contacts.map((c, i) => (
        <span key={i} className="messaging-contact">
          {c.label || VEHICLE_CONTACT_KIND_LABEL[c.kind]}: <a href={c.kind === 'phone' ? `tel:${c.value.replace(/[^\d+]/g, '')}` : `mailto:${c.value}`}>{c.value}</a>
        </span>
      ))}
    </span>
  );
}

/**
 * Fahrzeug anschreiben: im Verzeichnis nach Name, Funkrufname oder Organisation suchen, optional auf eine
 * Gebietskörperschaft eingrenzen (alles darunter zählt mit) und einen Chat anfragen.
 */
export function VehicleSearch({ conversations, onOpen }: { conversations: MessagingConversation[]; onOpen: (c: MessagingConversation) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('');
  const [regionLabel, setRegionLabel] = useState('Deutschland');
  const [showRegion, setShowRegion] = useState(false);
  const term = q.trim();
  const { data: hits, isFetching, error } = useQuery({
    queryKey: ['messaging', 'directory', term, region],
    queryFn: () => api.messagingDirectory(term, region),
    enabled: term.length >= 2 || region !== '',
  });
  const request = useMutation({
    mutationFn: (elwId: string) => api.messagingRequest(elwId),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['messaging'] });
      toast('success', c.state === 'accepted' ? 'Chat ist bereits verbunden' : `Anfrage an ${vehicleLabel(c.peer.vehicle)} gesendet`);
      onOpen(c);
    },
    onError: (e) => toast('error', e.message),
  });
  const open = (elwId: string) => conversations.find((c) => c.peer.elwId === elwId && (c.state === 'requested' || c.state === 'accepted'));

  return (
    <div className="vehicle-search">
      <div className="region-search">
        <Search size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Fahrzeug, Funkrufname oder Organisation" aria-label="Fahrzeug suchen" autoFocus />
      </div>
      <div className="vehicle-search-region">
        <span className="muted small">Gebiet: {regionLabel}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowRegion((v) => !v)}>
          {showRegion ? 'Fertig' : 'Eingrenzen'}
        </button>
      </div>
      {showRegion && (
        <Field label="Gebietskörperschaft">
          <RegionPicker
            value={region}
            onChange={(ars, label) => {
              setRegion(ars);
              setRegionLabel(label);
            }}
          />
        </Field>
      )}
      {error ? (
        <p className="tone-alarm">{error.message}</p>
      ) : !hits ? (
        isFetching ? <Loading /> : <p className="muted">Mindestens zwei Zeichen eingeben oder ein Gebiet wählen.</p>
      ) : hits.length === 0 ? (
        <EmptyState title="Kein Fahrzeug gefunden">Nur Installationen, die im Verzeichnis sichtbar sind, erscheinen hier.</EmptyState>
      ) : (
        <ul className="vehicle-hits">
          {hits.map((p) => {
            const existing = open(p.elwId);
            return (
              <li key={p.elwId} className="vehicle-hit">
                <div>
                  <strong>{vehicleLabel(p.vehicle)}</strong>
                  <span className="muted small">
                    {p.vehicle.organization} · {p.regionLabel}
                  </span>
                  <PeerContacts peer={p} />
                </div>
                {existing ? (
                  <button type="button" className="btn btn-sm" onClick={() => onOpen(existing)}>
                    <Badge tone={existing.state === 'accepted' ? 'ok' : 'info'}>{MESSAGING_STATE_LABEL[existing.state]}</Badge> Öffnen
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" disabled={request.isPending} onClick={() => request.mutate(p.elwId)}>
                    <Send size={14} /> Chat anfragen
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
