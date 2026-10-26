import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, Mail } from 'lucide-react';
import { useNow } from '../../lib/hooks';
import { fmtAgo } from '../../lib/format';
import { MessageDialog } from './MessageDialog';
import { markdownPreview } from './Markdown';
import { MESSAGES_PATH, PENDING_LABEL, useMessageAttention } from './messageHooks';

/** Kopfzeile: Anzahl Meldungen, um die ich mich kümmern soll; führt zur Meldungsliste */
export function MessagesButton() {
  const { incident, attention } = useMessageAttention(useNow());
  if (!incident) return null;
  return (
    <Link to={MESSAGES_PATH} className={`btn btn-ghost btn-icon alert-btn ${attention.length ? 'tone-alarm' : ''}`} aria-label={`${attention.length} Meldungen offen`} title="Meldungen">
      <Mail size={20} />
      {attention.length > 0 && <span className="alert-count badge-alarm">{attention.length}</span>}
    </Link>
  );
}

/** Kurzer Ton, wenn neue Meldungen dazukommen */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    // ohne Audio (z. B. vor der ersten Bedienung) bleibt es beim Hinweis
  }
}

/** Hinweis unten links für neue Meldungen, erneute Versuche und Antworten – Klick öffnet die Meldung */
export function MessagesPanel() {
  const now = useNow();
  const { incident, attention } = useMessageAttention(now);
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  // Neue Einträge: Ton und wieder aufklappen
  const seen = useRef<Set<string> | null>(null);
  const keys = attention.map((m) => `${m.id}:${m.pending}:${m.remindAt ?? ''}`);
  useEffect(() => {
    const fresh = keys.filter((k) => !seen.current?.has(k));
    if (seen.current && fresh.length) {
      beep();
      setCollapsed(false);
    }
    seen.current = new Set(keys);
  }, [keys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!incident) return null;
  const dialog = <MessageDialog incident={incident} messageId={openId} onClose={() => setOpenId(null)} />;
  if (!attention.length || pathname === MESSAGES_PATH) return dialog;

  if (collapsed) {
    return (
      <>
        <button className="due-panel due-panel-collapsed" onClick={() => setCollapsed(false)}>
          <Mail size={18} /> {attention.length} {attention.length === 1 ? 'Meldung' : 'Meldungen'}
        </button>
        {dialog}
      </>
    );
  }

  return (
    <>
      <section className="due-panel" role="alert" aria-label="Meldungen">
        <header className="due-panel-head">
          <Mail size={18} />
          <strong>{attention.length === 1 ? 'Meldung' : `${attention.length} Meldungen`}</strong>
          <button className="btn btn-ghost btn-icon" onClick={() => setCollapsed(true)} aria-label="Einklappen">
            <ChevronDown size={18} />
          </button>
        </header>
        <ul className="due-list">
          {attention.slice(0, 3).map((m) => (
            <li key={m.id}>
              <button type="button" className="message-alert" onClick={() => setOpenId(m.id)}>
                <span className="due-summary">{m.remindAt ? 'Erneut versuchen' : PENDING_LABEL[m.pending!]}</span>
                <span className="cell-sub">
                  {m.sender} → {m.recipient ?? 'Verteilung'} · {fmtAgo(m.repliedAt ?? m.createdAt, now)}
                </span>
                <span className="message-alert-preview">{markdownPreview(m.pending === 'reply' ? (m.reply ?? '') : m.body)}</span>
              </button>
            </li>
          ))}
        </ul>
        <Link to={MESSAGES_PATH} className="due-more">
          {attention.length > 3 ? `${attention.length - 3} weitere – ` : ''}Alle Meldungen
        </Link>
      </section>
      {dialog}
    </>
  );
}
