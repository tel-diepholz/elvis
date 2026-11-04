import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, CheckCheck, Clock, FileText, FolderInput, MapPin, MessageSquarePlus, MessagesSquare, PenSquare, RadioTower, Search, Trash2, Truck, UserPlus } from 'lucide-react';
import {
  CHAT_CHANNEL_LABEL,
  CHAT_CHANNELS,
  CHAT_STATUS_LABEL,
  MESSAGE_BODY_MAX,
  MESSAGE_PARTY_MAX,
  MESSAGING_STATE_LABEL,
  crewLabel,
  vehicleLabel,
  formatPhone,
  isChatImage,
  phoneKey,
  type ChatChannel,
  type ChatMessage,
  type ChatThread,
  type Incident,
  type MessageInput,
  type MessagingConversation,
  type Unit,
} from '@elvis/shared';
import { api } from '../lib/api';
import { fmtBytes, fmtDateTime, fmtTime } from '../lib/format';
import { useActiveIncident } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Badge, EmptyState, Field, Loading, Modal, PageHeader } from '../components/ui';
import { ContactForm, emptyContact } from '../components/contacts/ContactForm';
import { ChannelIcon } from '../components/chat/ChannelIcon';
import { FolderSelect } from '../components/documents/FolderTree';
import { ChatComposer, type ChatDraftForm } from '../components/chat/ChatComposer';
import { ThreadReply, type ReplyTarget } from '../components/chat/ThreadReply';
import { MessageForm } from '../components/messages/MessageForm';
import { useMessageContext } from '../components/messages/messageHooks';
import { PeerContacts, VehicleSearch } from '../components/messaging/VehicleSearch';

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

/** Fahrzeug-Chat (Cloud Messaging): Gesprächsschlüssel elvis:<ELW-ID> */
const elvisPeer = (key: string | null) => (key?.startsWith('elvis:') ? key.slice(6) : null);

/** Noch keine Nachricht im Fahrzeug-Chat (gerade angefragt oder angenommen): leeres Gespräch mit der Installation */
function draftCloudThread(c: MessagingConversation): ChatThread {
  return { key: c.threadKey, contactId: null, name: vehicleLabel(c.peer.vehicle), numbers: [], peer: c.peer.elwId, channels: ['elvis'], last: null as unknown as ChatMessage, unread: 0, count: 0 };
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
  const [asUnit, setAsUnit] = useState<ChatThread | null>(null);
  const [findVehicle, setFindVehicle] = useState(false);
  const { data: incident } = useActiveIncident();
  const { data: avail } = useQuery({ queryKey: ['chat', 'available'], queryFn: api.chatAvailable });
  const available = !!avail?.available;
  const { data: rawThreads } = useQuery({ queryKey: ['chat', 'threads'], queryFn: api.chatThreads, enabled: available });
  const cloud = avail?.channels.find((c) => c.channel === 'elvis')?.available ?? false;
  const { data: conversations = [] } = useQuery({ queryKey: ['messaging', 'conversations'], queryFn: api.messagingConversations, enabled: cloud });
  /** Neuester Fahrzeug-Chat je Installation */
  const cloudChat = useMemo(() => {
    const m = new Map<string, MessagingConversation>();
    for (const c of conversations) if (!m.has(c.peer.elwId)) m.set(c.peer.elwId, c);
    return m;
  }, [conversations]);
  // Fahrzeug-Chats heißen wie das Fahrzeug (nicht wie die Person, die zuletzt schrieb); offene ohne Nachricht stehen oben
  const threads = useMemo(() => {
    if (!rawThreads) return rawThreads;
    const named = rawThreads.map((t) => {
      const c = cloudChat.get(elvisPeer(t.key) ?? '');
      return c ? { ...t, name: vehicleLabel(c.peer.vehicle) } : t;
    });
    const keys = new Set(named.map((t) => t.key));
    const fresh = [...cloudChat.values()].filter((c) => (c.state === 'requested' || c.state === 'accepted') && !keys.has(c.threadKey)).map(draftCloudThread);
    return [...fresh, ...named];
  }, [rawThreads, cloudChat]);
  const { data: contacts = [] } = useQuery({ queryKey: ['contacts'], queryFn: api.contacts, enabled: available });
  // Kräfte in der laufenden Lage mit Rufnummer: ihr Name steht am Gespräch (Zuordnung gilt nur für diese Lage)
  const { data: units = [] } = useQuery({ queryKey: ['units', incident?.id], queryFn: () => api.units(incident!.id), enabled: available && !!incident });
  const unitsOf = useMemo(() => {
    const byNumber = new Map<string, Unit[]>();
    for (const u of units) if (u.mobile && u.status !== 'entlassen') byNumber.set(u.mobile, [...(byNumber.get(u.mobile) ?? []), u]);
    return (t: Pick<ChatThread, 'numbers'>) => [...new Set(t.numbers.flatMap((n) => byNumber.get(n) ?? []))];
  }, [units]);

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
    return threads.filter((t) => threadName(t).toLowerCase().includes(q) || unitsOf(t).some((u) => u.name.toLowerCase().includes(q)) || (digits.length >= 3 && t.numbers.some((n) => n.includes(digits))) || t.peer?.toLowerCase().includes(q));
  }, [threads, search, unitsOf]);

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
          <span className="btn-row">
            {cloud && (
              <button className="btn" onClick={() => setFindVehicle(true)} title="Andere ELVIS-Installation suchen und einen Chat anfragen">
                <RadioTower size={16} /> Fahrzeug anschreiben
              </button>
            )}
            <button className="btn btn-primary" onClick={() => setDraft({})}>
              <PenSquare size={16} /> Neue Nachricht
            </button>
          </span>
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
                    <span className="chat-thread-name">
                      {threadName(t)}
                      <UnitTags units={unitsOf(t)} />
                    </span>
                    <span className="chat-thread-time muted">{t.last ? listTime(t.last.date) : ''}</span>
                    {t.last ? (
                      <span className="chat-thread-snippet muted">
                        <ChannelIcon channel={t.last.channel} size={12} />
                        {t.last.folder === 'sent' && <span>Du: </span>}
                        <span className="chat-thread-text">{summary(t.last)}</span>
                      </span>
                    ) : (
                      <span className="chat-thread-snippet muted">
                        <ChannelIcon channel="elvis" size={12} />
                        <span className="chat-thread-text">Fahrzeug-Chat {MESSAGING_STATE_LABEL[cloudChat.get(t.peer ?? '')?.state ?? 'requested']}</span>
                      </span>
                    )}
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
              cloudChat={elvisPeer(selected.key) ? (cloudChat.get(elvisPeer(selected.key)!) ?? null) : null}
              onMessage={incident ? setAsMessage : undefined}
              onDocument={incident ? setAsDocument : undefined}
              onContact={setAsContact}
              units={unitsOf(selected)}
              onAssign={incident && selected.numbers.length ? () => setAsUnit(selected) : undefined}
            />
          ) : (
            <EmptyState icon={<MessagesSquare size={32} />} title="Gespräch wählen">
              Links ein Gespräch öffnen oder mit „Neue Nachricht“ jemanden anschreiben.
            </EmptyState>
          )}
        </section>
      </div>

      <Modal open={findVehicle} title="Fahrzeug anschreiben" onClose={() => setFindVehicle(false)} wide>
        {findVehicle && (
          <VehicleSearch
            conversations={conversations}
            onOpen={(c) => {
              setFindVehicle(false);
              select(c.threadKey);
            }}
          />
        )}
      </Modal>
      <Modal open={draft !== null} title="Neue Nachricht" onClose={() => setDraft(null)} wide>
        {draft && <ChatComposer initial={draft} onDone={() => setDraft(null)} onSent={() => void qc.invalidateQueries({ queryKey: ['chat'] })} />}
      </Modal>
      <Modal open={asMessage !== null && !!incident} title="Eingangsmeldung aus Nachricht" onClose={() => setAsMessage(null)} wide>
        {asMessage && incident && <ChatToMessage incident={incident} msg={asMessage} onDone={() => setAsMessage(null)} />}
      </Modal>
      <Modal open={asDocument !== null && !!incident} title="In Dokumente übernehmen" onClose={() => setAsDocument(null)}>
        {asDocument && incident && <ChatToDocumentForm incident={incident} msg={asDocument} onDone={() => setAsDocument(null)} />}
      </Modal>
      <Modal open={asUnit !== null && !!incident} title="Kraft zuordnen" onClose={() => setAsUnit(null)}>
        {asUnit && incident && <AssignUnitForm incident={incident} thread={asUnit} units={units} assigned={unitsOf(asUnit)} onDone={() => setAsUnit(null)} />}
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
  units,
  onAssign,
  cloudChat,
}: {
  thread: ChatThread;
  labels: Record<string, string>;
  preset: ChatChannel | null;
  presetNumber: string | null;
  onBack: () => void;
  onSent: (m: ChatMessage[]) => void;
  /** Nur mit laufendem Einsatz */
  onMessage?: (m: ChatMessage) => void;
  /** Bild in die Dokumente der Lage übernehmen; nur mit laufendem Einsatz */
  onDocument?: (m: ChatMessage) => void;
  onContact: (number: string) => void;
  /** Kräfte in der laufenden Lage mit einer Rufnummer dieses Gesprächs */
  units: Unit[];
  /** Rufnummer einer Kraft der Lage zuordnen; nur mit laufendem Einsatz und Rufnummer */
  onAssign?: () => void;
  /** Fahrzeug-Chat (Cloud Messaging) dieses Gesprächs */
  cloudChat?: MessagingConversation | null;
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
  const target: ReplyTarget = { numbers, peer: thread.peer && !thread.numbers.length ? { channel: thread.last?.channel ?? thread.channels[0] ?? 'elvis', id: thread.peer } : null, labels };

  // Tagesweise trennen
  let lastDay = '';

  return (
    <div className="thread-view">
      <header className="thread-head">
        <button className="btn btn-ghost btn-icon thread-back" aria-label="Zurück zu den Gesprächen" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <div className="thread-title">
          <strong>
            {name}
            <UnitTags units={units} />
          </strong>
          <span className="muted small">
            {thread.numbers.map((n, i) => (
              <span key={n}>
                {i > 0 && ' · '}
                <a href={`tel:${n}`}>{formatPhone(n)}</a>
                {labels[n] ? ` (${labels[n]})` : ''}
              </span>
            ))}
            {!thread.numbers.length && thread.peer && (cloudChat ? <span>{cloudChat.peer.vehicle.organization} · {cloudChat.peer.regionLabel}</span> : <span className="mono">{thread.peer}</span>)}
          </span>
        </div>
        {thread.contactId === null && thread.numbers[0] && (
          <button className="btn btn-sm thread-head-btn" title="Unbekannte Rufnummer als Kontakt anlegen" onClick={() => onContact(thread.numbers[0]!)}>
            <UserPlus size={16} /> <span>Kontakt anlegen</span>
          </button>
        )}
        {onAssign && (
          <button className="btn btn-sm thread-head-btn" title="Rufnummer einer Kraft der Lage zuordnen (nur für diese Lage)" onClick={onAssign}>
            <Truck size={16} /> <span>Kraft zuordnen</span>
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

      {cloudChat && <CloudChatBar chat={cloudChat} />}

      <div className="thread-messages">
        {!exists && (
          <p className="muted thread-empty">
            {cloudChat ? (cloudChat.state === 'accepted' ? `Verbunden mit ${name}. Unten schreiben – Text, Dokumente und Standorte gehen Ende-zu-Ende verschlüsselt.` : '') : `Noch keine Nachrichten mit ${name}. Unten schreiben und den Messenger wählen.`}
          </p>
        )}
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
                {m.attachment &&
                  (isChatImage(m.attachment.mimeType) ? (
                    <a className="chat-image" href={api.chatFileUrl(m.attachment.id)} target="_blank" rel="noreferrer" title={m.attachment.name}>
                      <img src={api.chatFileUrl(m.attachment.id)} alt={m.attachment.name} loading="lazy" />
                    </a>
                  ) : (
                    <a className="chat-file" href={api.chatFileUrl(m.attachment.id)} download={m.attachment.name} title="Herunterladen">
                      <FileText size={16} /> <span className="chat-file-name">{m.attachment.name}</span> <span className="muted small">{fmtBytes(m.attachment.size)}</span>
                    </a>
                  ))}
                {m.location && (
                  <Link className="chat-location" to={mapLink(m.location, name)}>
                    <MapPin size={14} /> {m.location.label || `${m.location.lat.toFixed(5)}, ${m.location.lon.toFixed(5)}`} · In Karte zeigen
                  </Link>
                )}
                <span className="thread-meta muted">
                  <ChannelIcon channel={m.channel} size={12} title={CHAT_CHANNEL_LABEL[m.channel]} />
                  {fmtTime(m.date)}
                  {m.folder === 'sent' && m.createdBy && <span> · {m.createdBy}</span>}
                  {m.folder === 'inbox' && m.channel === 'elvis' && m.name && <span> · {m.name}</span>}
                  {st && (
                    <span className={`tone-${st.tone}`} title={m.error ?? CHAT_STATUS_LABEL[m.status]}>
                      <st.icon size={12} aria-label={CHAT_STATUS_LABEL[m.status]} />
                    </span>
                  )}
                  <span className="thread-actions">
                    {onMessage && m.folder === 'inbox' && (
                      <button className="btn btn-ghost btn-icon btn-sm" disabled={!ctx?.captureIn} title={ctx?.captureIn ? 'Als Eingangsmeldung erfassen' : 'Eingangsmeldungen erfassen nur Fernmelder'} aria-label="Meldung erstellen" onClick={() => onMessage(m)}>
                        <MessageSquarePlus size={14} />
                      </button>
                    )}
                    {onDocument && m.attachment && m.folder === 'inbox' && (
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

      {cloudChat && cloudChat.state !== 'accepted' && !thread.numbers.length ? (
        <p className="thread-reply muted">{cloudChat.state === 'requested' ? (cloudChat.direction === 'out' ? 'Wartet darauf, dass die Gegenseite die Anfrage annimmt …' : 'Anfrage unten links annehmen, um zu schreiben.') : `Chat ${MESSAGING_STATE_LABEL[cloudChat.state]}.`}</p>
      ) : (
        <ThreadReply target={target} lastChannel={lastChannel} preset={preset} onSent={onSent} />
      )}
    </div>
  );
}

/** Fahrzeug-Chat: Zustand, Besatzung der Gegenseite (Name und Rolle), Kontaktdaten; beenden bzw. neu anfragen */
function CloudChatBar({ chat }: { chat: MessagingConversation }) {
  const toast = useToast();
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['messaging'] });
    void qc.invalidateQueries({ queryKey: ['chat'] });
  };
  const close = useMutation({ mutationFn: () => api.messagingDecide(chat.id, 'close'), onSuccess: done, onError: (e) => toast('error', e.message) });
  const again = useMutation({ mutationFn: () => api.messagingRequest(chat.peer.elwId), onSuccess: () => (done(), toast('success', 'Anfrage gesendet')), onError: (e) => toast('error', e.message) });
  const tone = chat.state === 'accepted' ? 'ok' : chat.state === 'requested' ? 'info' : 'muted';
  return (
    <div className="cloud-chat-bar">
      <div className="cloud-chat-state">
        <Badge tone={tone}>{MESSAGING_STATE_LABEL[chat.state]}</Badge>
        {chat.state === 'requested' && chat.direction === 'out' && chat.requestedBy && <span className="muted small">angefragt von {crewLabel(chat.requestedBy)}</span>}
        {(chat.state === 'declined' || chat.state === 'closed') && chat.decidedBy && <span className="muted small">von {chat.decidedBy}</span>}
        <span className="spacer" />
        {(chat.state === 'accepted' || (chat.state === 'requested' && chat.direction === 'out')) && (
          <button className="btn btn-sm" disabled={close.isPending} onClick={() => window.confirm(`Chat mit ${vehicleLabel(chat.peer.vehicle)} beenden?`) && close.mutate()}>
            {chat.state === 'accepted' ? 'Chat beenden' : 'Anfrage zurückziehen'}
          </button>
        )}
        {(chat.state === 'declined' || chat.state === 'closed') && (
          <button className="btn btn-sm" disabled={again.isPending} onClick={() => again.mutate()}>
            <RadioTower size={14} /> Erneut anfragen
          </button>
        )}
      </div>
      {chat.state === 'accepted' && (
        <div className="cloud-chat-crew small">
          <span className="muted">Im Fahrzeug angemeldet: </span>
          {chat.peerCrew.length ? chat.peerCrew.map((m, i) => <span key={i} className="cloud-chat-member">{crewLabel(m)}</span>) : <span className="muted">niemand</span>}
        </div>
      )}
      <PeerContacts peer={chat.peer} />
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

/** Anhang einer Nachricht in die Dokumente der Lage übernehmen: Ordner wählen (Vorgabe für Bilder „Fotos“), Beschreibung vorbelegt */
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
  // Vorgabe: „Fotos“ bzw. „Sonstiges“ auf oberster Ebene, falls vorhanden
  const preset = msg.attachment && isChatImage(msg.attachment.mimeType) ? 'Fotos' : 'Sonstiges';
  const chosen = folderId !== undefined ? folderId : (listing.folders.find((f) => f.parentId === null && f.name === preset)?.id ?? null);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(chosen);
      }}
    >
      {msg.attachment && isChatImage(msg.attachment.mimeType) && (
        <img className="chat-document-preview" src={api.chatFileUrl(msg.attachment.id)} alt={msg.attachment.name} />
      )}
      <Field label="Ordner" hint={`Dokumente der Lage „${incident.title}“`}>
        <FolderSelect folders={listing.folders} value={chosen} onChange={setFolderId} rootLabel="Lage (oberste Ebene)" />
      </Field>
      <Field label="Beschreibung">
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
      <div className="form-actions">
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

/** Zugeordnete Kräfte als Kennzeichen am Namen */
function UnitTags({ units }: { units: Unit[] }) {
  return (
    <>
      {units.map((u) => (
        <span key={u.id} className="chat-unit-tag" title={`Kraft im Einsatz: ${u.name}`}>
          <Truck size={11} /> {u.name}
        </span>
      ))}
    </>
  );
}

/**
 * Rufnummer des Gesprächs einer Kraft in der laufenden Lage zuordnen (Feld „Mobil“ der Kraft, nur in diesem Einsatz; der
 * Kräftekatalog bleibt unberührt). Bestehende Zuordnungen lassen sich lösen.
 */
function AssignUnitForm({ incident, thread, units, assigned, onDone }: { incident: Incident; thread: ChatThread; units: Unit[]; assigned: Unit[]; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [number, setNumber] = useState(thread.numbers[0] ?? '');
  const [unitId, setUnitId] = useState<number | null>(null);
  const patch = useMutation({
    mutationFn: ({ unit, mobile }: { unit: Unit; mobile: string }) => api.patchUnit(unit.id, { mobile }),
    onSuccess: (u, v) => {
      toast('success', v.mobile ? `${formatPhone(v.mobile)} ist jetzt ${u.name} zugeordnet` : `Zuordnung zu ${u.name} gelöst`);
      void qc.invalidateQueries({ queryKey: ['units', incident.id] });
      if (v.mobile) onDone();
    },
    onError: (e) => toast('error', e.message),
  });
  const active = units.filter((u) => u.status !== 'entlassen').sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const unit = active.find((u) => u.id === unitId);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (unit && number) patch.mutate({ unit, mobile: number });
      }}
    >
      {assigned.length > 0 && (
        <div className="field">
          <span className="field-label">Zugeordnet</span>
          <ul className="assign-list">
            {assigned.map((u) => (
              <li key={u.id}>
                <span className="chat-unit-tag">
                  <Truck size={11} /> {u.name}
                </span>{' '}
                <span className="muted small">{formatPhone(u.mobile)}</span>
                <button type="button" className="btn btn-ghost btn-sm" disabled={patch.isPending} onClick={() => patch.mutate({ unit: u, mobile: '' })}>
                  Lösen
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {thread.numbers.length > 1 && (
        <Field label="Rufnummer">
          <select value={number} onChange={(e) => setNumber(e.target.value)}>
            {thread.numbers.map((n) => (
              <option key={n} value={n}>
                {formatPhone(n)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field
        label={`Kraft in der Lage „${incident.title}“`}
        hint={
          unit?.mobile && unit.mobile !== number
            ? `${unit.name} hat schon ${formatPhone(unit.mobile)} – die Nummer wird ersetzt.`
            : `Die Kraft merkt sich ${formatPhone(number)} nur für diese Lage – Meldungen an sie lassen sich dann per Nachricht senden.`
        }
      >
        <select value={unitId ?? ''} onChange={(e) => setUnitId(e.target.value ? Number(e.target.value) : null)} autoFocus>
          <option value="">Kraft wählen …</option>
          {active.map((u) => (
            <option key={u.id} value={u.id} disabled={u.mobile === number}>
              {u.name}
              {u.mobile === number ? ' (bereits zugeordnet)' : u.mobile ? ` – hat ${formatPhone(u.mobile)}` : ''}
            </option>
          ))}
        </select>
      </Field>
      {active.length === 0 && <p className="muted">In der Lage sind noch keine Kräfte erfasst.</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!unit || !number || patch.isPending}>
          <Truck size={14} /> Zuordnen
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Schließen
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
