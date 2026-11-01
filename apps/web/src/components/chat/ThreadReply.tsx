import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag, MapPin, Send, Truck, X } from 'lucide-react';
import {
  CHAT_TEXT_MAX,
  SMS_MAX_LENGTH,
  formatPhone,
  isMobileNumber,
  smsParts,
  type ChatAttachment,
  type ChatChannel,
  type ChatLocation,
  type ChatMessage,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useActiveIncident } from '../../lib/hooks';
import { useDevice } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { ChannelIcon } from './ChannelIcon';
import { AttachmentChip, DocumentAttachButton, attachmentProblem } from './DocumentAttach';

export interface ReplyTarget {
  /** Rufnummern, die zuletzt genutzte zuerst; leer = nur Kennung im Kanal */
  numbers: string[];
  /** Kennung im Kanal ohne Rufnummer (z. B. Threema-ID) samt Kanal */
  peer: { channel: ChatChannel; id: string } | null;
  /** Bezeichnung je Rufnummer, z. B. „Mobil“ */
  labels?: Record<string, string>;
}

/**
 * Antwortzeile unter dem Verlauf: Text, Messenger (vorgewählt: zuletzt genutzter, sonst der erste erreichbare),
 * bei mehreren Rufnummern die Nummer, dazu Bild und Standort. Enter sendet, Umschalt+Enter macht eine neue Zeile.
 */
export function ThreadReply({ target, lastChannel, preset, onSent }: { target: ReplyTarget; lastChannel: ChatChannel | null; preset?: ChatChannel | null; onSent: (m: ChatMessage[]) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: avail } = useQuery({ queryKey: ['chat', 'available'], queryFn: api.chatAvailable });
  const { data: reach = {} } = useQuery({ queryKey: ['chat', 'reachability'], queryFn: api.chatReachability });
  const { data: waWindow = {} } = useQuery({ queryKey: ['chat', 'whatsappWindow'], queryFn: api.whatsappWindow });
  const { data: incident } = useActiveIncident();
  const vehicle = useDevice('weather')?.state.position ?? null;
  const [number, setNumber] = useState<string | null>(target.numbers[0] ?? null);
  const [chosen, setChosen] = useState<ChatChannel | null>(null);
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [location, setLocation] = useState<ChatLocation | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Anderes Gespräch: alles zurücksetzen
  const targetKey = `${target.numbers.join(',')}|${target.peer?.channel}:${target.peer?.id}`;
  useEffect(() => {
    setNumber(target.numbers[0] ?? null);
    setChosen(null);
    setText('');
    setAttachment(null);
    setLocation(null);
    textRef.current?.focus();
  }, [targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const channels = (avail?.channels ?? []).filter((c) => c.available);
  // Ohne Rufnummer nur der Kanal der Kennung; SMS und WhatsApp brauchen eine Rufnummer
  const options = target.peer && !number ? channels.filter((c) => c.channel === target.peer!.channel) : channels;
  const reachable = number ? (reach[number] ?? []) : [];
  const fallback = number && isMobileNumber(number) && options.some((o) => o.channel === 'sms') ? 'sms' : (options[0]?.channel ?? null);
  const pick = (c: ChatChannel | null | undefined) => (c && options.some((o) => o.channel === c) ? c : null);
  const channel = pick(chosen) ?? pick(preset) ?? pick(lastChannel) ?? pick(reachable[0]) ?? fallback;
  const info = options.find((o) => o.channel === channel);
  const isSms = channel === 'sms';
  const max = isSms ? SMS_MAX_LENGTH : CHAT_TEXT_MAX;
  const count = smsParts(text);
  const outsideWindow = channel === 'whatsapp' && info?.window24h && number && !waWindow[number];

  const send = useMutation({
    mutationFn: () =>
      api.sendChat({
        to: [{ channel: channel!, to: number ?? target.peer!.id }],
        text,
        attachmentId: attachment?.id ?? null,
        location,
        ...(isSms && avail?.defaultPort != null && { port: avail.defaultPort }),
      }),
    onSuccess: (r) => {
      setText('');
      setAttachment(null);
      setLocation(null);
      void qc.invalidateQueries({ queryKey: ['chat'] });
      onSent(r);
      textRef.current?.focus();
    },
    onError: (e) => toast('error', e.message),
  });

  const problem = !channel
    ? 'Kein Kanal verfügbar'
    : !text.trim() && !attachment && !location
      ? null
      : text.length > max
        ? `Höchstens ${max} Zeichen`
        : info
          ? attachmentProblem(attachment, [info])
          : null;
  const ready = !!channel && !problem && (!!text.trim() || !!attachment || !!location) && !send.isPending;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (ready) send.mutate();
    }
  };
  const incidentPos = incident?.lat != null && incident.lon != null ? { lat: incident.lat, lon: incident.lon } : null;

  return (
    <div className="thread-reply">
      <div className="thread-reply-bar">
        {channel && <ChannelIcon channel={channel} size={18} />}
        <select aria-label="Messenger" value={channel ?? ''} onChange={(e) => setChosen(e.target.value as ChatChannel)} disabled={options.length === 0}>
          {options.length === 0 && <option value="">kein Kanal</option>}
          {options.map((o) => (
            <option key={o.channel} value={o.channel}>
              {o.label}
              {reachable.includes(o.channel) ? ' ✓' : ''}
              {o.status !== 'connected' ? ' (gestört)' : ''}
            </option>
          ))}
        </select>
        {target.numbers.length > 1 && (
          <select aria-label="Rufnummer" value={number ?? ''} onChange={(e) => setNumber(e.target.value)}>
            {target.numbers.map((n) => (
              <option key={n} value={n}>
                {formatPhone(n)}
                {target.labels?.[n] ? ` (${target.labels[n]})` : ''}
              </option>
            ))}
          </select>
        )}
        <span className="thread-reply-hint muted small">
          {isSms && text ? `${count.length} Zeichen · ${count.parts} ${count.parts === 1 ? 'SMS' : 'Teile'}` : ''}
          {outsideWindow ? 'über 24 h ohne Nachricht: geht als Vorlage' : ''}
          {problem && <span className="tone-alarm"> {problem}</span>}
        </span>
      </div>
      {(attachment || location) && (
        <div className="chat-extras">
          {attachment && <AttachmentChip attachment={attachment} onRemove={() => setAttachment(null)} />}
          {location && (
            <span className="chat-chip">
              <MapPin size={14} />
              {location.label || `${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`}
              {isSms && <span className="muted"> (als Kartenlink)</span>}
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Standort entfernen" onClick={() => setLocation(null)}>
                <X size={14} />
              </button>
            </span>
          )}
        </div>
      )}
      <div className="thread-reply-input">
        <textarea
          ref={textRef}
          rows={2}
          value={text}
          maxLength={max}
          placeholder={channel ? `Nachricht per ${info?.label ?? channel} …` : 'Kein Kanal verfügbar'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!channel}
        />
        <div className="thread-reply-actions">
          <DocumentAttachButton compact disabledReason={info && !info.images && !info.files ? `Anhänge gehen nicht per ${info.label}` : null} onAttached={setAttachment} />
          {incidentPos && (
            <button type="button" className="btn btn-ghost btn-icon" title="Einsatzort anhängen" aria-label="Einsatzort anhängen" onClick={() => setLocation({ ...incidentPos, label: 'Einsatzort' })}>
              <Flag size={18} />
            </button>
          )}
          {vehicle && (
            <button type="button" className="btn btn-ghost btn-icon" title="Fahrzeugstandort anhängen" aria-label="Fahrzeugstandort anhängen" onClick={() => setLocation({ lat: vehicle.lat, lon: vehicle.lon, label: 'Fahrzeugstandort' })}>
              <Truck size={18} />
            </button>
          )}
          <button type="button" className="btn btn-primary btn-icon" title="Senden (Enter)" aria-label="Senden" disabled={!ready} onClick={() => send.mutate()}>
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
