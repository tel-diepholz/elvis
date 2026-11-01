import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, CheckCheck, Clock, FolderInput, MapPin, MessageSquarePlus, MessagesSquare, PenSquare, Search, Trash2, UserPlus } from 'lucide-react';
import {
  CHAT_CHANNEL_LABEL,
  CHAT_CHANNELS,
  CHAT_STATUS_LABEL,
  MESSAGE_BODY_MAX,
  MESSAGE_PARTY_MAX,
  formatPhone,
  phoneKey,
  type ChatChannel,
  type ChatMessage,
  type ChatThread,
  type Incident,
  type MessageInput,
} from '@elvis/shared';
import { api } from '../lib/api';
import { fmtDateTime, fmtTime } from '../lib/format';
import { useActiveIncident } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { EmptyState, Field, Loading, Modal, PageHeader } from '../components/ui';
import { ContactForm, emptyContact } from '../components/contacts/ContactForm';
import { ChannelIcon } from '../components/chat/ChannelIcon';
import { FolderSelect } from '../components/documents/FolderTree';
import { ChatComposer, type ChatDraftForm } from '../components/chat/ChatComposer';
import { ThreadReply, type ReplyTarget } from '../components/chat/ThreadReply';
import { MessageForm } from '../components/messages/MessageForm';
import { useMessageContext } from '../components/messages/messageHooks';

const STATUS: Record<Exclude<ChatMessage['status'], 'received'>, { tone: 'ok' | 'warn' | 'alarm'; icon: typeof Check }> = {
  sending: { tone: 'warn', icon: Clock },
  sent: { tone: 'ok', icon: Check },
  delivered: { tone: 'ok', icon: CheckCheck },
  read: { tone: 'ok', icon: CheckCheck },
  failed: { tone: 'alarm', icon: AlertTriangle },
};

const isChannel = (c: string | null): c is ChatChannel => !!c && (CHAT_CHANNELS as readonly string[]).includes(c);

/** Name eines Gesprächs: Kontakt bzw. Name aus dem Messenger, sonst Rufnummer oder Kennung */
const threadName = (t: Pick<ChatThread, 'name' | 'numbers' | 'peer'>) => t.name ?? (t.numbers[0] ? formatPhone(t.numbers[0]) : (t.peer ?? 'Unbekannt'));
/** Kurzfassung einer Nachricht für die Liste */
const summary = (m: ChatMessage) => m.text || (m.attachment ? 'Bild' : m.location ? `Standort${m.location.label ? `: ${m.location.label}` : ''}` : '');
const mapLink = (l: NonNullable<ChatMessage['location']>, from: string) =>
  `/karte?lat=${l.lat}&lon=${l.lon}&name=${encodeURIComponent(l.label || `Standort von ${from}`)}&detail=${encodeURIComponent(l.label ? `Standort von ${from}` : '')}`;

/** Uhrzeit heute, sonst Datum */
function listTime(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? fmtTime(iso) : fmtDateTime(iso).split(' ')[0]!;
}

/** Noch kein Gespräch (z. B. aus den Kontakten geöffnet): leeres Gespräch mit dieser Rufnummer */
function draftThread(number: string): ChatThread {
  const n = phoneKey(number);
  return { key: n, contactId: null, name: null, numbers: [n], peer: null, channels: [], last: null as unknown as ChatMessage, unread: 0, count: 0 };
}

/**
 * Nachrichten als Gespräche: links alle Gegenstellen, mit denen es Nachrichten gibt (je Kontakt eine Zeile, egal über
 * welche Rufnummer und welchen Messenger), rechts der Verlauf mit allen Kanälen und darunter die Antwortzeile.
 */
export function ChatPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Partial<ChatDraftForm> | null>(null);
  const [search, setSearch] = useState('');
  const [asMessage, setAsMessage] = useState<ChatMessage | null>(null);
  const [asContact, setAsContact] = useState<string | null>(null);
  const [asDocument, setAsDocument] = useState<ChatMessage | null>(null);
  const { data: incident } = useActiveIncident();
  const { data: avail } = useQuery({ queryKey: ['chat', 'available'], queryFn: api.chatAvailable });
  const available = !!avail?.available;
  const { data: threads } = useQuery({ queryKey: ['chat', 'threads'], queryFn: api.chatThreads, enabled: available });
  const { data: contacts = [] } = useQuery({ queryKey: ['contacts'], queryFn: api.contacts, enabled: available });

  // ?t=<Gespräch>, aus den Kontakten ?an=<Rufnummer>&kanal=<Kanal>
  const selectedKey = params.get('t');
  const preset = isChannel(params.get('kanal')) ? (params.get('kanal') as ChatChannel) : null;
  /** Angeklickte Rufnummer (z. B. „Dienst“ im Adressbuch) vor der zuletzt genutzten */
  const presetNumber = params.get('nr');
  useEffect(() => {
    const an = params.get('an');
    if (!an || !threads) return;
    const n = phoneKey(an);
    const existing = threads.find((t) => t.numbers.includes(n));
    setParams({ t: existing?.key ?? n, nr: n, ...(preset && { kanal: preset }) }, { replace: true });
  }, [params, threads, setParams, preset]);
  const select = (key: string | null) => setParams(key ? { t: key } : {}, { replace: false });

  const selected = useMemo(() => {
    if (!selectedKey || !threads) return null;
    const exact = threads.find((t) => t.key === selectedKey);
    if (exact) return exact;
    // Rufnummer: inzwischen ggf. Teil eines Kontakts (z. B. gerade als Kontakt angelegt), sonst neues Gespräch
    if (!/^\+?\d{3,}$/.test(selectedKey)) return null;
    return threads.find((t) => t.numbers.includes(phoneKey(selectedKey))) ?? draftThread(selectedKey);
  }, [selectedKey, threads]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !threads) return threads ?? [];
    const digits = q.replace(/\D/g, '').replace(/^0+/, '');
    return threads.filter((t) => threadName(t).toLowerCase().includes(q) || (digits.length >= 3 && t.numbers.some((n) => n.includes(digits))) || t.peer?.toLowerCase().includes(q));
  }, [threads, search]);

  if (!avail) return <Loading />;
  if (!available)
    return (
      <>
        <PageHeader title="Nachrichten" />
        <EmptyState icon={<MessagesSquare size={32} />} title="Kein Kanal für Nachrichten aktiv">
          SMS laufen über das Modul Telefonie, Signal, Threema, WhatsApp und Telegram sind eigene Fahrzeugmodule. Ein Admin aktiviert sie unter{' '}
          <Link to="/einstellungen">Einstellungen → Fahrzeugmodule</Link>.
        </EmptyState>
      </>
    );

  const active = avail.channels.filter((c) => c.available);

  return (
    <>
      <PageHeader
        title="Nachrichten"
        subtitle={
          <span className="chat-channels">
            {active.map((c) => (
              <span key={c.channel} className={c.status === 'connected' ? '' : 'tone-alarm'} title={c.status === 'connected' ? `${c.label}${c.account ? `: ${c.account}` : ''}` : `${c.label}: gestört`}>
                <ChannelIcon channel={c.channel} size={14} /> {c.label}
              </span>
            ))}
          </span>
        }
        actions={
          <button className="btn btn-primary" onClick={() => setDraft({})}>
            <PenSquare size={16} /> Neue Nachricht
          </button>
        }
      />
      <div className={`chat-layout ${selected ? 'has-thread' : ''}`}>
        <section className="chat-threads card" aria-label="Gespräche">
          <div className="chat-threads-search">
            <Search size={16} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name oder Rufnummer" aria-label="Gespräche durchsuchen" />
          </div>
          {!threads ? (
            <Loading />
          ) : filtered.length === 0 ? (
            <EmptyState icon={<MessagesSquare size={28} />} title={threads.length ? 'Kein Treffer' : 'Noch keine Nachrichten'} />
          ) : (
            <ul className="chat-thread-list">
              {filtered.map((t) => (
                <li key={t.key}>
                  <button className={`chat-thread-item ${t.key === selected?.key ? 'active' : ''} ${t.unread ? 'unread' : ''}`} onClick={() => select(t.key)}>
                    <span className="chat-thread-name">{threadName(t)}</span>
                    <span className="chat-thread-time muted">{listTime(t.last.date)}</span>
                    <span className="chat-thread-snippet muted">
                      <ChannelIcon channel={t.last.channel} size={12} />
                      {t.last.folder === 'sent' && <span>Du: </span>}
                      <span className="chat-thread-text">{summary(t.last)}</span>
                    </span>
                    <span className="chat-thread-badges">
                      {t.channels.length > 1 &&
                        t.channels.map((c) => (
                          <ChannelIcon key={c} channel={c} size={12} />
                        ))}
                      {t.unread > 0 && <span className="chat-thread-unread">{t.unread}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="chat-thread card" aria-label="Verlauf">
          {selected ? (
            <ThreadView
              key={selected.key}
              thread={selected}
              labels={Object.fromEntries((contacts.find((c) => c.id === selected.contactId)?.phones ?? []).map((p) => [phoneKey(p.number), p.label]))}
              preset={preset}
              presetNumber={presetNumber}
              onBack={() => select(null)}
              onSent={(m) => m[0] && m[0].thread !== selected.key && select(m[0].thread)}
              onMessage={incident ? setAsMessage : undefined}
              onDocument={incident ? setAsDocument : undefined}
              onContact={setAsContact}
            />
          ) : (
            <EmptyState icon={<MessagesSquare size={32} />} title="Gespräch wählen">
              Links ein Gespräch öffnen oder mit „Neue Nachricht“ jemanden anschreiben.
            </EmptyState>
          )}
        </section>
      </div>

      <Modal open={draft !== null} title="Neue Nachricht" onClose={() => setDraft(null)} wide>
        {draft && <ChatComposer initial={draft} onDone={() => setDraft(null)} onSent={() => void qc.invalidateQueries({ queryKey: ['chat'] })} />}
      </Modal>
      <Modal open={asMessage !== null && !!incident} title="Eingangsmeldung aus Nachricht" onClose={() => setAsMessage(null)} wide>
        {asMessage && incident && <ChatToMessage incident={incident} msg={asMessage} onDone={() => setAsMessage(null)} />}
      </Modal>
      <Modal open={asDocument !== null && !!incident} title="In Dokumente übernehmen" onClose={() => setAsDocument(null)}>
        {asDocument && incident && <ChatToDocumentForm incident={incident} msg={asDocument} onDone={() => setAsDocument(null)} />}
      </Modal>
      <Modal open={asContact !== null} title="Als Kontakt anlegen" onClose={() => setAsContact(null)} wide>
        {asContact !== null && <NewContact number={asContact} onDone={() => setAsContact(null)} />}
      </Modal>
    </>
  );
}

/** Verlauf eines Gesprächs über alle Kanäle, unten die Antwortzeile */
function ThreadView({
  thread,
  labels,
  preset,
  presetNumber,
  onBack,
  onSent,
  onMessage,
  onDocument,
  onContact,
}: {
  thread: ChatThread;
  labels: Record<string, string>;
  preset: ChatChannel | null;
  presetNumber: string | null;
  onBack: () => void;
  onSent: (m: ChatMessage[]) => void;
  /** Nur mit laufendem Einsatz */
  onMessage?: (m: ChatMessage) => void;
  /** Bild in die Dokumente des Einsatzes übernehmen; nur mit laufendem Einsatz */
  onDocument?: (m: ChatMessage) => void;
  onContact: (number: string) => void;
}) {
  const toast = useToast();
  const { data: ctx } = useMessageContext();
  const exists = thread.count > 0;
  const { data: messages = [] } = useQuery({ queryKey: ['chat', 'thread', thread.key], queryFn: () => api.chatThread(thread.key), enabled: exists });
  const seen = useMutation({ mutationFn: () => api.markChatThreadSeen(thread.key) });
  const remove = useMutation({
    mutationFn: () => api.removeChatThread(thread.key),
    onSuccess: (r) => (toast('success', `Gespräch gelöscht (${r.removed} ${r.removed === 1 ? 'Nachricht' : 'Nachrichten'})`), onBack()),
    onError: (e) => toast('error', e.message),
  });
  const endRef = useRef<HTMLDivElement>(null);
  const name = threadName(thread);

  // Geöffnet = gelesen, auch wenn während des Lesens etwas Neues kommt
  useEffect(() => {
    if (thread.unread > 0 && !seen.isPending) seen.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.key, thread.unread]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, thread.key]);

  const lastChannel = exists ? (thread.last?.channel ?? null) : null;
  // Angeklickte Rufnummer zuerst, dann die zuletzt genutzten
  const numbers = presetNumber && thread.numbers.includes(presetNumber) ? [presetNumber, ...thread.numbers.filter((n) => n !== presetNumber)] : thread.numbers;
  const target: ReplyTarget = { numbers, peer: thread.peer && !thread.numbers.length ? { channel: thread.last.channel, id: thread.peer } : null, labels };

  // Tagesweise trennen
  let lastDay = '';

  return (
    <div className="thread-view">
      <header className="thread-head">
        <button className="btn btn-ghost btn-icon thread-back" aria-label="Zurück zu den Gesprächen" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <div className="thread-title">
          <strong>{name}</strong>
          <span className="muted small">
            {thread.numbers.map((n, i) => (
              <span key={n}>
                {i > 0 && ' · '}
                <a href={`tel:${n}`}>{formatPhone(n)}</a>
                {labels[n] ? ` (${labels[n]})` : ''}
              </span>
            ))}
            {!thread.numbers.length && thread.peer && <span className="mono">{thread.peer}</span>}
          </span>
        </div>
        {thread.contactId === null && thread.numbers[0] && (
          <button className="btn btn-ghost btn-icon" title="Als Kontakt anlegen" aria-label="Als Kontakt anlegen" onClick={() => onContact(thread.numbers[0]!)}>
            <UserPlus size={18} />
          </button>
        )}
        {exists && (
          <button
            className="btn btn-ghost btn-icon"
            title="Gespräch löschen"
            aria-label="Gespräch löschen"
            disabled={remove.isPending}
            onClick={() => window.confirm(`Gespräch mit ${name} löschen? Alle ${thread.count} Nachrichten über alle Messenger und Rufnummern werden gelöscht.`) && remove.mutate()}
          >
            <Trash2 size={18} />
          </button>
        )}
      </header>

      <div className="thread-messages">
        {!exists && <p className="muted thread-empty">Noch keine Nachrichten mit {name}. Unten schreiben und den Messenger wählen.</p>}
        {messages.map((m) => {
          const day = new Date(m.date).toDateString();
          const divider = day !== lastDay ? fmtDateTime(m.date).split(' ')[0] : null;
          lastDay = day;
          const st = m.status !== 'received' ? STATUS[m.status] : null;
          return (
            <div key={m.id} className="thread-row">
              {divider && <div className="thread-day muted small">{divider}</div>}
              <div className={`thread-bubble ${m.folder === 'inbox' ? 'in' : 'out'} ${m.status === 'failed' ? 'failed' : ''}`}>
                {m.text && <span className="thread-text">{m.text}</span>}
                {m.attachment && (
                  <a className="chat-image" href={api.chatFileUrl(m.attachment.id)} target="_blank" rel="noreferrer" title={m.attachment.name}>
                    <img src={api.chatFileUrl(m.attachment.id)} alt={m.attachment.name} loading="lazy" />
                  </a>
                )}
                {m.location && (
                  <Link className="chat-location" to={mapLink(m.location, name)}>
                    <MapPin size={14} /> {m.location.label || `${m.location.lat.toFixed(5)}, ${m.location.lon.toFixed(5)}`} · In Karte zeigen
                  </Link>
                )}
                <span className="thread-meta muted">
                  <ChannelIcon channel={m.channel} size={12} title={CHAT_CHANNEL_LABEL[m.channel]} />
                  {fmtTime(m.date)}
                  {m.folder === 'sent' && m.createdBy && <span> · {m.createdBy}</span>}
                  {st && (
                    <span className={`tone-${st.tone}`} title={m.error ?? CHAT_STATUS_LABEL[m.status]}>
                      <st.icon size={12} aria-label={CHAT_STATUS_LABEL[m.status]} />
                    </span>
                  )}
                  <span className="thread-actions">
                    {onMessage && m.folder === 'inbox' && (
                      <button className="btn btn-ghost btn-icon btn-sm" disabled={!ctx?.radio} title={ctx?.radio ? 'Als Eingangsmeldung erfassen' : 'Eingangsmeldungen erfassen nur Fernmelder'} aria-label="Meldung erstellen" onClick={() => onMessage(m)}>
                        <MessageSquarePlus size={14} />
                      </button>
                    )}
                    {onDocument && m.attachment && (
                      <button className="btn btn-ghost btn-icon btn-sm" title="In Dokumente übernehmen" aria-label="In Dokumente übernehmen" onClick={() => onDocument(m)}>
                        <FolderInput size={14} />
                      </button>
                    )}
                  </span>
                </span>
                {m.status === 'failed' && m.error && <span className="thread-error tone-alarm small">{m.error}</span>}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <ThreadReply target={target} lastChannel={lastChannel} preset={preset} onSent={onSent} />
    </div>
  );
}

/** Nachricht als Eingangsmeldung: Absender ist die Kraft im Einsatz bzw. Systemeinheit mit dieser Rufnummer, sonst der Kontaktname */
function ChatToMessage({ incident, msg, onDone }: { incident: Incident; msg: ChatMessage; onDone: () => void }) {
  const toast = useToast();
  const { data: units } = useQuery({ queryKey: ['units', incident.id], queryFn: () => api.units(incident.id) });
  const { data: catalog } = useQuery({ queryKey: ['forces'], queryFn: api.forces });
  const create = useMutation({
    mutationFn: (input: MessageInput) => api.createMessage(incident.id, input),
    onSuccess: () => (toast('success', 'Eingangsmeldung erstellt'), onDone()),
    onError: (e) => toast('error', e.message),
  });
  if (!units || !catalog) return <Loading />;
  const number = msg.number;
  const unit = number ? units.find((u) => u.mobile === number && u.status !== 'entlassen') : undefined;
  const deployed = new Set(units.filter((u) => u.status !== 'entlassen').map((u) => u.sourceId));
  const force = unit || !number ? undefined : catalog.find((f) => f.mobile === number && !deployed.has(f.id));
  const name = msg.name ?? (number ? formatPhone(number) : msg.peer);
  const body = [msg.text, msg.location ? `Standort: ${msg.location.label ? `${msg.location.label} ` : ''}(${msg.location.lat.toFixed(5)}, ${msg.location.lon.toFixed(5)})` : '', msg.attachment ? `[Bild: ${msg.attachment.name}]` : '']
    .filter(Boolean)
    .join('\n');
  return (
    <MessageForm
      incidentId={incident.id}
      prefill={{
        direction: 'in',
        sender: unit ? { unitId: unit.id, text: unit.name } : force ? { forceUnitId: force.id, text: force.name } : { text: name.slice(0, MESSAGE_PARTY_MAX) },
        chat: { id: msg.id, from: number ? formatPhone(number) : null },
        body: body.slice(0, MESSAGE_BODY_MAX),
      }}
      pending={create.isPending}
      onSubmit={(input) => create.mutate(input)}
    />
  );
}

/** Bild einer Nachricht in die Dokumente des Einsatzes übernehmen: Ordner wählen (Vorgabe „Fotos“), Beschreibung vorbelegt */
function ChatToDocumentForm({ incident, msg, onDone }: { incident: Incident; msg: ChatMessage; onDone: () => void }) {
  const toast = useToast();
  const { data: listing } = useQuery({ queryKey: ['documents', incident.id], queryFn: () => api.documents(incident.id) });
  const [folderId, setFolderId] = useState<number | null | undefined>(undefined);
  const who = msg.name ?? (msg.number ? formatPhone(msg.number) : msg.peer);
  const [description, setDescription] = useState(() =>
    [`${CHAT_CHANNEL_LABEL[msg.channel]} ${msg.folder === 'inbox' ? 'von' : 'an'} ${who}, ${fmtDateTime(msg.date)}`, msg.text.trim()].filter(Boolean).join(': ').slice(0, 500),
  );
  const save = useMutation({
    mutationFn: (target: number | null) => api.chatToDocument(msg.id, { incidentId: incident.id, folderId: target, description }),
    onSuccess: (d) => (toast('success', `${d.filename} in den Dokumenten abgelegt`), onDone()),
    onError: (e) => toast('error', e.message),
  });
  if (!listing) return <Loading />;
  // Vorgabe: Ordner „Fotos“ auf oberster Ebene, falls vorhanden
  const chosen = folderId !== undefined ? folderId : (listing.folders.find((f) => f.parentId === null && f.name === 'Fotos')?.id ?? null);
  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(chosen);
      }}
    >
      {msg.attachment && (
        <img className="chat-document-preview" src={api.chatFileUrl(msg.attachment.id)} alt={msg.attachment.name} />
      )}
      <Field label="Ordner" hint={`Dokumente des Einsatzes „${incident.title}“`}>
        <FolderSelect folders={listing.folders} value={chosen} onChange={setFolderId} rootLabel="Einsatz (oberste Ebene)" />
      </Field>
      <Field label="Beschreibung">
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          <FolderInput size={14} /> Übernehmen
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

/** Unbekannte Rufnummer als Kontakt übernehmen */
function NewContact({ number, onDone }: { number: string; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: categories } = useQuery({ queryKey: ['contacts', 'categories'], queryFn: api.contactCategories });
  const create = useMutation({
    mutationFn: api.createContact,
    onSuccess: (c) => (toast('success', 'Kontakt angelegt'), void qc.invalidateQueries({ queryKey: ['chat'] }), onDone(), c),
    onError: (e) => toast('error', e.message),
  });
  if (!categories) return <Loading />;
  return (
    <ContactForm
      initial={{ ...emptyContact(), phones: [{ label: 'Mobil', number: formatPhone(number) }] }}
      categories={categories}
      pending={create.isPending}
      onSubmit={(c) => create.mutate(c)}
      onCancel={onDone}
    />
  );
}
