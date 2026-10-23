import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, Download, PencilLine, Send, X } from 'lucide-react';
import { JOURNAL_CATEGORY_LABELS, type Incident, type JournalCategory, type JournalEntry } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime, fmtTimeSec } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Field, Loading } from '../../components/ui';

const MANUAL_CATEGORIES = (Object.keys(JOURNAL_CATEGORY_LABELS) as JournalCategory[]).filter((c) => c !== 'system');

/** Local datetime-local value → ISO with offset. */
const localToIso = (v: string) => new Date(v).toISOString();

function EntryForm({ incident, correcting, onDone }: { incident: Incident; correcting: JournalEntry | null; onDone: () => void }) {
  const toast = useToast();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [category, setCategory] = useState<JournalCategory>('meldung');
  const [sender, setSender] = useState('');
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');
  const [important, setImportant] = useState(false);
  const [backdate, setBackdate] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api.addJournal(incident.id, {
        category: correcting ? correcting.category : category,
        sender,
        recipient,
        text,
        important,
        correctsId: correcting?.id ?? null,
        timestamp: backdate ? localToIso(backdate) : undefined,
      }),
    onSuccess: () => {
      setText('');
      setImportant(false);
      setBackdate('');
      onDone();
      textRef.current?.focus();
    },
    onError: (e) => toast('error', e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) add.mutate();
  };

  return (
    <form className="form journal-form" onSubmit={submit}>
      {correcting && (
        <div className="banner banner-info">
          <PencilLine size={16} /> Korrektur zu Nr. {correcting.id}: „{correcting.text.slice(0, 80)}“
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
            <X size={14} /> Abbrechen
          </button>
        </div>
      )}
      <div className="form-grid journal-meta">
        {!correcting && (
          <Field label="Art">
            <select value={category} onChange={(e) => setCategory(e.target.value as JournalCategory)}>
              {MANUAL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {JOURNAL_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Von">
          <input value={sender} onChange={(e) => setSender(e.target.value)} placeholder="Absender" maxLength={100} list="journal-parties" />
        </Field>
        <Field label="An">
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Empfänger" maxLength={100} list="journal-parties" />
        </Field>
        <Field label="Zeitpunkt" hint={backdate ? 'Nachtrag' : 'leer = jetzt'}>
          <input type="datetime-local" value={backdate} onChange={(e) => setBackdate(e.target.value)} />
        </Field>
      </div>
      <Field label="Inhalt">
        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="Meldung, Lage, Auftrag … (Strg+Enter zum Speichern)"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e);
          }}
        />
      </Field>
      <div className="form-actions spread">
        <label className="checkbox">
          <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} /> Wichtig
        </label>
        <button type="submit" className="btn btn-primary" disabled={add.isPending || !text.trim()}>
          <Send size={16} /> Eintragen
        </button>
      </div>
    </form>
  );
}

export function JournalView({ incident, readOnly }: { incident: Incident; readOnly?: boolean }) {
  const { data: entries, isLoading } = useQuery({ queryKey: ['journal', incident.id], queryFn: () => api.journal(incident.id) });
  const [filter, setFilter] = useState<JournalCategory | 'all' | 'manual'>('all');
  const [query, setQuery] = useState('');
  const [correcting, setCorrecting] = useState<JournalEntry | null>(null);

  const correctedBy = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const e of entries ?? []) if (e.correctsId) map.set(e.correctsId, [...(map.get(e.correctsId) ?? []), e.id]);
    return map;
  }, [entries]);

  const parties = useMemo(() => [...new Set((entries ?? []).flatMap((e) => [e.sender, e.recipient]).filter(Boolean))], [entries]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? [])
      .filter((e) => filter === 'all' || (filter === 'manual' ? e.category !== 'system' : e.category === filter))
      .filter((e) => !q || [e.text, e.sender, e.recipient, e.author].some((v) => v.toLowerCase().includes(q)))
      .slice()
      .reverse();
  }, [entries, filter, query]);

  return (
    <div className="grid">
      {!readOnly && (
        <Card title="Neuer Eintrag" className="span-3">
          <EntryForm incident={incident} correcting={correcting} onDone={() => setCorrecting(null)} />
          <datalist id="journal-parties">
            {parties.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Card>
      )}
      <Card
        title={`Einträge (${entries?.length ?? 0})`}
        className="span-3"
        actions={
          <a className="btn btn-sm" href={api.journalCsvUrl(incident.id)} download>
            <Download size={14} /> CSV
          </a>
        }
      >
        <div className="toolbar">
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Filter">
            <option value="all">Alle Einträge</option>
            <option value="manual">Ohne Systemeinträge</option>
            {(Object.keys(JOURNAL_CATEGORY_LABELS) as JournalCategory[]).map((c) => (
              <option key={c} value={c}>
                {JOURNAL_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <input type="search" placeholder="Suchen …" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {isLoading ? (
          <Loading />
        ) : visible.length === 0 ? (
          <EmptyState title="Keine Einträge" />
        ) : (
          <ol className="journal">
            {visible.map((e) => (
              <li key={e.id} className={`journal-entry cat-${e.category} ${e.important ? 'important' : ''} ${correctedBy.has(e.id) ? 'corrected' : ''}`}>
                <div className="journal-time">
                  <span className="mono">{fmtTimeSec(e.timestamp)}</span>
                  <span className="journal-nr">Nr. {e.id}</span>
                </div>
                <div className="journal-main">
                  <div className="journal-head">
                    <Badge tone={e.category === 'system' ? 'muted' : e.category === 'entscheidung' || e.category === 'auftrag' ? 'warn' : 'info'}>
                      {JOURNAL_CATEGORY_LABELS[e.category]}
                    </Badge>
                    {e.important && (
                      <span className="tone-alarm">
                        <AlertCircle size={14} /> wichtig
                      </span>
                    )}
                    {(e.sender || e.recipient) && (
                      <span className="journal-parties">
                        {e.sender || '?'} → {e.recipient || '?'}
                      </span>
                    )}
                  </div>
                  <p className="journal-text">{e.text}</p>
                  <div className="journal-foot">
                    <span>{e.author}</span>
                    {e.recordedAt.slice(0, 19) !== e.timestamp.slice(0, 19) && <span>erfasst {fmtDateTime(e.recordedAt)}</span>}
                    {e.correctsId && <span>Korrektur zu Nr. {e.correctsId}</span>}
                    {correctedBy.has(e.id) && <span className="tone-warn">korrigiert durch Nr. {correctedBy.get(e.id)!.join(', ')}</span>}
                    {!readOnly && e.category !== 'system' && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setCorrecting(e)}>
                        <PencilLine size={14} /> Korrigieren
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
