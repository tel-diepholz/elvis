import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag, ImagePlus, MapPin, Truck, X } from 'lucide-react';
import {
  CHAT_CHANNEL_LABEL,
  CHAT_IMAGE_TYPES,
  CHAT_TEXT_MAX,
  SMS_MAX_LENGTH,
  formatPhone,
  isMobileNumber,
  looksLikePhone,
  phoneKey,
  smsParts,
  type ChatAttachment,
  type ChatChannel,
  type ChatChannelInfo,
  type ChatLocation,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useActiveIncident } from '../../lib/hooks';
import { useDevice } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { Field } from '../ui';
import { ChannelIcon } from './ChannelIcon';
import { NumberInput, splitNumbers } from './NumberInput';

export interface ChatDraftForm {
  to: string;
  text: string;
  /** Bevorzugter Kanal (z. B. Klick auf das Messenger-Symbol im Adressbuch) */
  channel?: ChatChannel;
  port?: number;
  location?: ChatLocation | null;
}

const TRUNK_LABEL: Record<string, string> = { up: '', searching: ' (sucht Netz)', down: ' (kein Netz)', 'no-sim': ' (keine SIM)', unknown: ' (unbekannt)' };

/** Schlüssel eines Empfängers: Rufnummer im Vergleichsformat, sonst die Kennung (Threema-ID …) */
const recipientKey = (token: string) => (looksLikePhone(token) ? phoneKey(token) : token.trim());

/** Kanäle, die für diesen Empfänger in Frage kommen: SMS und WhatsApp nur mit Rufnummer */
const fits = (c: ChatChannelInfo, token: string) => c.available && (looksLikePhone(token) || (c.channel !== 'sms' && c.channel !== 'whatsapp'));

/**
 * Neue Nachricht: Empfänger mit Vorschlägen aus den Kontakten, je Empfänger der Kanal (vorbelegt mit dem ersten
 * erreichbaren nach der eingestellten Reihenfolge), Bild und Standort, bei SMS Trunk-Auswahl und Zeichenzähler.
 */
export function ChatComposer({ initial, onDone, onSent }: { initial: Partial<ChatDraftForm>; onDone: () => void; onSent?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: avail } = useQuery({ queryKey: ['chat', 'available'], queryFn: api.chatAvailable });
  const { data: reach = {} } = useQuery({ queryKey: ['chat', 'reachability'], queryFn: api.chatReachability });
  const { data: incident } = useActiveIncident();
  const { data: waWindow = {} } = useQuery({ queryKey: ['chat', 'whatsappWindow'], queryFn: api.whatsappWindow });
  const vehicle = useDevice('weather')?.state.position ?? null;
  const [form, setForm] = useState<ChatDraftForm>({ to: '', text: '', location: null, ...initial });
  const [chosen, setChosen] = useState<Record<string, ChatChannel>>({});
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const tokens = splitNumbers(form.to);

  // Frei eingegebene Rufnummern, die ELVIS noch nicht kennt, gleich bei den Messengern prüfen
  const unknown = useMemo(() => [...new Set(tokens.filter(looksLikePhone).map(phoneKey))].filter((n) => !(n in reach) && /^\+\d{8,}$/.test(n)).sort(), [tokens, reach]);
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setPending(unknown), 600);
    return () => clearTimeout(t);
  }, [unknown.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: checked = {} } = useQuery({ queryKey: ['chat', 'reachability', 'check', pending], queryFn: () => api.checkChatReachability(pending), enabled: pending.length > 0, staleTime: 300_000 });

  const channels = avail?.channels ?? [];
  const info = (c: ChatChannel) => channels.find((x) => x.channel === c);
  const recipients = tokens.map((token) => {
    const key = recipientKey(token);
    const reachable = (reach[key] ?? checked[key] ?? []).filter((c) => info(c) && fits(info(c)!, token));
    const options = channels.filter((c) => fits(c, token));
    const preferred = form.channel && options.some((o) => o.channel === form.channel) ? form.channel : null;
    const fallback = looksLikePhone(token) && isMobileNumber(token) && options.some((o) => o.channel === 'sms') ? 'sms' : (options[0]?.channel ?? null);
    const channel = chosen[key] ?? preferred ?? reachable[0] ?? fallback;
    return { token, key, channel, reachable, options };
  });
  const used = new Set(recipients.map((r) => r.channel));
  const hasSms = used.has('sms');
  const imagesOk = [...used].every((c) => c && info(c)?.images);
  const port = form.port ?? avail?.defaultPort ?? undefined;
  const count = smsParts(form.text);
  const max = hasSms ? SMS_MAX_LENGTH : CHAT_TEXT_MAX;

  const upload = useMutation({ mutationFn: api.uploadChatFile, onSuccess: setAttachment, onError: (e) => toast('error', e.message) });
  const send = useMutation({
    mutationFn: () =>
      api.sendChat({
        to: recipients.map((r) => ({ channel: r.channel!, to: r.token })),
        text: form.text,
        attachmentId: attachment?.id ?? null,
        location: form.location ?? null,
        ...(hasSms && port !== undefined && { port }),
      }),
    onSuccess: (r) => {
      toast('success', r.length === 1 ? 'Nachricht wird gesendet' : `${r.length} Nachrichten werden gesendet`);
      void qc.invalidateQueries({ queryKey: ['chat'] });
      onSent?.();
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });
  const change = (patch: Partial<ChatDraftForm>) => setForm({ ...form, ...patch });
  const problem =
    recipients.length === 0
      ? 'Empfänger fehlt'
      : recipients.some((r) => !r.channel)
        ? 'Kein Kanal für einen Empfänger'
        : !form.text.trim() && !attachment && !form.location
          ? 'Text fehlt'
          : form.text.length > max
            ? `Höchstens ${max} Zeichen`
            : attachment && !imagesOk
              ? 'Bilder gehen nicht per SMS'
              : null;

  const place = (label: string, pos: { lat: number; lon: number } | null) =>
    pos && (
      <button type="button" className="btn btn-sm" onClick={() => change({ location: { lat: pos.lat, lon: pos.lon, label } })}>
        {label === 'Fahrzeugstandort' ? <Truck size={14} /> : <Flag size={14} />} {label}
      </button>
    );
  const incidentPos = incident?.lat != null && incident.lon != null ? { lat: incident.lat, lon: incident.lon } : null;

  return (
    <div className="stack">
      <Field label="An" hint="Rufnummer, Name aus den Kontakten oder Kennung (z. B. Threema-ID); mehrere durch Komma trennen">
        <NumberInput value={form.to} onChange={(to) => change({ to })} autoFocus={!form.to} />
      </Field>
      {recipients.length > 0 && (
        <ul className="chat-recipients">
          {recipients.map((r) => (
            <li key={r.key}>
              {r.channel && <ChannelIcon channel={r.channel} />}
              <span className="chat-recipient-name">
                {looksLikePhone(r.token) ? formatPhone(r.token) : r.token}
                {r.channel === 'whatsapp' && info('whatsapp')?.window24h && !waWindow[r.key] && <span className="muted small"> · über 24 h ohne Nachricht: nur als Vorlage</span>}
              </span>
              <select
                aria-label={`Kanal für ${r.token}`}
                value={r.channel ?? ''}
                onChange={(e) => setChosen({ ...chosen, [r.key]: e.target.value as ChatChannel })}
                disabled={r.options.length === 0}
              >
                {r.options.length === 0 && <option value="">kein Kanal</option>}
                {r.options.map((o) => (
                  <option key={o.channel} value={o.channel}>
                    {o.label}
                    {r.reachable.includes(o.channel) ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
      {hasSms && avail && avail.ports.length > 1 && (
        <Field label="SMS senden über">
          <select value={port ?? ''} onChange={(e) => change({ port: Number(e.target.value) })}>
            {avail.ports.map((p) => (
              <option key={p.port} value={p.port}>
                {p.name}
                {TRUNK_LABEL[p.status]}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field
        label="Nachricht"
        hint={
          <span className={form.text.length > max ? 'tone-alarm' : undefined}>
            {hasSms ? `${count.length} Zeichen · ${count.parts} ${count.parts === 1 ? 'SMS' : 'Teile'}${count.unicode ? ' · Sonderzeichen: 70 Zeichen je SMS' : ''}` : `${form.text.length} Zeichen`}
          </span>
        }
      >
        <textarea rows={6} value={form.text} onChange={(e) => change({ text: e.target.value })} autoFocus={!!form.to} maxLength={max} />
      </Field>
      <div className="chat-extras">
        {attachment ? (
          <span className="chat-chip">
            <img src={api.chatFileUrl(attachment.id)} alt="" />
            {attachment.name}
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Bild entfernen" onClick={() => setAttachment(null)}>
              <X size={14} />
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-sm" disabled={upload.isPending || (recipients.length > 0 && !imagesOk)} title={recipients.length > 0 && !imagesOk ? 'Bilder gehen nicht per SMS' : undefined} onClick={() => fileRef.current?.click()}>
            <ImagePlus size={14} /> {upload.isPending ? 'Lädt …' : 'Bild'}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={CHAT_IMAGE_TYPES.join(',')}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = '';
          }}
        />
        {form.location ? (
          <span className="chat-chip">
            <MapPin size={14} />
            {form.location.label || `${form.location.lat.toFixed(5)}, ${form.location.lon.toFixed(5)}`}
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Standort entfernen" onClick={() => change({ location: null })}>
              <X size={14} />
            </button>
          </span>
        ) : (
          <>
            {place('Einsatzort', incidentPos)}
            {place('Fahrzeugstandort', vehicle)}
          </>
        )}
        {form.location && hasSms && <span className="muted small">Per SMS als Kartenlink</span>}
      </div>
      <div className="form-actions">
        {problem && recipients.length > 0 && <span className="muted small">{problem}</span>}
        <button className="btn" onClick={onDone}>
          Verwerfen
        </button>
        <button className="btn btn-primary" disabled={!!problem || send.isPending || !avail?.available} onClick={() => send.mutate()}>
          Senden{used.size === 1 && recipients[0]?.channel ? ` per ${CHAT_CHANNEL_LABEL[recipients[0].channel]}` : ''}
        </button>
      </div>
    </div>
  );
}
