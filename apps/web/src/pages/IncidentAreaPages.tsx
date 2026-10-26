import { PageHeader } from '../components/ui';
import { RequireIncident } from '../components/RequireIncident';
import { DocumentsView } from './incident/DocumentsView';
import { JournalView } from './incident/JournalView';
import { MessagesView } from './incident/MessagesView';
import { TasksView } from './incident/TasksView';
import { UnitsView } from './incident/UnitsView';

const subtitle = (i: { keyword: string; title: string }) => [i.keyword, i.title].filter(Boolean).join(' · ');

export function JournalPage() {
  return (
    <RequireIncident>
      {(incident) => (
        <>
          <PageHeader title="Einsatztagebuch" subtitle={subtitle(incident)} />
          <JournalView incident={incident} />
        </>
      )}
    </RequireIncident>
  );
}

export function TasksPage() {
  return (
    <RequireIncident>
      {(incident) => (
        <>
          <PageHeader title="Aufgaben" subtitle={subtitle(incident)} />
          <TasksView incident={incident} />
        </>
      )}
    </RequireIncident>
  );
}

export function MessagesPage() {
  return (
    <RequireIncident>
      {(incident) => (
        <>
          <PageHeader title="Meldungen" subtitle={subtitle(incident)} />
          <MessagesView incident={incident} />
        </>
      )}
    </RequireIncident>
  );
}

export function UnitsPage() {
  return (
    <RequireIncident>
      {(incident) => (
        <>
          <PageHeader title="Kräfteübersicht" subtitle={subtitle(incident)} />
          <UnitsView incident={incident} />
        </>
      )}
    </RequireIncident>
  );
}

export function DocumentsPage() {
  return (
    <RequireIncident>
      {(incident) => (
        <>
          <PageHeader title="Dokumente" subtitle={subtitle(incident)} />
          <DocumentsView incident={incident} />
        </>
      )}
    </RequireIncident>
  );
}
