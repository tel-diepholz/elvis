import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCheck, Clock, MailOpen, MapPin, MessageSquarePlus, MessagesSquare, PenSquare, Reply, Trash2, UserPlus } from 'lucide-react';
import {
  CHAT_CHANNEL_LABEL,
  CHAT_CHANNELS,
  CHAT_STATUS_LABEL,
  MESSAGE_BODY_MAX,
  MESSAGE_PARTY_MAX,
  chatThreadKey,
  formatPhone,
  type ChatChannel,
  type ChatFolder,
  type ChatMessage,
  type Incident,
  type MessageInput,
} from '@elvis/shared';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useActiveIncident } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Badge, Card, EmptyState, Loading, Modal, PageHeader, Segmented } from '../components/ui';
import { ContactForm, emptyContact } from '../components/contacts/ContactForm';
import { ChannelIcon } from '../components/chat/ChannelIcon';
import { ChatComposer, type ChatDraftForm } from '../components/chat/ChatComposer';
import { MessageForm } from '../components/messages/MessageForm';
import { useMessageContext } from '../components/messages/messageHooks';

const STATUS: Record<Exclude<ChatMessage['status'], 'received'>, { tone: 'ok' | 'warn' | 'alarm'; icon: typeof Check }> = {
  sending: { tone: 'warn', icon: Clock },
  sent: { tone: 'ok', icon: Check },
  delivered: { tone: 'ok', icon: CheckCheck },
  read: { tone: 'ok', icon: CheckCheck },
  failed: { tone: 'alarm', icon: AlertTriangle },
};

/** Gegenstelle: Kontaktname, sonst Rufnummer bzw. Kennung */
const party = (m: Pick<ChatMessage, 'name' | 'number' | 'peer'>) => m.name ?? (m.number ? formatPhone(m.number) : m.peer);
/** Kurzfassung für die Liste */
const summary = (m: ChatMessage) => m.text || (m.attachment ? 'Bild' : m.location ? `Standort${m.location.label ? `: ${m.location.label}` : ''}` : '');
const mapLink = (l: NonNullable<ChatMessage['location']>, from: string) =>
  `/karte?lat=${l.lat}&lon=${l.lon}&name=${encodeURIComponent(l.label || `Standort von ${from}`)}&detail=${encodeURIComponent(l.label ? `Standort von ${from}` : '')}`;

const isChannel = (c: string | null): c is ChatChannel => !!c && (CHAT_CHANNELS as readonly string[]).includes(c);

/** Nachrichten: SMS und Messenger in einer Liste, die Herkunft zeigt ein kleines Symbol */
export function ChatPage() {
  const [folder, setFolder] = useState<ChatFolder>('inbox');
  const [selected, setSelected] = useState<number | null>(null);
  // /nachrichten?an=…&kanal=… (z. B. aus den Kontakten) öffnet gleich eine neue Nachricht
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Partial<ChatDraftForm> | null>(() => {
    const to = params.get('an');
    const channel = params.get('kanal');
    return to ? { to: `${to}, `, ...(isChannel(channel) && { channel }) } : null;
  });
  useEffect(() => {
    if (params.has('an')) setParams({}, { replace: true });
  }, [params, setParams]);
  const { data: incident } = useActiveIncident();
  const [asMessage, setAsMessage] = useState<ChatMessage | null>(null);
  const [asContact, setAsContact] = useState<string | null>(null);
  const { data: avail } = useQuery({ queryKey: ['chat', 'available'], queryFn: api.chatAvailable });
  const available = !!avail?.available;
  const { data: list } = useQuery({ queryKey: ['chat', 'messages', folder], queryFn: () => api.chatMessages(folder), enabled: available });

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
  const disturbed = active.filter((c) => c.status !== 'connected');
  const current = list?.items.find((m) => m.id === selected);

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
            {disturbed.length > 0 && <span className="tone-alarm">gestört: {disturbed.map((c) => c.label).join(', ')}</span>}
          </span>
        }
        actions={
          <button className="btn btn-primary" onClick={() => setDraft({})}>
            <PenSquare size={16} /> Neue Nachricht
          </button>
        }
      />
      <Card className="mail-list-card">
        <Segmented
          label="Ordner"
          value={folder}
          onChange={(f) => (setFolder(f), setSelected(null))}
          options={[
            { value: 'inbox', label: `Eingang${list && list.unread ? ` (${list.unread})` : ''}` },
            { value: 'sent', label: 'Gesendet' },
          ]}
        />
        {!list ? (
          <Loading />
        ) : list.items.length === 0 ? (
          <EmptyState icon={<MessagesSquare size={32} />} title={folder === 'inbox' ? 'Keine Nachrichten' : 'Noch nichts gesendet'} />
        ) : (
          <ul className="mail-list">
            {list.items.map((m) => {
              const st = m.status !== 'received' ? STATUS[m.status] : null;
              return (
                <li key={m.id}>
                  <button className={`mail-item ${m.id === selected ? 'active' : ''} ${m.seen ? '' : 'unread'}`} onClick={() => setSelected(m.id)}>
                    <span className="mail-item-from">
                      <ChannelIcon channel={m.channel} size={14} />
                      <span>{folder === 'inbox' ? party(m) : `An ${party(m)}`}</span>
                    </span>
                    <span className="mail-item-subject">
                      {st && <st.icon size={14} aria-label={CHAT_STATUS_LABEL[m.status]} className={`tone-${st.tone}`} />}
                      {m.location && <MapPin size={14} aria-label="Standort" />}
                      <span>{m.name && m.number ? formatPhone(m.number) : ''}</span>
                    </span>
                    <span className="mail-item-snippet muted">{summary(m)}</span>
                    <span className="mail-item-date muted">{fmtDateTime(m.date)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Modal open={selected !== null} title={current ? party(current) : 'Nachricht'} onClose={() => setSelected(null)} wide>
        {selected !== null && (
          <Reader
            id={selected}
            onReply={(m) => (setSelected(null), setDraft({ to: `${m.number ? formatPhone(m.number) : m.peer}, `, channel: m.channel }))}
            onClose={() => setSelected(null)}
            onMessage={incident ? (m) => (setSelected(null), setAsMessage(m)) : undefined}
            onContact={(number) => (setSelected(null), setAsContact(number))}
          />
        )}
      </Modal>
      <Modal open={draft !== null} title="Neue Nachricht" onClose={() => setDraft(null)} wide>
        {draft && <ChatComposer initial={draft} onDone={() => setDraft(null)} />}
      </Modal>
      <Modal open={asMessage !== null && !!incident} title="Eingangsmeldung aus Nachricht" onClose={() => setAsMessage(null)} wide>
        {asMessage && incident && <ChatToMessage incident={incident} msg={asMessage} onDone={() => setAsMessage(null)} />}
      </Modal>
      <Modal open={asContact !== null} title="Als Kontakt anlegen" onClose={() => setAsContact(null)} wide>
        {asContact !== null && <NewContact number={asContact} onDone={() => setAsContact(null)} />}
      </Modal>
    </>
  );
}

/** Bild und Standort einer Nachricht */
function Extras({ m, from }: { m: ChatMessage; from: string }) {
  return (
    <>
      {m.attachment && (
        <a className="chat-image" href={api.chatFileUrl(m.attachment.id)} target="_blank" rel="noreferrer" title={m.attachment.name}>
          <img src={api.chatFileUrl(m.attachment.id)} alt={m.attachment.name} loading="lazy" />
        </a>
      )}
      {m.location && (
        <Link className="chat-location" to={mapLink(m.location, from)}>
          <MapPin size={14} /> {m.location.label || `${m.location.lat.toFixed(5)}, ${m.location.lon.toFixed(5)}`} · In Karte zeigen
        </Link>
      )}
    </>
  );
}

function Reader({
  id,
  onReply,
  onClose,
  onMessage,
  onContact,
}: {
  id: number;
  onReply: (m: ChatMessage) => void;
  onClose: () => void;
  /** Nur mit laufendem Einsatz */
  onMessage?: (m: ChatMessage) => void;
  onContact: (number: string) => void;
}) {
  const toast = useToast();
  const { data: ctx } = useMessageContext();
  const { data: m } = useQuery({ queryKey: ['chat', 'message', id], queryFn: () => api.chatMessage(id) });
  const key = m ? chatThreadKey(m) : '';
  const { data: thread = [] } = useQuery({ queryKey: ['chat', 'thread', key], queryFn: () => api.chatThread(key), enabled: !!m });
  const seen = useMutation({ mutationFn: (v: boolean) => api.setChatSeen(id, v), onSuccess: (_, v) => !v && onClose() });
  const remove = useMutation({ mutationFn: () => api.removeChat(id), onSuccess: onClose, onError: (e) => toast('error', e.message) });

  useEffect(() => {
    if (m && !m.seen && m.folder === 'inbox') seen.mutate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.id]);

  if (!m) return <Loading />;
  const st = m.status !== 'received' ? STATUS[m.status] : null;
  // Verlauf ohne die geöffnete Nachricht, die letzten zehn – über alle Kanäle
  const earlier = thread.filter((t) => t.id !== m.id).slice(-10);
  const from = party(m);

  return (
    <div className="mail-reader">
      <div className="mail-reader-head">
        <dl className="kv">
          <dt>{m.folder === 'inbox' ? 'Von' : 'An'}</dt>
          <dd>
            {m.name ? `${m.name}, ` : ''}
            {m.number ? <a href={`tel:${m.number}`}>{formatPhone(m.number)}</a> : <span className="mono">{m.peer}</span>}
          </dd>
          <dt>Über</dt>
          <dd className="chat-via">
            <ChannelIcon channel={m.channel} size={14} /> {CHAT_CHANNEL_LABEL[m.channel]}
          </dd>
          <dt>Datum</dt>
          <dd>{fmtDateTime(m.date)}</dd>
          {m.folder === 'sent' && (
            <>
              <dt>Gesendet von</dt>
              <dd>{m.createdBy}</dd>
            </>
          )}
        </dl>
        <div className="mail-reader-actions btn-row">
          {onMessage && m.folder === 'inbox' && (
            <button className="btn btn-sm" disabled={!ctx?.radio} title={ctx?.radio ? 'Als Eingangsmeldung im Einsatz erfassen' : 'Eingangsmeldungen erfassen nur Fernmelder'} onClick={() => onMessage(m)}>
              <MessageSquarePlus size={16} /> Meldung erstellen
            </button>
          )}
          {!m.name && m.number && (
            <button className="btn btn-ghost btn-icon" title="Als Kontakt anlegen" aria-label="Als Kontakt anlegen" onClick={() => onContact(m.number!)}>
              <UserPlus size={18} />
            </button>
          )}
          <button className="btn btn-ghost btn-icon" title="Antworten" aria-label="Antworten" onClick={() => onReply(m)}>
            <Reply size={18} />
          </button>
          {m.folder === 'inbox' && (
            <button className="btn btn-ghost btn-icon" title="Als ungelesen markieren" aria-label="Als ungelesen markieren" onClick={() => seen.mutate(false)}>
              <MailOpen size={18} />
            </button>
          )}
          <button className="btn btn-ghost btn-icon" title="Löschen" aria-label="Löschen" onClick={() => window.confirm('Nachricht löschen?') && remove.mutate()}>
            <Trash2 size={18} />
          </button>
        </div>
      </div>
      {st && (
        <p className="mail-badges">
          <span title={m.error ?? undefined}>
            <Badge tone={st.tone}>
              <st.icon size={12} /> {CHAT_STATUS_LABEL[m.status]}
              {m.error ? `: ${m.error}` : ''}
            </Badge>
          </span>
        </p>
      )}
      {m.text && <div className="mail-body">{m.text}</div>}
      <Extras m={m} from={from} />
      {earlier.length > 0 && (
        <section className="sms-thread">
          <h3 className="section-title">Verlauf mit {from}</h3>
          <ul>
            {earlier.map((t) => (
              <li key={t.id} className={`sms-bubble ${t.folder === 'inbox' ? 'in' : 'out'}`}>
                {t.text && <span className="sms-bubble-text">{t.text}</span>}
                <Extras m={t} from={from} />
                <span className="sms-bubble-meta muted">
                  <ChannelIcon channel={t.channel} size={12} /> {fmtDateTime(t.date)}
                  {t.status === 'failed' ? ' · fehlgeschlagen' : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
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
  const name = party(msg);
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

/** Unbekannte Absendernummer als Kontakt übernehmen */
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
