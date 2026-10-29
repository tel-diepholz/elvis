import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRightLeft, ClipboardList, Inbox, Pencil, Users } from 'lucide-react';
import { formatStrength, personName, personnelStrength, sumStrength, unitDescendants, type NewUnit, type Person, type PersonData, type Unit, type UnitPatch } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Field, Loading, Modal, PageHeader } from '../../components/ui';
import { TacticalSignImage } from '../../components/tactical/TacticalSign';
import { StatusBadge, StatusSelect } from '../../components/forces/fields';
import { PersonForm, PersonnelSheetForm, PersonnelTable } from '../../components/forces/personnel';
import { AppLinkInfo } from './AppLinkParts';
import { UnitForm } from './UnitsView';

/** Personal an eine andere Einheit des Einsatzes übergeben; vorausgewählt sind alle */
function TransferForm({ persons, units, pending, onSubmit }: { persons: Person[]; units: Unit[]; pending: boolean; onSubmit: (personIds: number[], unitId: number) => void }) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(persons.map((p) => p.id)));
  const [target, setTarget] = useState<number | null>(null);
  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (target && selected.size) onSubmit([...selected], target);
  };
  return (
    <form className="form" onSubmit={submit}>
      <Field label="An Einheit">
        <select value={target ?? ''} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : null)} required autoFocus>
          <option value="">– Einheit wählen –</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.callsign ? ` (${u.callsign})` : ''}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="qual-picker">
        <legend>
          Personen ({selected.size} von {persons.length}){' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(selected.size === persons.length ? new Set() : new Set(persons.map((p) => p.id)))}>
            {selected.size === persons.length ? 'keine' : 'alle'}
          </button>
        </legend>
        <ul className="simple-list">
          {persons.map((p) => (
            <li key={p.id}>
              <label className="check">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} /> {personName(p)}
                {p.function && <span className="muted"> · {p.function}</span>}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !target || selected.size === 0}>
          {selected.size === 1 ? '1 Person übergeben' : `${selected.size} Personen übergeben`}
        </button>
      </div>
    </form>
  );
}

/** Detailseite einer Einheit im Einsatz: Stammdaten, Untereinheiten und Personal (Personalbögen) */
export function UnitDetailPage() {
  const id = Number(useParams().id);
  const toast = useToast();
  const onError = (e: Error) => toast('error', e.message);
  const { data: unit, isLoading, error } = useQuery({ queryKey: ['units', 'one', id], queryFn: () => api.unit(id), enabled: id > 0 });
  const incidentId = unit?.incidentId ?? 0;
  const { data: incident } = useQuery({ queryKey: ['incident', incidentId], queryFn: () => api.incident(incidentId), enabled: incidentId > 0 });
  const { data: units = [] } = useQuery({ queryKey: ['units', incidentId], queryFn: () => api.units(incidentId), enabled: incidentId > 0 });
  const { data: persons = [] } = useQuery({ queryKey: ['personnel', 'unit', id], queryFn: () => api.unitPersonnel(id), enabled: id > 0 });
  const { data: relay } = useQuery({ queryKey: ['appRelay'], queryFn: api.appRelayEnabled, staleTime: Infinity });
  const { data: appLinks = [] } = useQuery({ queryKey: ['appLinks', incidentId], queryFn: () => api.appLinks(incidentId), enabled: !!relay?.enabled && incidentId > 0 });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState<Person | null>(null);
  const [editingUnit, setEditingUnit] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const addPersons = useMutation({
    mutationFn: (list: PersonData[]) => api.addPersonnel(id, list),
    onSuccess: (_, list) => (setSheetOpen(false), toast('success', list.length === 1 ? 'Person erfasst' : `${list.length} Personen erfasst`)),
    onError,
  });
  const updatePerson = useMutation({
    mutationFn: ({ person, data }: { person: Person; data: PersonData }) => api.updatePerson(person.id, data),
    onSuccess: () => setEditingPerson(null),
    onError,
  });
  const transfer = useMutation({
    mutationFn: ({ personIds, target }: { personIds: number[]; target: number }) => api.transferPersonnel(id, personIds, target),
    onSuccess: (_, { personIds, target }) => (
      setTransferring(false), toast('success', `${personIds.length === 1 ? '1 Person' : `${personIds.length} Personen`} an ${units.find((u) => u.id === target)?.name ?? 'Einheit'} übergeben`)
    ),
    onError,
  });
  const removePerson = useMutation({ mutationFn: (p: Person) => api.removePerson(p.id), onError });
  const adoptContact = useMutation({
    mutationFn: (p: Person) => api.personToContact(p.id),
    onSuccess: (_, p) => toast('success', `${personName(p)} in die Kontakte übernommen`),
    onError,
  });
  const patch = useMutation({
    mutationFn: (p: UnitPatch) => api.patchUnit(id, p),
    onSuccess: () => setEditingUnit(false),
    onError,
  });

  const sections = useMemo(() => [...new Set(units.map((u) => u.section).filter(Boolean))].sort(), [units]);
  const roles = useMemo(() => units.map((u) => u.role), [units]);

  if (isLoading) return <Loading />;
  if (!unit || error) return <EmptyState title="Einheit nicht gefunden">{error?.message}</EmptyState>;

  const readOnly = !!incident?.closedAt;
  const back = readOnly ? `/archiv/${unit.incidentId}` : '/einsatz/kraefte';
  const parent = units.find((u) => u.id === unit.parentId);
  const subs = unitDescendants(units, unit.id);
  const children = units.filter((u) => u.parentId === unit.id);
  const counted = personnelStrength(persons);
  const link = appLinks.find((l) => l.unitId === unit.id);
  const strengthDiffers = persons.length > 0 && formatStrength(counted) !== formatStrength(unit.strength);
  const defaultOrganization = persons.at(-1)?.organization || unit.organization;

  return (
    <>
      <PageHeader
        title={unit.name}
        subtitle={[unit.callsign, unit.organization, incident && [incident.keyword, incident.title].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}
        actions={
          <Link className="btn" to={back}>
            <ArrowLeft size={16} /> {readOnly ? 'Einsatz' : 'Kräfteübersicht'}
          </Link>
        }
      />
      <div className="grid">
        <Card
          title="Einheit"
          className="span-2"
          actions={
            !readOnly && (
              <button className="btn btn-sm" onClick={() => setEditingUnit(true)}>
                <Pencil size={14} /> Bearbeiten
              </button>
            )
          }
        >
          <div className="unit-detail">
            <TacticalSignImage sign={unit.sign} height={72} />
            <dl className="kv">
              <dt>Status</dt>
              <dd>{readOnly ? <StatusBadge status={unit.status} /> : <StatusSelect value={unit.status} onChange={(status) => patch.mutate({ status })} ariaLabel={`Status ${unit.name}`} />}</dd>
              <dt>Stärke</dt>
              <dd className="mono">
                {formatStrength(unit.strength)}
                {subs.length > 0 && <span className="muted"> · mit Untereinheiten {formatStrength(sumStrength([unit, ...subs]))}</span>}
              </dd>
              {unit.section && (
                <>
                  <dt>Abschnitt</dt>
                  <dd>{unit.section}</dd>
                </>
              )}
              {parent && (
                <>
                  <dt>Unterstellt</dt>
                  <dd>
                    <Link to={`/einsatz/kraefte/${parent.id}`}>{parent.name}</Link> {unit.role && <Badge tone="info">{unit.role}</Badge>}
                  </dd>
                </>
              )}
              <dt>Eintreffen</dt>
              <dd>{unit.arrivedAt ? fmtDateTime(unit.arrivedAt) : '–'}</dd>
              {unit.releasedAt && (
                <>
                  <dt>Entlassen</dt>
                  <dd>{fmtDateTime(unit.releasedAt)}</dd>
                </>
              )}
              {unit.notes && (
                <>
                  <dt>Bemerkung</dt>
                  <dd>{unit.notes}</dd>
                </>
              )}
            </dl>
          </div>
          {link && <AppLinkInfo link={link} />}
        </Card>

        <Card title={`Untereinheiten (${children.length})`} icon={<Users size={18} />}>
          {children.length === 0 ? (
            <p className="muted">Keine</p>
          ) : (
            <ul className="simple-list">
              {children.map((c) => (
                <li key={c.id}>
                  <Link to={`/einsatz/kraefte/${c.id}`}>{c.name}</Link> {c.role && <Badge tone="info">{c.role}</Badge>} <span className="muted mono">{formatStrength(c.strength)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={`Personal (${persons.length})`}
          icon={<ClipboardList size={18} />}
          className="span-3"
          actions={
            !readOnly && (
              <span className="btn-row">
                {persons.length > 0 && (
                  <button className="btn btn-sm" onClick={() => setTransferring(true)}>
                    <ArrowRightLeft size={14} /> An andere Einheit übergeben
                  </button>
                )}
                <button className="btn btn-primary btn-sm" onClick={() => setSheetOpen(true)}>
                  Personalbogen ausfüllen
                </button>
              </span>
            )
          }
        >
          {persons.length > 0 && (
            <p className="muted">
              Erfasst <span className="mono">{formatStrength(counted)}</span>
              {strengthDiffers && (
                <>
                  {' '}
                  · Stärke der Einheit <span className="mono">{formatStrength(unit.strength)}</span>
                  {!readOnly && (
                    <>
                      {' '}
                      <button className="btn btn-sm" onClick={() => patch.mutate({ strength: counted, cascade: false })} disabled={patch.isPending}>
                        Stärke übernehmen
                      </button>
                    </>
                  )}
                </>
              )}
            </p>
          )}
          {persons.length === 0 ? (
            <EmptyState icon={<ClipboardList size={36} />} title="Noch kein Personal erfasst">
              {!readOnly && (
                <p>
                  Personalbogen hier ausfüllen – oder der Einheitsführer meldet sein Personal über die Cloud-Personalabfrage; eingereichte Bögen erscheinen im{' '}
                  <Link to="/scans">
                    <Inbox size={14} /> Posteingang
                  </Link>
                  .
                </p>
              )}
            </EmptyState>
          ) : (
            <PersonnelTable
              persons={persons}
              onEdit={readOnly ? undefined : setEditingPerson}
              onRemove={readOnly ? undefined : (p) => removePerson.mutate(p)}
              onAdoptContact={(p) => adoptContact.mutate(p)}
            />
          )}
        </Card>
      </div>

      <Modal open={sheetOpen} title={`Personalbogen ${unit.name}`} onClose={() => setSheetOpen(false)} wide>
        <PersonnelSheetForm defaultOrganization={defaultOrganization} pending={addPersons.isPending} onSubmit={(list) => addPersons.mutate(list)} />
      </Modal>
      <Modal open={!!editingPerson} title="Person bearbeiten" onClose={() => setEditingPerson(null)} wide>
        {editingPerson && <PersonForm initial={editingPerson} pending={updatePerson.isPending} onSubmit={(data) => updatePerson.mutate({ person: editingPerson, data })} />}
      </Modal>
      <Modal open={transferring} title={`Personal von ${unit.name} übergeben`} onClose={() => setTransferring(false)}>
        <TransferForm
          persons={persons}
          units={units.filter((u) => u.id !== unit.id && u.status !== 'entlassen')}
          pending={transfer.isPending}
          onSubmit={(personIds, target) => transfer.mutate({ personIds, target })}
        />
      </Modal>
      <Modal open={editingUnit} title={`${unit.name} bearbeiten`} onClose={() => setEditingUnit(false)} wide>
        {editingUnit && (
          <UnitForm
            initial={unit}
            units={units}
            sections={sections}
            roles={roles}
            pending={patch.isPending}
            onSubmit={(p: NewUnit & UnitPatch) => patch.mutate({ ...p, status: undefined })}
          />
        )}
      </Modal>
    </>
  );
}
