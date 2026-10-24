import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ListTodo, Pencil, Plus, Trash2 } from 'lucide-react';
import { fmtInterval, type TaskTemplate, type TaskTemplateInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Loading, Modal } from '../../components/ui';
import { TaskTemplateForm } from '../../components/tasks/TaskForm';

const afterStart = (min: number) => (min === 0 ? 'bei Einsatzbeginn' : `${fmtInterval(min)} nach Einsatzbeginn`);

function scheduleText(t: TaskTemplate): string {
  const s = t.schedule;
  if (s.kind === 'interval') return `alle ${fmtInterval(s.intervalMinutes)}, erstmals ${afterStart(s.offsetMinutes)}`;
  return s.offsetMinutes === null ? 'einmalig, ohne Termin' : `einmalig, ${afterStart(s.offsetMinutes)}`;
}

/** Aufgaben, die jeder neu eröffnete Einsatz erhält. Nur Admins. */
export function TaskTemplatesCard() {
  const toast = useToast();
  const { data: templates } = useQuery({ queryKey: ['taskTemplates'], queryFn: api.taskTemplates });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TaskTemplate | null>(null);
  const onError = (e: Error) => toast('error', e.message);

  const create = useMutation({ mutationFn: api.createTaskTemplate, onSuccess: () => setCreating(false), onError });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: number; input: TaskTemplateInput }) => api.updateTaskTemplate(id, input),
    onSuccess: () => setEditing(null),
    onError,
  });
  const remove = useMutation({ mutationFn: api.removeTaskTemplate, onError });
  const reorder = useMutation({ mutationFn: api.reorderTaskTemplates, onError });

  if (!templates) return <Loading />;
  const move = (i: number, d: -1 | 1) => {
    const ids = templates.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <Card
      title="Aufgabenvorlagen"
      icon={<ListTodo size={18} />}
      className="span-2"
      actions={
        <button className="btn btn-sm" onClick={() => setCreating(true)}>
          <Plus size={16} /> Vorlage
        </button>
      }
    >
      <p className="muted">Diese Aufgaben erhält jeder neu eröffnete Einsatz. Zeiten zählen ab Einsatzbeginn; Änderungen gelten nur für künftige Einsätze.</p>
      {templates.length === 0 ? (
        <EmptyState title="Keine Aufgabenvorlagen" />
      ) : (
        <ul className="simple-list">
          {templates.map((t, i) => (
            <li key={t.id}>
              <div className="grow">
                <div className="cell-title">
                  {t.summary} <Badge tone={t.roleName ? 'info' : 'muted'}>{t.roleName ?? 'Alle'}</Badge>
                </div>
                <div className="cell-sub">
                  {scheduleText(t)}
                  {t.documentTemplateName && ` · Vorlage: ${t.documentTemplateName}`}
                </div>
              </div>
              <button className="btn btn-ghost btn-icon" aria-label="Nach oben" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                <ArrowUp size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" aria-label="Nach unten" disabled={i === templates.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                <ArrowDown size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" aria-label={`${t.summary} bearbeiten`} onClick={() => setEditing(t)}>
                <Pencil size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" aria-label={`${t.summary} löschen`} onClick={() => window.confirm(`Vorlage „${t.summary}“ löschen?`) && remove.mutate(t.id)}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={creating} title="Aufgabenvorlage anlegen" onClose={() => setCreating(false)}>
        <TaskTemplateForm pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
      <Modal open={!!editing} title="Aufgabenvorlage bearbeiten" onClose={() => setEditing(null)}>
        {editing && <TaskTemplateForm initial={editing} pending={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Modal>
    </Card>
  );
}
