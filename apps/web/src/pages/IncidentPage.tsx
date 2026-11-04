import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpenText, FileText, MapPin, Pencil, Siren, Users } from 'lucide-react';
import { INCIDENT_KIND_LABELS, PROCUREMENT_MODE_LABELS, formatStrength, kindHasSite, sumStrength, type Incident } from '@elvis/shared';
import { api } from '../lib/api';
import { fmtDateTime, fmtDuration } from '../lib/format';
import { useActiveIncident, useNow } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Card, EmptyState, Loading, Modal, PageHeader, Stat } from '../components/ui';
import { StartIncidentButton } from '../components/StartIncidentButton';
import { ReportButton } from '../components/ReportButton';
import { IncidentForm } from './incident/IncidentForm';
import { deployedUnits } from './incident/UnitsView';

function NoIncident() {
  return (
    <>
      <PageHeader title="Lage" subtitle="Derzeit ist keine Lage aufgelegt" />
      <div className="grid">
        <Card className="span-2">
          <EmptyState icon={<Siren size={40} />} title="Keine Lage aufgelegt">
            <p>Eine Lage fasst alles zusammen, was zu einem Ereignis gehört – z. B. eine Unwetterlage mit vielen Einsätzen.</p>
            <StartIncidentButton />
          </EmptyState>
        </Card>
        <Card title="Was passiert beim Eröffnen?">
          <ul className="icon-list">
            <li>
              <BookOpenText size={18} /> Das Einsatztagebuch wird angelegt und die Eröffnung mit Uhrzeit protokolliert.
            </li>
            <li>
              <Users size={18} /> Die Kräfteübersicht wird freigeschaltet.
            </li>
            <li>
              <FileText size={18} /> Die Dokumentenverwaltung für die Lage wird freigeschaltet.
            </li>
          </ul>
          <p className="muted">Fahrzeugfunktionen, Karte und Wetter stehen unabhängig davon jederzeit zur Verfügung.</p>
        </Card>
      </div>
    </>
  );
}

function ActiveIncident({ incident }: { incident: Incident }) {
  const now = useNow();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const { data: units = [] } = useQuery({ queryKey: ['units', incident.id], queryFn: () => api.units(incident.id) });
  const { data: journal = [] } = useQuery({ queryKey: ['journal', incident.id], queryFn: () => api.journal(incident.id) });
  const { data: docs = [] } = useQuery({ queryKey: ['documents', incident.id], queryFn: () => api.documents(incident.id), select: (l) => l.documents.filter((d) => !d.draft) });

  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.updateIncident>[1]) => api.updateIncident(incident.id, input),
    onSuccess: () => {
      setEditing(false);
      toast('success', 'Einsatzdaten gespeichert');
    },
    onError: (e) => toast('error', e.message),
  });
  const close = useMutation({
    mutationFn: () => api.closeIncident(incident.id),
    onSuccess: () => toast('success', 'Lage beendet – der Einsatzbericht wird unter „Protokolle“ abgelegt'),
    onError: (e) => toast('error', e.message),
  });

  const active = units.filter((u) => u.status !== 'entlassen');
  const deployed = deployedUnits(units);
  const confirmClose = () => {
    const open = active.length ? `\n\n${active.length} Einheit(en) sind noch nicht entlassen.` : '';
    if (window.confirm(`Lage „${incident.title}“ wirklich beenden?${open}\n\nDanach sind keine Änderungen mehr möglich. Der Einsatzbericht (PDF) wird erstellt und unter „Protokolle“ abgelegt.`)) close.mutate();
  };

  return (
    <>
      <PageHeader
        title={[incident.keyword, incident.title].filter(Boolean).join(' · ')}
        subtitle={
          <>
            Eröffnet {fmtDateTime(incident.startedAt)} · Dauer <strong className="mono">{fmtDuration(incident.startedAt, now)}</strong>
          </>
        }
        actions={
          <>
            <button className="btn" onClick={() => setEditing(true)}>
              <Pencil size={16} /> Bearbeiten
            </button>
            <ReportButton incidentId={incident.id} label="Zwischenbericht (PDF)" />
            <button className="btn btn-danger" onClick={confirmClose} disabled={close.isPending}>
              Lage beenden
            </button>
          </>
        }
      />
      <div className="grid">
        <Card title="Einsatzdaten" icon={<Siren size={18} />}>
          <dl className="kv">
            <dt>Art</dt>
            <dd>{INCIDENT_KIND_LABELS[incident.kind]}</dd>
            {kindHasSite(incident.kind) && (
              <>
                <dt>Stichwort</dt>
                <dd>{incident.keyword || '–'}</dd>
                <dt>Einsatzort</dt>
                <dd>{incident.location || '–'}</dd>
              </>
            )}
            <dt>Position</dt>
            <dd>
              {incident.lat != null && incident.lon != null ? (
                `${incident.lat.toFixed(5)}, ${incident.lon.toFixed(5)}`
              ) : (
                <Link to="/karte">
                  <MapPin size={14} /> auf Karte setzen
                </Link>
              )}
            </dd>
            <dt>Einsatzleiter</dt>
            <dd>{incident.leader || '–'}</dd>
            <dt>Beschaffung</dt>
            <dd>
              {PROCUREMENT_MODE_LABELS[incident.procurementMode]}
              {incident.procurementMode === 'staff' && incident.procurementStaff && ` (${incident.procurementStaff})`}
            </dd>
          </dl>
        </Card>
        <Link to="/lage/kraefte" className="card card-link">
          <Stat label="Kräfte im Einsatz" value={deployed.length} sub={`Stärke ${formatStrength(sumStrength(deployed))}`} />
          <span className="card-link-cta">
            <Users size={16} /> Kräfteübersicht
          </span>
        </Link>
        <Link to="/lage/tagebuch" className="card card-link">
          <Stat label="Tagebucheinträge" value={journal.length} sub={journal.at(-1)?.text ?? '–'} />
          <span className="card-link-cta">
            <BookOpenText size={16} /> Einsatztagebuch
          </span>
        </Link>
        <Link to="/lage/dokumente" className="card card-link">
          <Stat label="Dokumente" value={docs.length} />
          <span className="card-link-cta">
            <FileText size={16} /> Dokumentenverwaltung
          </span>
        </Link>
      </div>
      <Modal open={editing} title="Einsatzdaten bearbeiten" onClose={() => setEditing(false)}>
        <IncidentForm initial={incident} submitLabel="Speichern" pending={update.isPending} onSubmit={(input) => update.mutate(input)} />
      </Modal>
    </>
  );
}

export function IncidentPage() {
  const { data: incident, isLoading } = useActiveIncident();
  if (isLoading) return <Loading />;
  return incident ? <ActiveIncident incident={incident} /> : <NoIncident />;
}
