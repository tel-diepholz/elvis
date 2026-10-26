import { AlarmClock, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { messageState, type Message } from '@elvis/shared';
import { fmtTime } from '../../lib/format';
import { Badge } from '../ui';

/** „Absender: Lage → Empfänger: ELW 1“ */
export function MessageParties({ message: m }: { message: Message }) {
  return (
    <div className="message-parties">
      {m.direction === 'out' ? <ArrowUpRight size={16} className="tone-info" aria-label="Ausgang" /> : <ArrowDownLeft size={16} className="tone-ok" aria-label="Eingang" />}
      <span>
        <span className="muted">Absender:</span> <strong>{m.sender}</strong>
      </span>
      <span>
        <span className="muted">Empfänger:</span> {m.recipient !== null ? <strong>{m.recipient}</strong> : <em className="tone-warn">wartet auf Verteilung</em>}
      </span>
      {m.copies.length > 0 && (
        <span>
          <span className="muted">Kopie:</span> {m.copies.map((k) => k.role).join(', ')}
        </span>
      )}
    </div>
  );
}

/** „2× erneut versuchen, zuletzt 11:05 von Erna (+2 min) – wieder fällig 11:07“ */
export function SnoozeNote({ message: m }: { message: Message }) {
  if (!m.snoozeCount) return null;
  return (
    <span className="message-snooze">
      <AlarmClock size={13} /> {m.snoozeCount > 1 ? `${m.snoozeCount}× erneut versuchen, zuletzt` : 'Erneut versuchen:'} {fmtTime(m.snoozedAt!)} von {m.snoozedBy}
      {m.snoozeMinutes !== null && ` (+${m.snoozeMinutes} min)`}
      {m.remindAt && !m.doneAt && ` – wieder fällig ${fmtTime(m.remindAt)}`}
    </span>
  );
}

export function MessageStatus({ message: m }: { message: Message }) {
  switch (messageState(m)) {
    case 'replied':
      return <Badge tone={m.ackAt ? 'muted' : 'info'}>beantwortet</Badge>;
    case 'done':
      return <Badge tone="muted">{m.direction === 'in' ? 'zur Kenntnis genommen' : 'erledigt'}</Badge>;
    case 'routed':
      return <Badge tone="info">verteilt</Badge>;
    case 'claimed':
      return <Badge tone="warn">übernommen von {m.claimedBy}</Badge>;
    default:
      return <Badge tone="alarm">neu</Badge>;
  }
}
