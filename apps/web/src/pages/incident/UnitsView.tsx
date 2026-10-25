import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookmarkPlus, LogOut, MapPin, Pencil, Plus, Smartphone } from 'lucide-react';
import {
  DEFAULT_UNIT_SIGN,
  UNIT_STATUS,
  UNIT_STATUSES,
  ZERO_STRENGTH,
  forceTotalStrength,
  formatStrength,
  isOnScene,
  sumStrength,
  unitChildren,
  unitDescendants,
  formatDeviceId,
  type DeployNode,
  type ForceUnit,
  type Incident,
  type NewUnit,
  type TacticalSign,
  type Unit,
  type UnitPatch,
  type UnitStatus,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Field, Loading, Modal, Segmented, Stat } from '../../components/ui';
import { TacticalSignEditor } from '../../components/tactical/TacticalSignEditor';
import { TacticalSignImage } from '../../components/tactical/TacticalSign';
import { RoleInput, StatusBadge, StatusSelect, StrengthFields } from '../../components/forces/fields';
import { AppLinkInfo, PairAppForm } from './AppLinkParts';

const NO_SECTION = 'Ohne Abschnitt';

/** Im Einsatz gebunden: alarmiert bis Abmarsch (ohne geplante und entlassene) */
export const deployedUnits = (units: Unit[]) => units.filter((u) => u.status !== 'geplant' && u.status !== 'entlassen');

/** Mögliche übergeordnete Einheiten: nicht entlassen, nicht die Einheit selbst oder eine ihrer Untereinheiten */
function parentOptions(units: Unit[], self?: Unit): Unit[] {
  const excluded = self ? new Set([self.id, ...unitDescendants(units, self.id).map((u) => u.id)]) : new Set<number>();
  return units.filter((u) => u.status !== 'entlassen' && !excluded.has(u.id));
}

function ParentSelect({ value, options, onChange }: { value: number | null; options: Unit[]; onChange: (id: number | null) => void }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">– eigenständig (oberste Ebene) –</option>
      {options.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}

function SectionInput({ value, onChange, sections }: { value: string; onChange: (v: string) => void; sections: string[] }) {
  return (
    <>
      <input value={value} onChange={(e) => onChange(e.target.value)} list="unit-sections" placeholder="z. B. EA Brandbekämpfung" maxLength={100} />
      <datalist id="unit-sections">
        {sections.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}

/** Einheit im Einsatz neu erfassen oder bearbeiten (Status wird in der Liste geändert) */
function UnitForm({
  initial,
  defaultParentId = null,
  units,
  sections,
  roles,
  pending,
  onSubmit,
}: {
  initial?: Unit;
  defaultParentId?: number | null;
  units: Unit[];
  sections: string[];
  roles: string[];
  pending: boolean;
  onSubmit: (u: NewUnit & UnitPatch) => void;
}) {
  const [f, setF] = useState({
    name: initial?.name ?? '',
    callsign: initial?.callsign ?? '',
    organization: initial?.organization ?? '',
    section: initial?.section ?? '',
    notes: initial?.notes ?? '',
    role: initial?.role ?? '',
  });
  const [parentId, setParentId] = useState<number | null>(initial ? initial.parentId : defaultParentId);
  const [strength, setStrength] = useState(initial?.strength ?? { leaders: 0, subLeaders: 1, crew: 8 });
  const [status, setStatus] = useState<UnitStatus>('alarmiert');
  const [sign, setSign] = useState<TacticalSign>(initial?.sign ?? DEFAULT_UNIT_SIGN);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    onSubmit({ ...f, role: parentId ? f.role : '', parentId, strength, sign, ...(initial ? {} : { status }) });
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Name *">
          <input value={f.name} onChange={set('name')} placeholder="HLF 20 Musterstadt, 2. Zug …" required autoFocus maxLength={100} />
        </Field>
        <Field label="Funkrufname">
          <input value={f.callsign} onChange={set('callsign')} placeholder="Florian Musterstadt 1/44-1" maxLength={100} />
        </Field>
        <Field label="Organisation">
          <input value={f.organization} onChange={set('organization')} placeholder="FF Musterstadt" maxLength={100} />
        </Field>
        <Field label="Einsatzabschnitt">
          <SectionInput value={f.section} onChange={(section) => setF((x) => ({ ...x, section }))} sections={sections} />
        </Field>
        <Field label="Unterstellt">
          <ParentSelect value={parentId} options={parentOptions(units, initial)} onChange={setParentId} />
        </Field>
        {parentId !== null && (
          <Field label="Rolle in der Einheit">
            <RoleInput value={f.role} onChange={(role) => setF((x) => ({ ...x, role }))} used={roles} />
          </Field>
        )}
      </div>
      <StrengthFields value={strength} onChange={setStrength} legend="Eigene Stärke (ohne Untereinheiten)" />
      {!initial && (
        <Field label="Status">
          <StatusSelect value={status} onChange={setStatus} />
        </Field>
      )}
      <Field label="Bemerkung">
        <input value={f.notes} onChange={set('notes')} maxLength={1000} />
      </Field>
      <fieldset className="force-sign">
        <legend>Taktisches Zeichen</legend>
        <TacticalSignEditor value={sign} onChange={setSign} />
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !f.name.trim()}>
          {initial ? 'Speichern' : 'Einheit hinzufügen'}
        </button>
      </div>
    </form>
  );
}

interface CatalogNode {
  key: string;
  unit: ForceUnit;
  role: string;
  children: CatalogNode[];
  /** Nicht wählbar: schon im Einsatz oder weiter oben bereits enthalten */
  blocked: string | null;
}

/** Systemeinheit als Baum; jede Einheit erscheint einmal (die erste Fundstelle gewinnt) */
function catalogTree(all: ForceUnit[], rootId: number, active: Set<number>): CatalogNode {
  const byId = new Map(all.map((u) => [u.id, u]));
  const seen = new Set<number>();
  const build = (id: number, role: string, key: string): CatalogNode => {
    const unit = byId.get(id)!;
    const dup = seen.has(id);
    seen.add(id);
    return {
      key,
      unit,
      role,
      blocked: dup ? 'bereits enthalten' : active.has(id) ? 'bereits im Einsatz' : null,
      children: dup ? [] : unit.members.filter((m) => byId.has(m.unitId)).map((m) => build(m.unitId, m.role, `${key}/${m.unitId}`)),
    };
  };
  return build(rootId, '', String(rootId));
}

/** Systemeinheit aus der Kräfteverwaltung übernehmen; einzelne Untereinheiten lassen sich abwählen */
function DeployForm({
  catalog,
  units,
  sections,
  roles,
  defaultParentId,
  pending,
  onSubmit,
}: {
  catalog: ForceUnit[];
  units: Unit[];
  sections: string[];
  roles: string[];
  defaultParentId: number | null;
  pending: boolean;
  onSubmit: (input: { tree: DeployNode; parentId: number | null; role: string; section: string; status: UnitStatus }) => void;
}) {
  const [query, setQuery] = useState('');
  const [rootId, setRootId] = useState<number | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<UnitStatus>('alarmiert');
  const [section, setSection] = useState('');
  const [parentId, setParentId] = useState<number | null>(defaultParentId);
  const [role, setRole] = useState('');

  const active = useMemo(() => new Set(units.filter((u) => u.status !== 'entlassen' && u.sourceId !== null).map((u) => u.sourceId!)), [units]);
  const tree = useMemo(() => (rootId !== null ? catalogTree(catalog, rootId, active) : null), [catalog, rootId, active]);
  const q = query.trim().toLowerCase();
  const matches = catalog.filter((u) => !q || [u.name, u.callsign, u.organization].some((v) => v.toLowerCase().includes(q)));

  const selected = (n: CatalogNode) => !n.blocked && !off.has(n.key);
  const toDeploy = (n: CatalogNode): DeployNode => ({ forceUnitId: n.unit.id, children: n.children.filter(selected).map(toDeploy) });
  const picked = (n: CatalogNode): ForceUnit[] => (selected(n) ? [n.unit, ...n.children.flatMap(picked)] : []);
  const chosen = tree ? picked(tree) : [];

  const toggle = (key: string) =>
    setOff((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderNode = (n: CatalogNode, depth: number, parentOn: boolean): JSX.Element => {
    const on = parentOn && selected(n);
    return (
      <Fragment key={n.key}>
        <li className={`deploy-node ${on ? '' : 'off'}`} style={{ paddingLeft: depth * 22 }}>
          <label>
            <input type="checkbox" checked={on} disabled={!!n.blocked || !parentOn || depth === 0} onChange={() => toggle(n.key)} />
            <TacticalSignImage sign={n.unit.sign} height={26} />
            <span className="grow">
              <span className="cell-title">{n.unit.name}</span>
              {n.role && <Badge tone="info">{n.role}</Badge>}
              <span className="cell-sub mono"> {formatStrength(n.unit.strength)}</span>
            </span>
            {n.blocked && <span className="muted">{n.blocked}</span>}
          </label>
        </li>
        {n.children.map((c) => renderNode(c, depth + 1, on))}
      </Fragment>
    );
  };

  if (catalog.length === 0) return <EmptyState title="Keine Systemeinheiten">Admins legen sie unter Einstellungen → Kräfteverwaltung an.</EmptyState>;

  if (!tree)
    return (
      <div className="form">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Systemeinheit suchen …" autoFocus aria-label="Systemeinheit suchen" />
        <ul className="simple-list deploy-pick">
          {matches.map((u) => (
            <li key={u.id}>
              <button type="button" className="deploy-pick-item" onClick={() => (setRootId(u.id), setOff(new Set()))} disabled={active.has(u.id)}>
                <TacticalSignImage sign={u.sign} height={34} />
                <span className="grow">
                  <span className="cell-title">{u.name}</span>
                  <span className="cell-sub">
                    {[u.organization, u.members.length ? `${u.members.length} Untereinheiten` : '', `Stärke ${formatStrength(forceTotalStrength(catalog, u.id))}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {active.has(u.id) && <span className="muted">bereits im Einsatz</span>}
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="muted">Keine Treffer</li>}
        </ul>
      </div>
    );

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (selected(tree)) onSubmit({ tree: toDeploy(tree), parentId, role: parentId ? role : '', section, status });
      }}
    >
      <div>
        <button type="button" className="btn btn-sm" onClick={() => setRootId(null)}>
          ← andere Einheit
        </button>
      </div>
      <ul className="deploy-tree">{renderNode(tree, 0, true)}</ul>
      <p className="muted">
        {chosen.length} Einheit{chosen.length === 1 ? '' : 'en'} · Stärke <span className="mono">{formatStrength(sumStrength(chosen))}</span>
      </p>
      <div className="form-grid">
        <Field label="Status">
          <StatusSelect value={status} onChange={setStatus} />
        </Field>
        <Field label="Einsatzabschnitt">
          <SectionInput value={section} onChange={setSection} sections={sections} />
        </Field>
        <Field label="Unterstellt">
          <ParentSelect value={parentId} options={parentOptions(units)} onChange={setParentId} />
        </Field>
        {parentId !== null && (
          <Field label="Rolle in der Einheit">
            <RoleInput value={role} onChange={setRole} used={roles} />
          </Field>
        )}
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !selected(tree)}>
          Übernehmen
        </button>
      </div>
    </form>
  );
}

export function UnitsView({ incident, readOnly }: { incident: Incident; readOnly?: boolean }) {
  const toast = useToast();
  const admin = !!useAuth().user?.isAdmin;
  const { data: units, isLoading } = useQuery({ queryKey: ['units', incident.id], queryFn: () => api.units(incident.id) });
  const { data: catalog = [] } = useQuery({ queryKey: ['forces'], queryFn: api.forces, enabled: !readOnly });
  /** Hinzufügen: undefined = zu, null = oberste Ebene, Zahl = als Untereinheit */
  const [adding, setAdding] = useState<number | null | undefined>(undefined);
  const [mode, setMode] = useState<'catalog' | 'new'>('catalog');
  const [editing, setEditing] = useState<Unit | null>(null);
  const [showReleased, setShowReleased] = useState(false);
  const [pairing, setPairing] = useState<Unit | null>(null);
  const onError = (e: Error) => toast('error', e.message);
  const { data: relay } = useQuery({ queryKey: ['appRelay'], queryFn: api.appRelayEnabled, staleTime: Infinity });
  const appEnabled = !!relay?.enabled;
  const { data: appLinks = [] } = useQuery({ queryKey: ['appLinks', incident.id], queryFn: () => api.appLinks(incident.id), enabled: appEnabled });
  const linkOf = (u: Unit) => appLinks.find((l) => l.unitId === u.id);

  const add = useMutation({
    mutationFn: (u: NewUnit) => api.addUnit(incident.id, u),
    onSuccess: (u) => (setAdding(undefined), toast('success', `${u.name} hinzugefügt`)),
    onError,
  });
  const deploy = useMutation({
    mutationFn: (input: Parameters<typeof api.deployUnit>[1]) => api.deployUnit(incident.id, input),
    onSuccess: (u) => (setAdding(undefined), toast('success', `${u.name} übernommen`)),
    onError,
  });
  const patch = useMutation({
    mutationFn: ({ id, p }: { id: number; p: UnitPatch }) => api.patchUnit(id, p),
    onSuccess: () => setEditing(null),
    onError,
  });
  const pairApp = useMutation({
    mutationFn: ({ unit, input }: { unit: Unit; input: Parameters<typeof api.pairApp>[1] }) => api.pairApp(unit.id, input),
    onSuccess: (_, { unit }) => (setPairing(null), toast('success', `App mit ${unit.name} gekoppelt`)),
    onError,
  });
  const unpairApp = useMutation({
    mutationFn: (u: Unit) => api.unpairApp(u.id),
    onSuccess: (_, u) => toast('success', `App von ${u.name} entkoppelt`),
    onError,
  });
  const adopt = useMutation({
    mutationFn: api.adoptUnit,
    onSuccess: (f) => toast('success', `${f.name} ist jetzt Systemeinheit`),
    onError,
  });

  const all = units ?? [];
  const active = all.filter((u) => u.status !== 'entlassen');
  const released = all.filter((u) => u.status === 'entlassen');
  const sections = useMemo(() => [...new Set(all.map((u) => u.section).filter(Boolean))].sort(), [all]);
  const roles = useMemo(() => [...all.map((u) => u.role), ...catalog.flatMap((f) => f.members.map((m) => m.role))], [all, catalog]);
  const children = useMemo(() => unitChildren(active), [active]);
  const groups = useMemo(() => {
    const m = new Map<string, Unit[]>();
    for (const u of children.get(null) ?? []) m.set(u.section || NO_SECTION, [...(m.get(u.section || NO_SECTION) ?? []), u]);
    return [...m.entries()].sort(([a], [b]) => (a === NO_SECTION ? 1 : b === NO_SECTION ? -1 : a.localeCompare(b)));
  }, [children]);

  if (isLoading) return <Loading />;

  const deployed = deployedUnits(all);
  const subtree = (u: Unit) => [u, ...unitDescendants(active, u.id)];
  const openAdd = (parent: number | null) => (setMode(catalog.length ? 'catalog' : 'new'), setAdding(parent));

  const row = (u: Unit, depth: number, groupSection: string): JSX.Element => {
    const kids = children.get(u.id) ?? [];
    return (
      <Fragment key={u.id}>
        <tr className={u.status === 'entlassen' ? 'row-muted' : ''}>
          <td>
            <div className="unit-cell" style={{ paddingLeft: depth * 24 }}>
              <TacticalSignImage sign={u.sign} height={depth ? 28 : 34} />
              <div>
                <div className="cell-title">
                  {u.name} {u.role && <Badge tone="info">{u.role}</Badge>} {u.section && u.section !== groupSection && <Badge>{u.section}</Badge>}
                </div>
                <div className="cell-sub">{[u.callsign, u.organization].filter(Boolean).join(' · ') || '–'}</div>
                {u.notes && <div className="cell-sub">{u.notes}</div>}
                {linkOf(u) && <AppLinkInfo link={linkOf(u)!} />}
              </div>
            </div>
          </td>
          <td className="mono">
            {kids.length ? (
              <>
                <strong>{formatStrength(sumStrength(subtree(u)))}</strong>
                <div className="cell-sub">eigene {formatStrength(u.strength)}</div>
              </>
            ) : (
              formatStrength(u.strength)
            )}
          </td>
          <td>
            {readOnly ? (
              <StatusBadge status={u.status} />
            ) : (
              <StatusSelect
                value={u.status}
                ariaLabel={`Status ${u.name}`}
                onChange={(status) => patch.mutate({ id: u.id, p: { status } })}
                className={kids.length ? 'has-children' : ''}
              />
            )}
          </td>
          <td>
            {u.arrivedAt ? fmtTime(u.arrivedAt) : '–'}
            {u.releasedAt && <div className="cell-sub">entl. {fmtTime(u.releasedAt)}</div>}
          </td>
          {!readOnly && (
            <td className="cell-actions">
              <span
                className={`unit-map ${u.lat !== null ? 'placed' : ''}`}
                title={u.lat === null ? 'Noch ohne Position – in der Karte unter „Objekte“ setzen' : u.positionSource === 'app' ? 'Position per App' : 'Auf der Karte gesetzt'}
              >
                <MapPin size={16} />
              </span>
              {appEnabled && u.status !== 'entlassen' && (
                linkOf(u) ? (
                  <button
                    className="btn btn-ghost btn-icon app-linked"
                    onClick={() => window.confirm(`App ${formatDeviceId(linkOf(u)!.deviceId)} von ${u.name} entkoppeln? Die App hört dann auf zu orten.`) && unpairApp.mutate(u)}
                    aria-label={`App von ${u.name} entkoppeln`}
                    title="App gekoppelt – entkoppeln"
                  >
                    <Smartphone size={16} />
                  </button>
                ) : (
                  <button className="btn btn-ghost btn-icon" onClick={() => setPairing(u)} aria-label={`App mit ${u.name} koppeln`} title="App koppeln">
                    <Smartphone size={16} />
                  </button>
                )
              )}
              {u.status !== 'entlassen' && (
                <button className="btn btn-ghost btn-icon" onClick={() => openAdd(u.id)} aria-label={`Untereinheit zu ${u.name} hinzufügen`} title="Untereinheit hinzufügen">
                  <Plus size={16} />
                </button>
              )}
              <button className="btn btn-ghost btn-icon" onClick={() => setEditing(u)} aria-label={`${u.name} bearbeiten`} title="Bearbeiten">
                <Pencil size={16} />
              </button>
              {admin && u.sourceId === null && (
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => window.confirm(`${u.name} samt Untereinheiten als Systemeinheit in die Kräfteverwaltung übernehmen?`) && adopt.mutate(u.id)}
                  aria-label={`${u.name} als Systemeinheit übernehmen`}
                  title="Als Systemeinheit übernehmen"
                >
                  <BookmarkPlus size={16} />
                </button>
              )}
              {u.status !== 'entlassen' && (
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => window.confirm(`${u.name}${kids.length ? ' samt Untereinheiten' : ''} aus dem Einsatz entlassen?`) && patch.mutate({ id: u.id, p: { status: 'entlassen' } })}
                  aria-label={`${u.name} entlassen`}
                  title="Entlassen"
                >
                  <LogOut size={16} />
                </button>
              )}
            </td>
          )}
        </tr>
        {kids.map((k) => row(k, depth + 1, groupSection))}
      </Fragment>
    );
  };

  const table = (rows: JSX.Element[]) => (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Einheit</th>
            <th>Stärke</th>
            <th>Status</th>
            <th>Eintreffen</th>
            {!readOnly && <th />}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );

  const onScene = active.filter((u) => isOnScene(u.status));
  const approaching = active.filter((u) => u.status === 'alarmiert' || u.status === 'anmarsch');

  return (
    <div className="grid">
      <Card className="span-3">
        <div className="summary-row">
          <Stat label="Einheiten im Einsatz" value={deployed.length} sub={`davon ${(children.get(null) ?? []).filter((u) => u.status !== 'geplant').length} oberste Ebene`} />
          <Stat label="Stärke vor Ort" value={formatStrength(sumStrength(onScene))} />
          <Stat label="Alarmiert / Anmarsch" value={formatStrength(approaching.length ? sumStrength(approaching) : ZERO_STRENGTH)} />
          <Stat label="Einsatzabschnitte" value={sections.length} />
          {!readOnly && (
            <button className="btn btn-primary" onClick={() => openAdd(null)}>
              <Plus size={18} /> Einheit
            </button>
          )}
        </div>
        <div className="chip-row unit-status-legend">
          {UNIT_STATUSES.filter((s) => s !== 'entlassen').map((s) => {
            const n = active.filter((u) => u.status === s).length;
            return n ? (
              <span key={s} className={`unit-status unit-status-${s}`}>
                {UNIT_STATUS[s]}: {n}
              </span>
            ) : null;
          })}
        </div>
      </Card>

      {groups.length === 0 && (
        <Card className="span-3">
          <EmptyState title="Noch keine Einheiten erfasst">{!readOnly && <p>Einheiten über „+ Einheit“ aus der Kräfteverwaltung übernehmen oder neu erfassen.</p>}</EmptyState>
        </Card>
      )}

      {groups.map(([section, roots]) => (
        <Card key={section} title={section} className="span-3" actions={<span className="muted mono">{formatStrength(sumStrength(roots.flatMap(subtree)))}</span>}>
          {table(roots.map((u) => row(u, 0, section === NO_SECTION ? '' : section)))}
        </Card>
      ))}

      {released.length > 0 && (
        <Card
          title={`Entlassen (${released.length})`}
          className="span-3"
          actions={
            <button className="btn btn-sm" onClick={() => setShowReleased((s) => !s)}>
              {showReleased ? 'Ausblenden' : 'Anzeigen'}
            </button>
          }
        >
          {showReleased && table(released.map((u) => row(u, 0, u.section)))}
        </Card>
      )}

      <Modal
        open={adding !== undefined}
        title={typeof adding === 'number' ? `Untereinheit zu ${all.find((u) => u.id === adding)?.name ?? ''}` : 'Einheit hinzufügen'}
        onClose={() => setAdding(undefined)}
        wide
      >
        <div className="form">
          <Segmented
            label="Art"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'catalog', label: 'Aus Kräfteverwaltung' },
              { value: 'new', label: 'Neue Einheit' },
            ]}
          />
          {mode === 'catalog' ? (
            <DeployForm
              catalog={catalog}
              units={all}
              sections={sections}
              roles={roles}
              defaultParentId={adding ?? null}
              pending={deploy.isPending}
              onSubmit={(input) => deploy.mutate(input)}
            />
          ) : (
            <UnitForm units={all} sections={sections} roles={roles} defaultParentId={adding ?? null} pending={add.isPending} onSubmit={(u) => add.mutate(u)} />
          )}
        </div>
      </Modal>
      <Modal open={!!pairing} title={`App mit ${pairing?.name ?? ''} koppeln`} onClose={() => setPairing(null)}>
        {pairing && <PairAppForm unitName={pairing.name} pending={pairApp.isPending} onSubmit={(input) => pairApp.mutate({ unit: pairing, input })} />}
      </Modal>
      <Modal open={!!editing} title={`${editing?.name ?? ''} bearbeiten`} onClose={() => setEditing(null)} wide>
        {editing && (
          <UnitForm
            initial={editing}
            units={all}
            sections={sections}
            roles={roles}
            pending={patch.isPending}
            onSubmit={(p) => patch.mutate({ id: editing.id, p: { ...p, status: undefined } })}
          />
        )}
      </Modal>
    </div>
  );
}
