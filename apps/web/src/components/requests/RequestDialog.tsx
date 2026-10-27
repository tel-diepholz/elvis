import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlarmClock, ArrowDownLeft, ArrowUpRight, BookOpenText, Mail, Pencil, Reply, Send } from 'lucide-react';
import {
  JOURNAL_CATEGORY_LABELS,
  REQUEST_STATUS_LABELS,
  requestLabel,
  requestOpen,
  requestOverdue,
  requestTransitions,
  type Incident,
  type JournalCategory,
  type JournalEntry,
  type Message,
  type MaterialRequest,
  type MessageInput,
  type MessagePartyInput,
  type RequestNoteInput,
  type RequestStatus,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Field, Modal } from '../ui';
import { Markdown } from '../messages/Markdown';
import { MarkdownEditor } from '../messages/MarkdownEditor';
import { MessageForm } from '../messages/MessageForm';
import { useMessageContext } from '../messages/messageHooks';
import { UnitSearchInput } from '../messages/UnitSearchInput';
import { RequestEditForm } from './RequestForm';
import { RequestStatusBadge, useFollowUp, useRequestSettings, useRequests } from './requestParts';

type Mode = { kind: 'view' } | { kind: 'edit' } | { kind: 'status'; status: RequestStatus } | { kind: 'followUp' } | { kind: 'note' } | { kind: 'message'; reply: boolean } | { kind: 'forward' };

const NOTE_CATEGORIES = (Object.keys(JOURNAL_CATEGORY_LABELS) as JournalCategory[]).filter((c): c is Exclude<JournalCategory, 'system'> => c !== 'system');

const needed = (r: MaterialRequest) => (r.neededBy ? `bis ${fmtDateTime(r.neededBy)}` : 'sofort');

/** Text der Ausgangsmeldung an den Stab bzw. an die Kraft */
const messageText = (r: MaterialRequest) => `Anforderung ${requestLabel(r)} für ${r.unit}\n\n${r.material}\n\nBedarf: ${needed(r)}`;

/** Anforderung im Dialog: Status führen, Wiedervorlage, an den Stab senden, Ausgangsmeldung, Notiz ins Tagebuch */
export function RequestDialog({ incident, requestId, onClose }: { incident: Incident; requestId: number | null; onClose: () => void }) {
  const { data: requests = [] } = useRequests(incident);
  const request = requests.find((r) => r.id === requestId) ?? null;
  return (
    <Modal open={requestId !== null} title={request ? `Anforderung ${requestLabel(request)}` : 'Anforderung'} onClose={onClose} wide>
      {request && <RequestDetail key={request.id} incident={incident} request={request} />}
    </Modal>
  );
}

function RequestDetail({ incident, request: r }: { incident: Incident; request: MaterialRequest }) {
  const toast = useToast();
  const now = useNow();
  const { data: ctx } = useMessageContext();
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const { data: journal = [] } = useQuery({ queryKey: ['journal', incident.id, 'request', r.id], queryFn: () => api.requestJournal(r.id) });
  // auch im abgeschlossenen Einsatz lesbar
  const { data: messages = [] } = useQuery({ queryKey: ['messages', incident.id], queryFn: () => api.messages(incident.id) });
  const back = (text: string) => ({ onSuccess: () => (toast('success', text), setMode({ kind: 'view' })), onError: (e: Error) => toast('error', e.message) });

  const edit = useMutation({ mutationFn: (input: Parameters<typeof api.updateRequest>[1]) => api.updateRequest(r.id, input), ...back('Anforderung gespeichert') });
  const message = useMutation({ mutationFn: (input: MessageInput) => api.createMessage(incident.id, input), ...back('Ausgangsmeldung erstellt') });

  const open = requestOpen(r.status);
  const closed = !!incident.closedAt;
  const staff = incident.procurementMode === 'staff';
  const overdue = requestOverdue(r, now);
  const transitions = requestTransitions(r.status, incident.procurementMode);

  if (mode.kind === 'edit') return <RequestEditForm incidentId={incident.id} request={r} pending={edit.isPending} onSubmit={(input) => edit.mutate(input)} />;
  if (mode.kind === 'message') {
    return (
      <>
        {/* Rückmeldung an die anfordernde Kraft oder freie Ausgangsmeldung (z. B. an einen Lieferanten), beide an der Anforderung */}
        <MessageForm
          incidentId={incident.id}
          prefill={mode.reply ? { recipient: { text: r.unit, unitId: r.unitId }, body: messageText(r), requestId: r.id } : { body: `Anforderung ${requestLabel(r)} für ${r.unit}\n\n`, requestId: r.id }}
          pending={message.isPending}
          onSubmit={(input) => message.mutate(input)}
        />
        <button className="btn btn-ghost" onClick={() => setMode({ kind: 'view' })}>
          Zurück zur Anforderung
        </button>
      </>
    );
  }

  return (
    <div className="message-detail">
      <div className="message-meta">
        <RequestStatusBadge request={r} />
        <span className="cell-sub">
          {REQUEST_STATUS_LABELS[r.status]} seit {fmtDateTime(r.statusAt)} ({r.statusBy})
        </span>
      </div>
      <dl className="kv">
        <dt>Kraft</dt>
        <dd>{r.unit}</dd>
        <dt>Bedarf</dt>
        <dd>{needed(r)}</dd>
        {open && (
          <>
            <dt>Wiedervorlage</dt>
            <dd className={overdue ? 'tone-alarm' : undefined}>
              <AlarmClock size={14} /> {fmtDateTime(r.followUpAt)}
              {overdue && ' – fällig'}
            </dd>
          </>
        )}
        {r.forwardedAt && (
          <>
            <dt>An den Stab</dt>
            <dd>
              {fmtDateTime(r.forwardedAt)} von {r.forwardedBy}
            </dd>
          </>
        )}
        <dt>Angelegt</dt>
        <dd>
          {fmtDateTime(r.createdAt)} von {r.createdBy}
          {r.sourceMessageId !== null && ` · aus Meldung #${r.sourceMessageId}`}
        </dd>
        {r.messageIds.length > 0 && (
          <>
            <dt>Meldungen</dt>
            <dd>{r.messageIds.map((id) => `#${id}`).join(', ')}</dd>
          </>
        )}
      </dl>
      <div className="message-body">
        <p className="task-desc">{r.material}</p>
      </div>

      {mode.kind === 'status' && <StatusForm request={r} status={mode.status} feedback={staff && !!r.forwardedAt} onDone={() => setMode({ kind: 'view' })} />}
      {mode.kind === 'followUp' && <FollowUpForm request={r} onDone={() => setMode({ kind: 'view' })} />}
      {mode.kind === 'note' && <NoteForm request={r} onDone={() => setMode({ kind: 'view' })} />}
      {mode.kind === 'forward' && <ForwardForm incident={incident} request={r} onDone={() => setMode({ kind: 'view' })} />}

      {mode.kind === 'view' && !closed && (
        <div className="btn-row message-actions">
          {r.canManage &&
            transitions.map((s) => (
              <button key={s} className={`btn ${s === transitions[0] ? 'btn-primary' : ''}`} onClick={() => setMode({ kind: 'status', status: s })}>
                {REQUEST_STATUS_LABELS[s]}
              </button>
            ))}
          {r.canManage && open && staff && (
            <button className="btn" onClick={() => setMode({ kind: 'forward' })}>
              <Send size={16} /> An den Stab senden
            </button>
          )}
          {r.canManage && open && (
            <button className="btn" onClick={() => setMode({ kind: 'followUp' })}>
              <AlarmClock size={16} /> Wiedervorlage
            </button>
          )}
          <button className="btn" onClick={() => setMode({ kind: 'note' })}>
            <BookOpenText size={16} /> Notiz ins Tagebuch
          </button>
          {/* Fernmelder schreiben keine Ausgangsmeldungen */}
          {!ctx?.radio && (
            <>
              <button className="btn" onClick={() => setMode({ kind: 'message', reply: true })}>
                <Reply size={16} /> Rückmeldung an Anfordernden
              </button>
              <button className="btn" onClick={() => setMode({ kind: 'message', reply: false })}>
                <Mail size={16} /> Ausgangsmeldung
              </button>
            </>
          )}
          {open && (
            <button className="btn btn-ghost" onClick={() => setMode({ kind: 'edit' })}>
              <Pencil size={16} /> Bearbeiten
            </button>
          )}
        </div>
      )}
      {!r.canManage && open && !closed && <p className="cell-sub">Status und Wiedervorlage führt die Beschaffungsrolle.</p>}

      <section className="request-history">
        <h3>Verlauf</h3>
        <History journal={journal} messages={messages.filter((m) => m.requestId === r.id || m.id === r.sourceMessageId)} />
      </section>
    </div>
  );
}

type HistoryItem = { at: string; key: string } & ({ entry: JournalEntry } | { message: Message });

/** Tagebucheinträge und Meldungen (mit Text und Antwort) zur Anforderung, neueste zuerst */
function History({ journal, messages }: { journal: JournalEntry[]; messages: Message[] }) {
  const items: HistoryItem[] = [
    ...journal.map((entry) => ({ at: entry.timestamp, key: `j${entry.id}`, entry })),
    ...messages.map((message) => ({ at: message.createdAt, key: `m${message.id}`, message })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (!items.length) return <p className="muted">Noch keine Einträge</p>;
  return (
    <ul className="request-history-list">
      {items.map((item) =>
        'entry' in item ? (
          <li key={item.key}>
            <span className="mono">{fmtDateTime(item.at)}</span> <span className={item.entry.important ? 'tone-alarm' : undefined}>{item.entry.text.replace(/^Anforderung A-\d+: /, '')}</span>{' '}
            <span className="cell-sub">
              {item.entry.category !== 'system' && `${JOURNAL_CATEGORY_LABELS[item.entry.category]} · `}
              {item.entry.author}
            </span>
          </li>
        ) : (
          <li key={item.key} className="request-history-message">
            <div>
              <span className="mono">{fmtDateTime(item.at)}</span>{' '}
              {item.message.direction === 'out' ? <ArrowUpRight size={14} className="tone-info" aria-label="Ausgang" /> : <ArrowDownLeft size={14} className="tone-ok" aria-label="Eingang" />}{' '}
              <strong>
                {item.message.direction === 'out' ? 'Ausgangsmeldung' : 'Eingangsmeldung'} #{item.message.id}
              </strong>{' '}
              <span className="cell-sub">
                {item.message.sender} → {item.message.recipient ?? 'wartet auf Verteilung'}
              </span>
            </div>
            <div className="message-body">
              <Markdown text={item.message.body} />
            </div>
            {item.message.reply !== null && (
              <div className="message-reply">
                <h3>
                  <Reply size={14} /> Antwort von {item.message.repliedBy}, {fmtDateTime(item.message.repliedAt!)}
                </h3>
                <Markdown text={item.message.reply} />
              </div>
            )}
          </li>
        ),
      )}
    </ul>
  );
}

function FormFoot({ pending, label, onCancel, error }: { pending: boolean; label: string; onCancel: () => void; error: string | null }) {
  return (
    <>
      {error && <p className="hint tone-alarm">{error}</p>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {label}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </>
  );
}

/** Statuswechsel mit Notiz – im Modus Stab die Rückmeldung des Stabs; offen bleibend mit neuer Wiedervorlage */
function StatusForm({ request: r, status, feedback, onDone }: { request: MaterialRequest; status: RequestStatus; feedback: boolean; onDone: () => void }) {
  const toast = useToast();
  const open = requestOpen(status);
  const followUp = useFollowUp(undefined, status === 'ordered' ? 60 : 30);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.setRequestStatus(r.id, { status, followUpAt: open ? followUp.value() : null, note }),
    onSuccess: () => (toast('success', `Anforderung ${requestLabel(r)}: ${REQUEST_STATUS_LABELS[status]}`), onDone()),
    onError: (e) => setError(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (open && !followUp.value()) return setError('Wiedervorlage fehlt');
    save.mutate();
  };
  return (
    <form className="form request-subform" onSubmit={submit}>
      <h3>{REQUEST_STATUS_LABELS[status]}</h3>
      <Field label={feedback ? 'Rückmeldung des Stabs' : 'Notiz'} hint="Geht mit dem Statuswechsel ins Einsatztagebuch">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={4000} autoFocus placeholder={feedback ? 'z. B. genehmigt durch S4, Lieferung über Bauhof' : undefined} />
      </Field>
      {open && followUp.field}
      <FormFoot pending={save.isPending} label={`Als „${REQUEST_STATUS_LABELS[status]}“ eintragen`} onCancel={onDone} error={error} />
    </form>
  );
}

function FollowUpForm({ request: r, onDone }: { request: MaterialRequest; onDone: () => void }) {
  const toast = useToast();
  const followUp = useFollowUp(r.followUpAt);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (at: string) => api.setRequestFollowUp(r.id, at),
    onSuccess: () => (toast('success', 'Wiedervorlage gesetzt'), onDone()),
    onError: (e) => setError(e.message),
  });
  return (
    <form
      className="form request-subform"
      onSubmit={(e) => {
        e.preventDefault();
        const at = followUp.value();
        if (!at) return setError('Wiedervorlage fehlt');
        save.mutate(at);
      }}
    >
      {followUp.field}
      <FormFoot pending={save.isPending} label="Wiedervorlage setzen" onCancel={onDone} error={error} />
    </form>
  );
}

function NoteForm({ request: r, onDone }: { request: MaterialRequest; onDone: () => void }) {
  const toast = useToast();
  const [input, setInput] = useState<Required<RequestNoteInput>>({ category: 'sonstiges', text: '', important: false });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.addRequestNote(r.id, input),
    onSuccess: () => (toast('success', 'Notiz ins Einsatztagebuch übernommen'), onDone()),
    onError: (e) => setError(e.message),
  });
  return (
    <form
      className="form request-subform"
      onSubmit={(e) => {
        e.preventDefault();
        if (!input.text.trim()) return setError('Text fehlt');
        save.mutate();
      }}
    >
      <Field label="Kategorie">
        <select value={input.category} onChange={(e) => setInput({ ...input, category: e.target.value as typeof input.category })}>
          {NOTE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {JOURNAL_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notiz *">
        <textarea value={input.text} onChange={(e) => setInput({ ...input, text: e.target.value })} rows={3} maxLength={4000} autoFocus />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={input.important} onChange={(e) => setInput({ ...input, important: e.target.checked })} /> Wichtig
      </label>
      <FormFoot pending={save.isPending} label="Ins Tagebuch" onCancel={onDone} error={error} />
    </form>
  );
}

/** Modus Stab: Ausgangsmeldung an den Stab im Namen einer eigenen Rolle (vorbelegt: Beschaffungsrolle), mit Wiedervorlage */
function ForwardForm({ incident, request: r, onDone }: { incident: Incident; request: MaterialRequest; onDone: () => void }) {
  const toast = useToast();
  const { roles: myRoles } = useAuth();
  const { data: settings } = useRequestSettings();
  const [senderRoleId, setSenderRoleId] = useState<number | null>(() => {
    const wanted = settings?.procurementRoleId;
    return wanted && myRoles.some((x) => x.id === wanted) ? wanted : (myRoles[0]?.id ?? null);
  });
  const [recipient, setRecipient] = useState<MessagePartyInput>({ text: incident.procurementStaff, unitId: null });
  const [body, setBody] = useState(messageText(r));
  const followUp = useFollowUp(undefined, 30);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (followUpAt: string) => api.forwardRequest(r.id, { senderRoleId: senderRoleId!, recipient, body, followUpAt }),
    onSuccess: () => (toast('success', 'Anforderung an den Stab gesendet'), onDone()),
    onError: (e) => setError(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const at = followUp.value();
    if (senderRoleId === null) return setError('Bitte zuerst eine Rolle übernehmen (Profilmenü)');
    if (!recipient.text.trim()) return setError('Empfänger fehlt');
    if (!at) return setError('Wiedervorlage fehlt');
    save.mutate(at);
  };
  return (
    <form className="form request-subform" onSubmit={submit}>
      <h3>An den Stab senden</h3>
      <Field label="Absender *">
        <select value={senderRoleId ?? ''} onChange={(e) => setSenderRoleId(Number(e.target.value))}>
          {myRoles.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Empfänger *" hint="Vorgabe aus den Einsatzdaten (Stab für Anforderungen)">
        <UnitSearchInput incidentId={incident.id} value={recipient} onChange={setRecipient} placeholder="z. B. Stab HVB" />
      </Field>
      <div className="field">
        <span className="field-label">Meldung *</span>
        <MarkdownEditor value={body} onChange={setBody} maxLength={4000} rows={6} />
      </div>
      {followUp.field}
      <span className="field-hint">Die Wiedervorlage erinnert die Beschaffungsrolle, beim Stab nachzufassen.</span>
      <FormFoot pending={save.isPending} label="Als Ausgangsmeldung senden" onCancel={onDone} error={error} />
    </form>
  );
}
