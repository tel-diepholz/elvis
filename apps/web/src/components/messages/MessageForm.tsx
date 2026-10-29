import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MESSAGE_BODY_MAX, messageInputSchema, type MessageDirection, type MessageInput, type MessagePartyInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Field, Segmented } from '../ui';
import { MarkdownEditor } from './MarkdownEditor';
import { useMessageContext } from './messageHooks';
import { UnitSearchInput } from './UnitSearchInput';

/** Vorbelegung, z. B. für die Antwort der Zielrolle auf eine Eingangsmeldung */
export interface MessagePrefill {
  /** Vorgabe: Ausgang; Eingang nur für Fernmelder (z. B. aus einer E-Mail) */
  direction?: MessageDirection;
  /** Absender einer Eingangsmeldung */
  sender?: MessagePartyInput;
  /** Eingang aus einer E-Mail: die Absenderadresse merkt sich die gewählte Kraft */
  mail?: { id: number; from: string };
  senderRoleId?: number | null;
  recipient?: MessagePartyInput;
  replyToId?: number;
  body?: string;
  /** Ausgangsmeldung zu einer Anforderung */
  requestId?: number;
}

/**
 * Neue Meldung. Ausgang: im Namen einer eigenen Rolle an eine Kraft oder Freitext. Eingang (nur Fernmelder): Absender
 * aus der Kräfteverwaltung, Zielrolle – ist ein Dispatcher angemeldet, verteilt er.
 */
export function MessageForm({ incidentId, prefill, pending, onSubmit }: { incidentId: number; prefill?: MessagePrefill; pending: boolean; onSubmit: (input: MessageInput) => void }) {
  const { roles: myRoles } = useAuth();
  const { data: ctx } = useMessageContext();
  const { data: allRoles = [] } = useQuery({ queryKey: ['roles'], queryFn: api.roles });

  // Fernmelder erfassen nur Eingangsmeldungen; Antworten der Zielrolle sind immer Ausgang
  const direction: MessageDirection = prefill?.direction ?? (!prefill && ctx?.radio ? 'in' : 'out');
  const [senderRoleId, setSenderRoleId] = useState<number | null>(() => {
    const wanted = prefill?.senderRoleId;
    return wanted && myRoles.some((r) => r.id === wanted) ? wanted : (myRoles[0]?.id ?? null);
  });
  const [party, setParty] = useState<MessagePartyInput>(prefill?.recipient ?? prefill?.sender ?? { text: '', unitId: null });
  const [recipientRoleId, setRecipientRoleId] = useState<number | null>(null);
  const [body, setBody] = useState(prefill?.body ?? '');
  const [error, setError] = useState<string | null>(null);

  const incoming = direction === 'in';
  const dispatcherRoutes = incoming && !!ctx?.dispatcherPresent;

  const input = (): MessageInput =>
    incoming
      ? { direction: 'in', sender: party, recipientRoleId: dispatcherRoutes ? null : recipientRoleId, body, mailId: prefill?.mail?.id ?? null }
      : { direction: 'out', senderRoleId: senderRoleId ?? 0, recipient: party, body, replyToId: prefill?.replyToId ?? null, requestId: prefill?.requestId ?? null };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!incoming && senderRoleId === null) return setError('Bitte zuerst eine Rolle übernehmen (Profilmenü)');
    if (incoming && !dispatcherRoutes && recipientRoleId === null) return setError('Empfänger fehlt');
    const parsed = messageInputSchema.safeParse(input());
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Eingabe prüfen');
    setError(null);
    onSubmit(input());
  };

  return (
    <form className="form" onSubmit={submit}>
      {ctx?.radio && !prefill && (
        <div className="field">
          <span className="field-label">Art</span>
          <Segmented<MessageDirection>
            label="Art"
            value={direction}
            onChange={() => undefined}
            options={[
              { value: 'out', label: 'Ausgang (an Kräfte)', disabled: true, title: 'Fernmelder erfassen nur Eingangsmeldungen' },
              { value: 'in', label: 'Eingang (an den Stab)' },
            ]}
          />
          <span className="field-hint">Mit der Fernmelder-Rolle erfassen Sie Eingangsmeldungen – Ausgangsmeldungen schreibt der Stab</span>
        </div>
      )}

      {incoming ? (
        <>
          <Field
            label="Absender *"
            hint={
              prefill?.mail
                ? `Kraft im Einsatz oder aus dem Katalog (z. B. Leitstelle) wählen – sie merkt sich ${prefill.mail.from}, Ausgangsmeldungen lassen sich dann per E-Mail senden`
                : 'Kraft aus der Kräfteverwaltung oder Freitext'
            }
          >
            <UnitSearchInput incidentId={incidentId} value={party} onChange={setParty} placeholder="z. B. ELW 1" autoFocus={party.unitId == null && party.forceUnitId == null} />
          </Field>
          <Field label="Empfänger *" hint={dispatcherRoutes ? 'Ein Dispatcher ist angemeldet und verteilt die Meldung' : undefined}>
            <select value={dispatcherRoutes ? '' : (recipientRoleId ?? '')} onChange={(e) => setRecipientRoleId(e.target.value ? Number(e.target.value) : null)} disabled={dispatcherRoutes}>
              <option value="">{dispatcherRoutes ? 'wird vom Dispatcher verteilt' : 'Rolle wählen …'}</option>
              {allRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.holders.length ? ` (${r.holders.join(', ')})` : ' – unbesetzt'}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          {myRoles.length > 1 ? (
            <Field label="Absender *" hint="Sie haben mehrere Rollen übernommen">
              <select value={senderRoleId ?? ''} onChange={(e) => setSenderRoleId(Number(e.target.value))}>
                {myRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="field">
              <span className="field-label">Absender</span>
              {myRoles[0] ? <strong>{myRoles[0].name}</strong> : <span className="tone-warn">Keine Rolle übernommen – bitte über das Profilmenü eine Rolle wählen</span>}
            </div>
          )}
          <Field label="Empfänger *" hint="Kraft aus der Kräfteverwaltung oder Freitext">
            <UnitSearchInput incidentId={incidentId} value={party} onChange={setParty} placeholder="z. B. ELW 1" autoFocus={!prefill} />
          </Field>
        </>
      )}

      <div className="field">
        <span className="field-label">
          Meldung * ({body.length}/{MESSAGE_BODY_MAX})
        </span>
        <MarkdownEditor value={body} onChange={setBody} maxLength={MESSAGE_BODY_MAX} placeholder={'Text der Meldung\n- Aufzählung mit „- “'} autoFocus={!!prefill && !prefill.mail} />
      </div>

      {!ctx?.radioConfigured && !incoming && <p className="hint tone-warn">Noch keine Fernmelder-Rolle eingestellt – niemand wird benachrichtigt (Einstellungen → Meldungen).</p>}
      {error && <p className="hint tone-alarm">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || (!incoming && senderRoleId === null)}>
          {prefill?.replyToId ? 'Antwort senden' : 'Meldung erstellen'}
        </button>
      </div>
    </form>
  );
}
