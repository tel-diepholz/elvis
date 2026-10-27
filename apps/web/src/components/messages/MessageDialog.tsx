import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlarmClock, ArrowRight, Check, CheckCheck, ListPlus, PackagePlus, Paperclip, Reply, Send, Undo2, UserCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { MESSAGE_BODY_MAX, MESSAGE_REMIND_MINUTES, TASK_SUMMARY_MAX, REQUEST_STATUS_LABELS, requestLabel, requestOpen, type Incident, type Message, type MessageInput, type RequestInput, type TaskInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Field, Modal } from '../ui';
import { TaskForm } from '../tasks/TaskForm';
import { RequestForm } from '../requests/RequestForm';
import { REQUESTS_PATH, useRequests } from '../requests/requestParts';
import { Markdown, markdownPreview } from './Markdown';
import { MarkdownEditor } from './MarkdownEditor';
import { MessageForm } from './MessageForm';
import { canHandle, useMessageContext, useMessages } from './messageHooks';
import { MessageParties, MessageStatus, SnoozeNote } from './MessageParts';

/**
 * Meldung im Dialog. Fernmelder bzw. Dispatcher übernehmen sie beim Öffnen (alle sehen, wer sie bearbeitet) und können
 * sie zurücklegen, in 2 min erneut versuchen, beantworten/erledigen bzw. verteilen. Die Zielrolle nimmt zur Kenntnis
 * oder antwortet mit einer neuen Ausgangsmeldung. Schließen ohne Aktion behält die Übernahme.
 */
export function MessageDialog({ incident, messageId, onClose }: { incident: Incident; messageId: number | null; onClose: () => void }) {
  const { data: messages = [] } = useMessages(incident);
  const message = messages.find((m) => m.id === messageId) ?? null;
  return (
    <Modal open={messageId !== null} title={message ? (message.direction === 'out' ? `Ausgangsmeldung #${message.id}` : `Eingangsmeldung #${message.id}`) : 'Meldung'} onClose={onClose} wide>
      {message && <MessageDetail key={message.id} incident={incident} message={message} onClose={onClose} />}
    </Modal>
  );
}

function MessageDetail({ incident, message: m, onClose }: { incident: Incident; message: Message; onClose: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const { data: ctx } = useMessageContext();
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const [mode, setMode] = useState<'view' | 'reply' | 'answer' | 'task' | 'request' | 'attach'>('view');
  const navigate = useNavigate();
  const [reply, setReply] = useState('');
  const [routeTo, setRouteTo] = useState<number | null>(null);

  const handler = canHandle(m, ctx);
  const mine = m.claimedByUserId === user?.id;
  // Andere aktive Übernahme: der Server meldet dann für mich nichts zu tun
  const claimedByOther = handler && !mine && m.claimedBy !== null && m.pending === null;
  const onError = (e: Error) => toast('error', e.message);

  const claim = useMutation({ mutationFn: (force: boolean) => api.claimMessage(m.id, force), onError });
  const closing = (text: string) => ({ onSuccess: () => (toast('success', text), onClose()), onError });
  const release = useMutation({ mutationFn: () => api.releaseMessage(m.id), ...closing('Meldung zurückgelegt') });
  const snooze = useMutation({ mutationFn: () => api.snoozeMessage(m.id, MESSAGE_REMIND_MINUTES), ...closing(`Erneuter Versuch in ${MESSAGE_REMIND_MINUTES} min`) });
  const done = useMutation({ mutationFn: () => api.messageDone(m.id), ...closing('Meldung erledigt') });
  const answer = useMutation({ mutationFn: () => api.replyMessage(m.id, reply), ...closing('Antwort gesendet') });
  const route = useMutation({ mutationFn: (roleId: number) => api.routeMessage(m.id, roleId), ...closing('Meldung verteilt') });
  const ack = useMutation({ mutationFn: () => api.ackMessage(m.id), ...closing('Zur Kenntnis genommen') });
  const createTask = useMutation({
    mutationFn: (input: TaskInput) => api.createTask(incident.id, input),
    onSuccess: (t) => (toast('success', `Aufgabe „${t.summary}“ angelegt`), setMode('view')),
    onError,
  });
  const createRequest = useMutation({
    mutationFn: (input: RequestInput) => api.createRequest(incident.id, input),
    onSuccess: (r) => (toast('success', `Anforderung ${requestLabel(r)} angelegt`), onClose(), navigate(`${REQUESTS_PATH}?id=${r.id}`)),
    onError,
  });
  const respond = useMutation({ mutationFn: (input: MessageInput) => api.createMessage(incident.id, input), ...closing('Antwort als Ausgangsmeldung erstellt') });

  // Beim Öffnen übernehmen, wenn niemand anderes sie gerade bearbeitet
  const claimed = useRef(false);
  useEffect(() => {
    if (claimed.current || !handler || mine || m.pending === null) return;
    claimed.current = true;
    claim.mutate(false);
  }, [handler, mine, m.pending, claim]);

  // Kopie gilt mit dem Öffnen als gelesen – nur für die eigenen Kopie-Rollen, die Zielrolle bleibt unberührt
  const copyRead = useRef(false);
  useEffect(() => {
    if (copyRead.current || m.pending !== 'copy') return;
    copyRead.current = true;
    api.ackMessage(m.id).catch(() => undefined);
  }, [m.id, m.pending]);

  const busy = [claim, release, snooze, done, answer, route, ack, respond].some((x) => x.isPending);

  // Aufgabe aus der Meldung: Meldungstext als Beschreibung, Kurztext aus der ersten Zeile, an die Zielrolle
  if (mode === 'task') {
    return (
      <>
        <TaskForm
          prefill={{
            summary: markdownPreview(m.body).replace(/[:;,.\s]+$/, '').slice(0, TASK_SUMMARY_MAX),
            description: m.body,
            assignee: m.recipientRoleId !== null ? { kind: 'role', roleId: m.recipientRoleId } : undefined,
          }}
          pending={createTask.isPending}
          onSubmit={(input) => createTask.mutate(input)}
        />
        <button className="btn btn-ghost" onClick={() => setMode('view')}>
          Zurück zur Meldung
        </button>
      </>
    );
  }

  // Anforderung aus der Meldung: Kraft = Absender (Eingang) bzw. Empfänger (Ausgang), Material = Meldungstext
  if (mode === 'attach') return <AttachToRequest incident={incident} message={m} onBack={() => setMode('view')} onClose={onClose} />;

  if (mode === 'request') {
    const unit = m.direction === 'in' ? { text: m.sender, unitId: m.senderUnitId } : { text: m.recipient ?? '', unitId: m.recipientUnitId };
    return (
      <>
        <RequestForm incidentId={incident.id} prefill={{ unit, material: m.body, sourceMessageId: m.id }} pending={createRequest.isPending} onSubmit={(input) => createRequest.mutate(input)} />
        <button className="btn btn-ghost" onClick={() => setMode('view')}>
          Zurück zur Meldung
        </button>
      </>
    );
  }

  if (mode === 'answer') {
    return (
      <MessageForm
        incidentId={incident.id}
        prefill={{ senderRoleId: m.recipientRoleId, recipient: { text: m.sender, unitId: m.senderUnitId }, replyToId: m.id }}
        pending={respond.isPending}
        onSubmit={(input) => respond.mutate(input)}
      />
    );
  }

  return (
    <div className="message-detail">
      <MessageParties message={m} />
      <div className="message-meta">
        <MessageStatus message={m} />
        <span className="cell-sub">
          erstellt {fmtDateTime(m.createdAt)} von {m.createdBy}
        </span>
      </div>

      {handler && m.claimedBy && (
        <div className={`message-claim ${mine ? 'tone-ok' : 'tone-warn'}`}>
          <UserCheck size={16} /> {mine ? 'Von Ihnen übernommen' : `Übernommen von ${m.claimedBy}`}
          {m.claimedAt && ` seit ${fmtTime(m.claimedAt)}`}
          {claimedByOther && (
            <button className="btn btn-sm" disabled={busy} onClick={() => claim.mutate(true)}>
              Übernehmen
            </button>
          )}
        </div>
      )}

      <div className="message-body">
        <Markdown text={m.body} />
      </div>

      {m.reply !== null && (
        <section className="message-reply">
          <h3>
            <Reply size={16} /> Antwort von {m.repliedBy}, {fmtTime(m.repliedAt!)}
          </h3>
          <Markdown text={m.reply} />
        </section>
      )}

      {mode === 'reply' && (
        <div className="field">
          <span className="field-label">
            Antwort ({reply.length}/{MESSAGE_BODY_MAX})
          </span>
          <MarkdownEditor value={reply} onChange={setReply} maxLength={MESSAGE_BODY_MAX} rows={4} autoFocus />
        </div>
      )}

      <div className="btn-row message-actions">
        {handler && mine && m.direction === 'out' && mode === 'view' && (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => setMode('reply')}>
              <Reply size={16} /> Antworten
            </button>
            <button className="btn" disabled={busy} onClick={() => done.mutate()} title="Ohne Antwort abschließen, z. B. per Funk übermittelt">
              <Check size={16} /> Erledigt
            </button>
          </>
        )}
        {mode === 'reply' && (
          <>
            <button className="btn btn-primary" disabled={busy || !reply.trim()} onClick={() => answer.mutate()}>
              <Send size={16} /> Antwort senden
            </button>
            <button className="btn btn-ghost" onClick={() => setMode('view')}>
              Abbrechen
            </button>
          </>
        )}
        {handler && mine && m.direction === 'in' && (
          <div className="message-route">
            <Field label="Verteilen an">
              <select value={routeTo ?? ''} onChange={(e) => setRouteTo(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Rolle wählen …</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.holders.length ? ` (${r.holders.join(', ')})` : ' – unbesetzt'}
                  </option>
                ))}
              </select>
            </Field>
            <button className="btn btn-primary" disabled={busy || routeTo === null} onClick={() => route.mutate(routeTo!)}>
              <ArrowRight size={16} /> Verteilen
            </button>
          </div>
        )}
        {handler && mine && mode === 'view' && (
          <>
            <button className="btn" disabled={busy} onClick={() => snooze.mutate()}>
              <AlarmClock size={16} /> In {MESSAGE_REMIND_MINUTES} min erneut versuchen
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => release.mutate()} title="Für andere wieder freigeben">
              <Undo2 size={16} /> Zurücklegen
            </button>
          </>
        )}
        {m.pending === 'recipient' && (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => ack.mutate()}>
              <CheckCheck size={16} /> Zur Kenntnis genommen
            </button>
            <button className="btn" disabled={busy} onClick={() => setMode('task')}>
              <ListPlus size={16} /> Aufgabe erstellen
            </button>
            <button className="btn" disabled={busy} onClick={() => setMode('request')}>
              <PackagePlus size={16} /> Anforderung erstellen
            </button>
            {m.requestId === null && (
              <button className="btn" disabled={busy} onClick={() => setMode('attach')}>
                <Paperclip size={16} /> An Anforderung anhängen
              </button>
            )}
            {/* Fernmelder schreiben keine Ausgangsmeldungen */}
            {!ctx?.radio && (
              <button className="btn" disabled={busy} onClick={() => setMode('answer')}>
                <Reply size={16} /> Antworten
              </button>
            )}
          </>
        )}
        {m.pending === 'reply' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => ack.mutate()}>
            <CheckCheck size={16} /> Zur Kenntnis genommen
          </button>
        )}
      </div>
      {!handler && m.pending === null && !m.doneAt && m.claimedBy && <p className="cell-sub">In Bearbeitung bei {m.claimedBy}</p>}
      {m.ackAt && <p className="cell-sub">Zur Kenntnis genommen {fmtDateTime(m.ackAt)} von {m.ackBy}</p>}
      {m.copies.length > 0 && (
        <p className="cell-sub">
          Kopie an {m.copies.map((k) => (k.ackAt ? `${k.role} (gelesen ${fmtTime(k.ackAt)}, ${k.ackBy})` : `${k.role} (ungelesen)`)).join(', ')}
        </p>
      )}
      {m.doneAt && m.reply === null && m.direction === 'out' && <p className="cell-sub">Erledigt {fmtDateTime(m.doneAt)} von {m.doneBy}</p>}
      {m.snoozeCount > 0 && (
        <p className="cell-sub">
          <SnoozeNote message={m} />
        </p>
      )}
      {m.replyToId !== null && <p className="cell-sub">Antwort auf Eingangsmeldung #{m.replyToId}</p>}
      {m.requestId !== null && (
        <p className="cell-sub">
          <Link to={`${REQUESTS_PATH}?id=${m.requestId}`}>Zur Anforderung</Link>
        </p>
      )}
      {mode === 'view' && m.pending !== 'recipient' && !incident.closedAt && (
        <div className="btn-row">
          <button className="btn btn-sm btn-ghost" onClick={() => setMode('request')}>
            <PackagePlus size={16} /> Anforderung aus Meldung
          </button>
          {m.direction === 'in' && m.requestId === null && (
            <button className="btn btn-sm btn-ghost" onClick={() => setMode('attach')}>
              <Paperclip size={16} /> An Anforderung anhängen
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Eingangsmeldung an eine bestehende Anforderung hängen, z. B. die Rückmeldung des Stabs – offene zuerst */
function AttachToRequest({ incident, message: m, onBack, onClose }: { incident: Incident; message: Message; onBack: () => void; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: requests = [] } = useRequests(incident);
  const sorted = [...requests].sort((a, b) => Number(requestOpen(b.status)) - Number(requestOpen(a.status)) || b.number - a.number);
  const [requestId, setRequestId] = useState<number | null>(null);
  const attach = useMutation({
    mutationFn: (id: number) => api.attachRequestMessage(id, m.id),
    // Angehängt gilt als zur Kenntnis genommen; weiter in der Anforderung
    onSuccess: (r) => (toast('success', `Meldung an Anforderung ${requestLabel(r)} angehängt`), onClose(), navigate(`${REQUESTS_PATH}?id=${r.id}`)),
    onError: (e) => toast('error', e.message),
  });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (requestId !== null) attach.mutate(requestId);
      }}
    >
      <Field label="Anforderung *" hint="Die Meldung erscheint im Verlauf der Anforderung und im Einsatztagebuch">
        <select value={requestId ?? ''} onChange={(e) => setRequestId(e.target.value ? Number(e.target.value) : null)} autoFocus>
          <option value="">{sorted.length ? 'Anforderung wählen …' : 'Keine Anforderungen im Einsatz'}</option>
          {sorted.map((r) => (
            <option key={r.id} value={r.id}>
              {requestLabel(r)} · {r.unit} · {r.material.split('\n')[0]!.slice(0, 60)} ({REQUEST_STATUS_LABELS[r.status]})
            </option>
          ))}
        </select>
      </Field>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={requestId === null || attach.isPending}>
          <Paperclip size={16} /> Anhängen
        </button>
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Zurück zur Meldung
        </button>
      </div>
    </form>
  );
}
