import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime, fmtDuration } from '../lib/format';
import { Badge, Card, EmptyState, Loading, PageHeader, Segmented } from '../components/ui';
import { DocumentsView } from './incident/DocumentsView';
import { JournalView } from './incident/JournalView';
import { UnitsView } from './incident/UnitsView';

export function ArchivePage() {
  const { data: incidents, isLoading } = useQuery({ queryKey: ['incident', 'list'], queryFn: api.incidents });
  return (
    <>
      <PageHeader title="Einsatzarchiv" subtitle="Abgeschlossene Einsätze – schreibgeschützt" />
      <Card>
        {isLoading ? (
          <Loading />
        ) : !incidents?.length ? (
          <EmptyState icon={<Archive size={40} />} title="Noch keine Einsätze" />
        ) : (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Beginn</th>
                  <th>Einsatz</th>
                  <th>Ort</th>
                  <th>Dauer</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{fmtDateTime(i.startedAt)}</td>
                    <td>
                      <Link to={i.closedAt ? `/archiv/${i.id}` : '/einsatz'} className="cell-title">
                        {[i.keyword, i.title].filter(Boolean).join(' · ')}
                      </Link>
                    </td>
                    <td>{i.location || '–'}</td>
                    <td className="mono">{fmtDuration(i.startedAt, i.closedAt ?? new Date())}</td>
                    <td>{i.closedAt ? <Badge>abgeschlossen</Badge> : <Badge tone="alarm">läuft</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

type Tab = 'journal' | 'units' | 'documents';

export function ArchivedIncidentPage() {
  const id = Number(useParams().id);
  const [tab, setTab] = useState<Tab>('journal');
  const { data: incident, isLoading, error } = useQuery({ queryKey: ['incident', id], queryFn: () => api.incident(id) });

  if (isLoading) return <Loading />;
  if (!incident) return <EmptyState title="Einsatz nicht gefunden">{error?.message}</EmptyState>;

  return (
    <>
      <PageHeader
        title={[incident.keyword, incident.title].filter(Boolean).join(' · ')}
        subtitle={`${fmtDateTime(incident.startedAt)} – ${incident.closedAt ? fmtDateTime(incident.closedAt) : 'läuft'} · ${incident.location || 'ohne Ortsangabe'}`}
        actions={
          <Link to="/archiv" className="btn">
            <ArrowLeft size={16} /> Archiv
          </Link>
        }
      />
      <Segmented<Tab>
        label="Ansicht"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'journal', label: 'Einsatztagebuch' },
          { value: 'units', label: 'Kräfte' },
          { value: 'documents', label: 'Dokumente' },
        ]}
      />
      <div className="spacer" />
      {tab === 'journal' && <JournalView incident={incident} readOnly />}
      {tab === 'units' && <UnitsView incident={incident} readOnly />}
      {tab === 'documents' && <DocumentsView incident={incident} readOnly />}
    </>
  );
}
