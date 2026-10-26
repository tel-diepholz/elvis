import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  folderPath,
  TASK_SUMMARY_MAX,
  taskInputSchema,
  taskSchedule,
  taskTemplateInputSchema,
  type Task,
  type TaskAssignee,
  type TaskInput,
  type TaskTemplate,
  type TaskTemplateInput,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLive } from '../../lib/live';
import { Field, Segmented } from '../ui';

const p2 = (n: number) => String(n).padStart(2, '0');
/** ISO → Wert für <input type="datetime-local"> (Ortszeit) */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

/** Gemeinsame Felder: Kurztext, Beschreibung, Dokumentvorlage */
function BaseFields({ summary, setSummary, description, setDescription, templateId, setTemplateId }: {
  summary: string;
  setSummary: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  templateId: number | null;
  setTemplateId: (v: number | null) => void;
}) {
  const { data: tree } = useQuery({ queryKey: ['templates'], queryFn: api.templates });
  const templates = (tree?.templates ?? [])
    .map((t) => ({ id: t.id, label: [folderPath(tree!.folders, t.folderId), t.name].filter(Boolean).join(' / ') }))
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));
  return (
    <>
      <Field label={`Kurztext * (${summary.length}/${TASK_SUMMARY_MAX})`} hint="Erscheint in Listen und im Fälligkeitshinweis">
        <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={TASK_SUMMARY_MAX} placeholder="z. B. Treibstoff bestellen" required autoFocus />
      </Field>
      <Field label="Beschreibung">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={4000} placeholder="Was ist zu tun, wen anrufen, worauf achten …" />
      </Field>
      <Field label="Dokumentvorlage" hint="Lässt sich aus der Aufgabe heraus direkt als Einsatzdokument anlegen">
        <select value={templateId ?? ''} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Keine</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

/** Intervall als Stunden + Minuten (1,5 h = 1 h 30 min) */
function IntervalField({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return (
    <Field label="Wiederholen alle">
      <div className="interval-input">
        <input type="number" min={0} max={168} value={h} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0) * 60 + m)} aria-label="Stunden" />
        <span>h</span>
        <input type="number" min={0} max={59} step={5} value={m} onChange={(e) => onChange(h * 60 + Math.min(59, Math.max(0, Number(e.target.value) || 0)))} aria-label="Minuten" />
        <span>min</span>
      </div>
    </Field>
  );
}

type DueMode = 'none' | 'in' | 'at';

function DueFields({ label, mode, setMode, inMinutes, setInMinutes, at, setAt, allowNone }: {
  label: string;
  mode: DueMode;
  setMode: (m: DueMode) => void;
  inMinutes: number;
  setInMinutes: (m: number) => void;
  at: string;
  setAt: (v: string) => void;
  allowNone: boolean;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <Segmented<DueMode>
        label={label}
        value={mode}
        onChange={setMode}
        options={[...(allowNone ? [{ value: 'none' as const, label: 'Ohne Termin' }] : []), { value: 'in', label: 'In …' }, { value: 'at', label: 'Zeitpunkt' }]}
      />
      {mode === 'in' && (
        <div className="interval-input">
          <input type="number" min={1} max={10080} value={inMinutes} onChange={(e) => setInMinutes(Math.max(1, Number(e.target.value) || 1))} aria-label="Minuten" />
          <span>Minuten</span>
          <div className="chip-row">
            {[5, 15, 30, 60, 120].map((m) => (
              <button key={m} type="button" className={`btn btn-sm ${inMinutes === m ? 'btn-primary' : ''}`} onClick={() => setInMinutes(m)}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === 'at' && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />}
    </div>
  );
}

const encodeAssignee = (a: TaskAssignee) => (a.kind === 'all' ? 'all' : a.kind === 'user' ? `user:${a.userId}` : `role:${a.roleId}`);
function decodeAssignee(v: string): TaskAssignee {
  const [kind, id] = v.split(':');
  if (kind === 'user') return { kind: 'user', userId: Number(id) };
  if (kind === 'role') return { kind: 'role', roleId: Number(id) };
  return { kind: 'all' };
}

function FormShell({ onSubmit, error, pending, submitLabel, children }: { onSubmit: () => void; error: string | null; pending: boolean; submitLabel: string; children: ReactNode }) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form className="form" onSubmit={submit}>
      {children}
      {error && <p className="hint tone-alarm">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Vorbelegung einer neuen Aufgabe, z. B. aus einer Meldung */
export interface TaskPrefill {
  summary?: string;
  description?: string;
  assignee?: TaskAssignee;
}

/** Aufgabe im Einsatz anlegen oder bearbeiten */
export function TaskForm({ initial, prefill, pending, onSubmit }: { initial?: Task; prefill?: TaskPrefill; pending: boolean; onSubmit: (t: TaskInput) => void }) {
  const { user } = useAuth();
  const { clockOffsetMs } = useLive();
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const schedule = initial ? taskSchedule(initial) : null;

  const [summary, setSummary] = useState(initial?.summary ?? prefill?.summary ?? '');
  const [description, setDescription] = useState(initial?.description ?? prefill?.description ?? '');
  const [templateId, setTemplateId] = useState<number | null>(initial?.documentTemplateId ?? null);
  const [assignee, setAssignee] = useState(encodeAssignee(initial?.assignee ?? prefill?.assignee ?? { kind: 'all' }));
  const [recurring, setRecurring] = useState(schedule?.kind === 'interval');
  const [interval, setIntervalMinutes] = useState(schedule?.kind === 'interval' ? schedule.intervalMinutes : 90);
  const [dueMode, setDueMode] = useState<DueMode>(schedule?.dueAt ? 'at' : initial ? 'none' : 'in');
  const [inMinutes, setInMinutes] = useState(15);
  const [at, setAt] = useState(schedule?.dueAt ? toLocalInput(schedule.dueAt) : '');
  const [error, setError] = useState<string | null>(null);

  // Bestehende Zuweisung an einen anderen Benutzer bleibt wählbar
  const otherUser = initial?.assignee.kind === 'user' && initial.assignee.userId !== user?.id ? initial : null;

  const submit = () => {
    const now = Date.now() + clockOffsetMs;
    const dueAt = dueMode === 'none' ? null : dueMode === 'in' ? new Date(now + inMinutes * 60_000).toISOString() : fromLocalInput(at);
    const input = {
      summary,
      description,
      documentTemplateId: templateId,
      assignee: decodeAssignee(assignee),
      schedule: recurring ? { kind: 'interval' as const, intervalMinutes: interval, dueAt: dueAt ?? '' } : { kind: 'once' as const, dueAt },
    };
    const parsed = taskInputSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Eingaben prüfen');
    setError(null);
    onSubmit(parsed.data);
  };

  return (
    <FormShell onSubmit={submit} error={error} pending={pending} submitLabel={initial ? 'Speichern' : 'Aufgabe anlegen'}>
      <BaseFields summary={summary} setSummary={setSummary} description={description} setDescription={setDescription} templateId={templateId} setTemplateId={setTemplateId} />
      <Field label="Verantwortlich" hint="Ohne Verantwortlichen erhalten alle die Aufgabe. Ist die Rolle im Einsatz unbesetzt, sehen sie alle.">
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="all">Alle</option>
          {user && <option value={`user:${user.id}`}>Ich selbst</option>}
          {otherUser && <option value={encodeAssignee(otherUser.assignee)}>{otherUser.assigneeName}</option>}
          {roles.length > 0 && (
            <optgroup label="Rolle">
              {roles.map((r) => (
                <option key={r.id} value={`role:${r.id}`}>
                  {r.name}
                  {r.holders.length ? ` (${r.holders.join(', ')})` : ' (unbesetzt)'}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>
      <div className="field">
        <span className="field-label">Art</span>
        <Segmented<'once' | 'interval'>
          label="Art"
          value={recurring ? 'interval' : 'once'}
          onChange={(v) => {
            setRecurring(v === 'interval');
            // Wiederkehrende brauchen einen ersten Termin
            if (v === 'interval' && dueMode === 'none') setDueMode('in');
          }}
          options={[
            { value: 'once', label: 'Einmalig' },
            { value: 'interval', label: 'Wiederkehrend' },
          ]}
        />
      </div>
      {recurring && <IntervalField minutes={interval} onChange={setIntervalMinutes} />}
      <DueFields
        label={recurring ? 'Erstmals fällig' : 'Fällig'}
        mode={dueMode}
        setMode={setDueMode}
        inMinutes={inMinutes}
        setInMinutes={setInMinutes}
        at={at}
        setAt={setAt}
        allowNone={!recurring}
      />
    </FormShell>
  );
}

/** Aufgabenvorlage (Einstellungen): Zeiten relativ zum Einsatzbeginn */
export function TaskTemplateForm({ initial, pending, onSubmit }: { initial?: TaskTemplate; pending: boolean; onSubmit: (t: TaskTemplateInput) => void }) {
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const s = initial?.schedule;
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [templateId, setTemplateId] = useState<number | null>(initial?.documentTemplateId ?? null);
  const [roleId, setRoleId] = useState<number | null>(initial?.roleId ?? null);
  const [recurring, setRecurring] = useState(s?.kind === 'interval');
  const [interval, setIntervalMinutes] = useState(s?.kind === 'interval' ? s.intervalMinutes : 90);
  const [timed, setTimed] = useState(s ? s.offsetMinutes !== null : false);
  const [offset, setOffset] = useState(s?.offsetMinutes ?? 30);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const input = {
      summary,
      description,
      documentTemplateId: templateId,
      roleId,
      schedule: recurring ? { kind: 'interval' as const, intervalMinutes: interval, offsetMinutes: offset } : { kind: 'once' as const, offsetMinutes: timed ? offset : null },
    };
    const parsed = taskTemplateInputSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Eingaben prüfen');
    setError(null);
    onSubmit(parsed.data);
  };

  return (
    <FormShell onSubmit={submit} error={error} pending={pending} submitLabel={initial ? 'Speichern' : 'Vorlage anlegen'}>
      <BaseFields summary={summary} setSummary={setSummary} description={description} setDescription={setDescription} templateId={templateId} setTemplateId={setTemplateId} />
      <Field label="Verantwortlich">
        <select value={roleId ?? ''} onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Alle</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="field">
        <span className="field-label">Art</span>
        <Segmented<'once' | 'interval'>
          label="Art"
          value={recurring ? 'interval' : 'once'}
          onChange={(v) => setRecurring(v === 'interval')}
          options={[
            { value: 'once', label: 'Einmalig' },
            { value: 'interval', label: 'Wiederkehrend' },
          ]}
        />
      </div>
      {recurring && <IntervalField minutes={interval} onChange={setIntervalMinutes} />}
      {!recurring && (
        <div className="field">
          <span className="field-label">Fällig</span>
          <Segmented<'none' | 'offset'>
            label="Fällig"
            value={timed ? 'offset' : 'none'}
            onChange={(v) => setTimed(v === 'offset')}
            options={[
              { value: 'none', label: 'Ohne Termin' },
              { value: 'offset', label: 'Nach Einsatzbeginn' },
            ]}
          />
        </div>
      )}
      {(recurring || timed) && (
        <Field label={recurring ? 'Erstmals fällig nach Einsatzbeginn' : 'Minuten nach Einsatzbeginn'}>
          <div className="interval-input">
            <input type="number" min={0} max={10080} value={offset} onChange={(e) => setOffset(Math.max(0, Number(e.target.value) || 0))} aria-label="Minuten" />
            <span>Minuten</span>
          </div>
        </Field>
      )}
    </FormShell>
  );
}
