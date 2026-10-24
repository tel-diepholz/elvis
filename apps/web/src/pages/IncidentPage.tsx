import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpenText, FileText, MapPin, Pencil, Siren, Users } from 'lucide-react';
import { formatStrength, type Incident } from '@elvis/shared';
import { api } from '../lib/api';
import { fmtDateTime, fmtDuration } from '../lib/format';
import { useActiveIncident, useNow } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Card, Loading, Modal, PageHeader, Stat } from '../components/ui';
import { IncidentForm } from './incident/IncidentForm';
import { sumStrength } from './incident/UnitsView';

function StartIncident() {
  const toast = useToast();
  const start = useMutation({
    mutationFn: api.startIncident,
    onSuccess: (i) => toast('success', `Einsatz „${i.title}“ eröffnet`),
    onError: (e) => toast('error', e.message),
  });
  return (
    <>
      <PageHeader title="Einsatz" subtitle="Derzeit ist kein Einsatz aufgelegt" />
      <div className="grid">
        <Card title="Neuen Einsatz anlegen" icon={<Siren size={18} />} className="span-2">
          <IncidentForm submitLabel="Einsatz eröffnen" pending={start.isPending} onSubmit={(input) => start.mutate(input)} />
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
              <FileText size={18} /> Die Dokumentenverwaltung für den Einsatz wird freigeschaltet.
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
    onSuccess: () => toast('success', 'Einsatz beendet und archiviert'),
    onError: (e) => toast('error', e.message),
  });

  const active = units.filter((u) => !u.releasedAt);
  const confirmClose = () => {
    const open = active.length ? `\n\n${active.length} Einheit(en) sind noch nicht entlassen.` : '';
    if (window.confirm(`Einsatz „${incident.title}“ wirklich beenden?${open}\n\nDanach sind keine Änderungen mehr möglich.`)) close.mutate();
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
            <button className="btn btn-danger" onClick={confirmClose} disabled={close.isPending}>
              Einsatz beenden
            </button>
          </>
        }
      />
      <div className="grid">
        <Card title="Einsatzdaten" icon={<Siren size={18} />}>
          <dl className="kv">
            <dt>Stichwort</dt>
            <dd>{incident.keyword || '–'}</dd>
            <dt>Einsatzort</dt>
            <dd>{incident.location || '–'}</dd>
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
          </dl>
        </Card>
        <Link to="/einsatz/kraefte" className="card card-link">
          <Stat label="Kräfte im Einsatz" value={active.length} sub={`Stärke ${formatStrength(sumStrength(active))}`} />
          <span className="card-link-cta">
            <Users size={16} /> Kräfteübersicht
          </span>
        </Link>
        <Link to="/einsatz/tagebuch" className="card card-link">
          <Stat label="Tagebucheinträge" value={journal.length} sub={journal.at(-1)?.text ?? '–'} />
          <span className="card-link-cta">
            <BookOpenText size={16} /> Einsatztagebuch
          </span>
        </Link>
        <Link to="/einsatz/dokumente" className="card card-link">
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
  return incident ? <ActiveIncident incident={incident} /> : <StartIncident />;
}
