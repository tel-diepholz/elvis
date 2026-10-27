import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { AlarmClock, Check, CircleCheckBig, Clock, FileText, ListChecks, PackagePlus, Pencil, Plus, Repeat, Square, Trash2, Undo2 } from 'lucide-react';
import { fmtInterval, taskIsDue, type Incident, type Task, type TaskInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Loading, Modal, Segmented } from '../../components/ui';
import { TaskForm } from '../../components/tasks/TaskForm';
import { fmtDue, SNOOZE_MINUTES, useTaskActions, useTasks } from '../../components/tasks/taskActions';
import { REQUESTS_PATH } from '../../components/requests/requestParts';

type Filter = 'mine' | 'all' | 'done';

function AssigneeBadge({ task }: { task: Task }) {
  if (task.assignee.kind === 'all') return <Badge>Alle</Badge>;
  if (task.roleVacant) return <Badge tone="warn">{task.assigneeName} · unbesetzt, für alle</Badge>;
  return <Badge tone="info">{task.assigneeName ?? 'unbekannt'}</Badge>;
}

function TaskItem({ task, now, onEdit }: { task: Task; now: Date; onEdit: () => void }) {
  const { done, snooze, reopen, remove, openTemplate } = useTaskActions();
  const [expanded, setExpanded] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const due = taskIsDue(task, now);
  const recurring = task.intervalMinutes !== null;
  const dueText = fmtDue(task, now);

  return (
    <li className={`task ${due ? 'task-due' : ''} ${task.doneAt ? 'task-done' : ''}`}>
      <div className="task-row">
        {task.doneAt ? (
          <button className="btn btn-ghost btn-icon" onClick={() => reopen.mutate(task)} title="Wieder öffnen" aria-label="Wieder öffnen">
            <Undo2 size={18} />
          </button>
        ) : (
          <button className="btn btn-icon task-check" onClick={() => done.mutate({ task })} disabled={done.isPending} title={recurring ? 'Durchgang erledigt' : 'Erledigt'} aria-label="Erledigt">
            <Check size={18} />
          </button>
        )}
        <button type="button" className="task-main" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          <span className="task-summary">{task.summary}</span>
          <span className="task-meta">
            {task.doneAt ? (
              <span>
                erledigt {fmtDateTime(task.doneAt)} von {task.doneBy}
              </span>
            ) : (
              dueText && (
                <span className={due ? 'tone-alarm' : ''}>
                  {task.snoozedUntil ? <AlarmClock size={13} /> : <Clock size={13} />} {due ? 'fällig' : ''} {dueText}
                  {task.snoozedUntil && ' · geschoben'}
                </span>
              )
            )}
            {recurring && (
              <span>
                <Repeat size={13} /> alle {fmtInterval(task.intervalMinutes!)}
              </span>
            )}
            <AssigneeBadge task={task} />
          </span>
        </button>
        {!task.doneAt && (
          <div className="task-actions">
            <button className={`btn btn-sm ${snoozing ? 'btn-primary' : ''}`} onClick={() => setSnoozing((s) => !s)} title="Schieben">
              <AlarmClock size={16} /> <span className="desktop-only">Schieben</span>
            </button>
            <button className="btn btn-ghost btn-icon" onClick={onEdit} aria-label="Bearbeiten">
              <Pencil size={16} />
            </button>
          </div>
        )}
      </div>
      {snoozing && !task.doneAt && (
        <div className="task-snooze chip-row">
          {SNOOZE_MINUTES.map((m) => (
            <button key={m} className="btn btn-sm" disabled={snooze.isPending} onClick={() => snooze.mutate({ task, minutes: m }, { onSuccess: () => setSnoozing(false) })}>
              +{fmtInterval(m)}
            </button>
          ))}
        </div>
      )}
      {expanded && (
        <div className="task-detail">
          {task.description ? <p className="task-desc">{task.description}</p> : <p className="muted">Keine Beschreibung</p>}
          <p className="cell-sub">
            Angelegt {fmtDateTime(task.createdAt)} von {task.createdBy}
            {task.lastDoneAt && recurring && ` · zuletzt erledigt ${fmtDateTime(task.lastDoneAt)} von ${task.lastDoneBy}`}
          </p>
          <div className="btn-row">
            {task.requestId !== null && (
              <Link className="btn btn-sm btn-primary" to={`${REQUESTS_PATH}?id=${task.requestId}`}>
                <PackagePlus size={16} /> Anforderung öffnen
              </Link>
            )}
            {task.documentTemplateId !== null && !task.doneAt && (
              <button className="btn btn-sm" disabled={openTemplate.isPending} onClick={() => openTemplate.mutate(task)}>
                <FileText size={16} /> {task.documentTemplateName ?? 'Vorlage'} ausfüllen
              </button>
            )}
            {recurring && !task.doneAt && (
              <button className="btn btn-sm" onClick={() => window.confirm(`„${task.summary}“ nicht mehr wiederholen?`) && done.mutate({ task, final: true })}>
                <Square size={16} /> Serie beenden
              </button>
            )}
            <button className="btn btn-sm btn-danger" onClick={() => window.confirm(`Aufgabe „${task.summary}“ löschen?`) && remove.mutate(task)}>
              <Trash2 size={16} /> Löschen
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function TasksView({ incident }: { incident: Incident }) {
  const toast = useToast();
  const now = useNow();
  const { data: tasks, isLoading } = useTasks(incident);
  const [filter, setFilter] = useState<Filter>('mine');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);

  const create = useMutation({
    mutationFn: (input: TaskInput) => api.createTask(incident.id, input),
    onSuccess: (t) => (setCreating(false), toast('success', `Aufgabe „${t.summary}“ angelegt`)),
    onError: (e) => toast('error', e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: number; input: TaskInput }) => api.updateTask(id, input),
    onSuccess: () => setEditing(null),
    onError: (e) => toast('error', e.message),
  });

  if (isLoading || !tasks) return <Loading />;

  const open = tasks.filter((t) => !t.doneAt);
  const lists: Record<Filter, Task[]> = {
    mine: open.filter((t) => t.mine),
    all: open,
    // zuletzt erledigte oben
    done: tasks.filter((t) => t.doneAt).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!)),
  };
  const shown = lists[filter];
  const dueCount = lists.mine.filter((t) => taskIsDue(t, now)).length;

  return (
    <>
      <Card
        title={dueCount ? `${dueCount} fällig` : 'Aufgaben'}
        icon={<ListChecks size={18} />}
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus size={16} /> Aufgabe
          </button>
        }
      >
        <Segmented<Filter>
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'mine', label: `Meine (${lists.mine.length})` },
            { value: 'all', label: `Alle offenen (${lists.all.length})` },
            { value: 'done', label: `Erledigt (${lists.done.length})` },
          ]}
        />
        {shown.length === 0 ? (
          <EmptyState icon={<CircleCheckBig size={36} />} title={filter === 'done' ? 'Noch nichts erledigt' : 'Keine offenen Aufgaben'} />
        ) : (
          <ul className="task-list">
            {shown.map((t) => (
              <TaskItem key={t.id} task={t} now={now} onEdit={() => setEditing(t)} />
            ))}
          </ul>
        )}
      </Card>

      <Modal open={creating} title="Neue Aufgabe" onClose={() => setCreating(false)}>
        <TaskForm pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
      <Modal open={!!editing} title="Aufgabe bearbeiten" onClose={() => setEditing(null)}>
        {editing && <TaskForm initial={editing} pending={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Modal>
    </>
  );
}
