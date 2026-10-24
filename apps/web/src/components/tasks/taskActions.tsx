import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fmtInterval, taskDueAt, taskIsDue, type Incident, type Task } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime, fmtTime } from '../../lib/format';
import { useActiveIncident } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

export const SNOOZE_MINUTES = [5, 15, 30, 60];

export function useTasks(incident: Incident | null | undefined) {
  return useQuery({ queryKey: ['tasks', incident?.id ?? 0], queryFn: () => api.tasks(incident!.id), enabled: !!incident && !incident.closedAt });
}

/** Fällige Aufgaben des angemeldeten Benutzers im laufenden Einsatz */
export function useDueTasks(now: Date): { incident: Incident | null; due: Task[] } {
  const { data: incident } = useActiveIncident();
  const { data: tasks = [] } = useTasks(incident);
  return { incident: incident ?? null, due: tasks.filter((t) => t.mine && taskIsDue(t, now)) };
}

/** Erledigen, Schieben, Wiederöffnen, Löschen und Dokument aus der verknüpften Vorlage anlegen */
export function useTaskActions() {
  const toast = useToast();
  const navigate = useNavigate();
  const onError = (e: Error) => toast('error', e.message);

  const done = useMutation({
    mutationFn: ({ task, final }: { task: Task; final?: boolean }) => api.taskDone(task.id, final),
    onSuccess: (t, { final }) =>
      toast('success', t.intervalMinutes !== null && !final ? `Erledigt – nächster Termin ${fmtTime(t.dueAt!)}` : final ? 'Wiederkehrende Aufgabe beendet' : 'Aufgabe erledigt'),
    onError,
  });
  const snooze = useMutation({
    mutationFn: ({ task, minutes }: { task: Task; minutes: number }) => api.snoozeTask(task.id, { minutes }),
    onSuccess: (t) => toast('success', `Geschoben auf ${fmtTime(t.snoozedUntil!)}`),
    onError,
  });
  const reopen = useMutation({ mutationFn: (task: Task) => api.reopenTask(task.id), onError });
  const remove = useMutation({ mutationFn: (task: Task) => api.removeTask(task.id), onSuccess: () => toast('success', 'Aufgabe gelöscht'), onError });
  const openTemplate = useMutation({
    mutationFn: (task: Task) => api.createFromTemplate(task.incidentId, task.documentTemplateId!),
    onSuccess: (doc) => navigate(`/dokument/${doc.id}`),
    onError,
  });
  return { done, snooze, reopen, remove, openTemplate };
}

/** „in 12 min“, „seit 1 h 5 min“ */
export function fmtRelative(iso: string, now: Date): string {
  const min = Math.round((Date.parse(iso) - now.getTime()) / 60_000);
  if (min === 0) return 'jetzt';
  return min > 0 ? `in ${fmtInterval(min)}` : `seit ${fmtInterval(-min)}`;
}

/** Fälligkeit für Listen: Uhrzeit (Datum, wenn nicht heute) und relativ */
export function fmtDue(task: Task, now: Date): string | null {
  const due = taskDueAt(task);
  if (!due) return null;
  const d = new Date(due);
  const sameDay = d.toDateString() === now.toDateString();
  return `${sameDay ? fmtTime(d) : fmtDateTime(d)} (${fmtRelative(due, now)})`;
}
