import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Check, ChevronDown, ListChecks, PackagePlus } from 'lucide-react';
import { fmtInterval, taskDueAt } from '@elvis/shared';
import { useNow } from '../../lib/hooks';
import { fmtRelative, useDueTasks, useTaskActions } from './taskActions';
import { REQUESTS_PATH } from '../requests/requestParts';

const TASKS_PATH = '/einsatz/aufgaben';

/** Kopfzeile: Anzahl fälliger eigener Aufgaben, führt zur Aufgabenliste */
export function DueTasksButton() {
  const { incident, due } = useDueTasks(useNow());
  if (!incident) return null;
  return (
    <Link to={TASKS_PATH} className={`btn btn-ghost btn-icon alert-btn ${due.length ? 'tone-alarm' : ''}`} aria-label={`${due.length} Aufgaben fällig`} title="Aufgaben">
      <ListChecks size={20} />
      {due.length > 0 && <span className="alert-count badge-alarm">{due.length}</span>}
    </Link>
  );
}

/** Hinweis unten rechts, sobald eigene Aufgaben fällig sind: erledigen oder schieben, ohne die Seite zu wechseln */
export function DueTasksPanel() {
  const now = useNow();
  const { due } = useDueTasks(now);
  const { done, snooze } = useTaskActions();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  if (!due.length || pathname === TASKS_PATH) return null;

  if (collapsed) {
    return (
      <button className="due-panel due-panel-collapsed" onClick={() => setCollapsed(false)}>
        <ListChecks size={18} /> {due.length} {due.length === 1 ? 'Aufgabe' : 'Aufgaben'} fällig
      </button>
    );
  }

  return (
    <section className="due-panel" role="alert" aria-label="Fällige Aufgaben">
      <header className="due-panel-head">
        <ListChecks size={18} />
        <strong>{due.length === 1 ? 'Aufgabe fällig' : `${due.length} Aufgaben fällig`}</strong>
        <button className="btn btn-ghost btn-icon" onClick={() => setCollapsed(true)} aria-label="Einklappen">
          <ChevronDown size={18} />
        </button>
      </header>
      <ul className="due-list">
        {due.slice(0, 3).map((task) => (
          <li key={task.id}>
            <div className="due-summary">{task.summary}</div>
            <div className="cell-sub">fällig {fmtRelative(taskDueAt(task)!, now)}</div>
            <div className="btn-row">
              {/* Wiedervorlage einer Anforderung: dort Status oder neue Wiedervorlage eintragen */}
              {task.requestId !== null ? (
                <Link className="btn btn-sm btn-primary" to={`${REQUESTS_PATH}?id=${task.requestId}`}>
                  <PackagePlus size={16} /> Anforderung
                </Link>
              ) : (
                <button className="btn btn-sm btn-primary" disabled={done.isPending} onClick={() => done.mutate({ task })}>
                  <Check size={16} /> Erledigt
                </button>
              )}
              {[5, 15].map((m) => (
                <button key={m} className="btn btn-sm" disabled={snooze.isPending} onClick={() => snooze.mutate({ task, minutes: m })}>
                  +{fmtInterval(m)}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <Link to={TASKS_PATH} className="due-more">
        {due.length > 3 ? `${due.length - 3} weitere – ` : ''}Alle Aufgaben
      </Link>
    </section>
  );
}
