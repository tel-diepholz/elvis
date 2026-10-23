import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { LogOut, Pencil, Plus, Undo2 } from 'lucide-react';
import { FMS_STATUS, formatStrength, type Incident, type NewUnit, type Strength, type Unit, type UnitPatch } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Card, EmptyState, Field, Loading, Modal, Stat } from '../../components/ui';

export const sumStrength = (units: Unit[]): Strength =>
  units.reduce(
    (a, u) => ({ leaders: a.leaders + u.strength.leaders, subLeaders: a.subLeaders + u.strength.subLeaders, crew: a.crew + u.strength.crew }),
    { leaders: 0, subLeaders: 0, crew: 0 },
  );

const STATUS_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
const NO_SECTION = 'Ohne Abschnitt';

function UnitForm({ initial, sections, pending, onSubmit }: { initial?: Unit; sections: string[]; pending: boolean; onSubmit: (u: NewUnit) => void }) {
  const [f, setF] = useState({
    callsign: initial?.callsign ?? '',
    unitType: initial?.unitType ?? '',
    organization: initial?.organization ?? '',
    section: initial?.section ?? '',
    notes: initial?.notes ?? '',
    leaders: initial?.strength.leaders ?? 0,
    subLeaders: initial?.strength.subLeaders ?? 1,
    crew: initial?.strength.crew ?? 8,
    fmsStatus: initial?.fmsStatus ?? 4,
  });
  const set = (k: keyof typeof f, num = false) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: num ? Math.max(0, Number(e.target.value) || 0) : e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.callsign.trim()) return;
    onSubmit({
      callsign: f.callsign,
      unitType: f.unitType,
      organization: f.organization,
      section: f.section,
      notes: f.notes,
      strength: { leaders: f.leaders, subLeaders: f.subLeaders, crew: f.crew },
      ...(initial ? {} : { fmsStatus: f.fmsStatus }),
    });
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Funkrufname *">
          <input value={f.callsign} onChange={set('callsign')} placeholder="Florian Musterstadt 1/44-1" required autoFocus maxLength={100} />
        </Field>
        <Field label="Fahrzeug / Einheit">
          <input value={f.unitType} onChange={set('unitType')} placeholder="HLF 20, DLK 23/12, RTW …" maxLength={40} />
        </Field>
        <Field label="Organisation">
          <input value={f.organization} onChange={set('organization')} placeholder="FF Musterstadt" maxLength={100} />
        </Field>
        <Field label="Einsatzabschnitt">
          <input value={f.section} onChange={set('section')} list="unit-sections" placeholder="z. B. EA Brandbekämpfung" maxLength={100} />
          <datalist id="unit-sections">
            {sections.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
      </div>
      <fieldset className="strength">
        <legend>Stärke (Führer / Unterführer / Mannschaft)</legend>
        <input type="number" min={0} value={f.leaders} onChange={set('leaders', true)} aria-label="Führer" />
        <span>/</span>
        <input type="number" min={0} value={f.subLeaders} onChange={set('subLeaders', true)} aria-label="Unterführer" />
        <span>/</span>
        <input type="number" min={0} value={f.crew} onChange={set('crew', true)} aria-label="Mannschaft" />
        <span>= {f.leaders + f.subLeaders + f.crew}</span>
      </fieldset>
      {!initial && (
        <Field label="Status">
          <select value={f.fmsStatus} onChange={set('fmsStatus', true)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s} – {FMS_STATUS[s]!.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Bemerkung">
        <input value={f.notes} onChange={set('notes')} maxLength={1000} />
      </Field>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !f.callsign.trim()}>
          {initial ? 'Speichern' : 'Einheit hinzufügen'}
        </button>
      </div>
    </form>
  );
}

export function UnitsView({ incident, readOnly }: { incident: Incident; readOnly?: boolean }) {
  const toast = useToast();
  const { data: units, isLoading } = useQuery({ queryKey: ['units', incident.id], queryFn: () => api.units(incident.id) });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Unit | null>(null);
  const [showReleased, setShowReleased] = useState(false);

  const add = useMutation({
    mutationFn: (u: NewUnit) => api.addUnit(incident.id, u),
    onSuccess: (u) => {
      setAdding(false);
      toast('success', `${u.callsign} hinzugefügt`);
    },
    onError: (e) => toast('error', e.message),
  });
  const patch = useMutation({
    mutationFn: ({ id, p }: { id: number; p: UnitPatch }) => api.patchUnit(id, p),
    onSuccess: () => setEditing(null),
    onError: (e) => toast('error', e.message),
  });

  const all = units ?? [];
  const active = all.filter((u) => !u.releasedAt);
  const released = all.filter((u) => u.releasedAt);
  const sections = useMemo(() => [...new Set(all.map((u) => u.section).filter(Boolean))].sort(), [all]);
  const groups = useMemo(() => {
    const m = new Map<string, Unit[]>();
    for (const u of active) m.set(u.section || NO_SECTION, [...(m.get(u.section || NO_SECTION) ?? []), u]);
    return [...m.entries()].sort(([a], [b]) => (a === NO_SECTION ? 1 : b === NO_SECTION ? -1 : a.localeCompare(b)));
  }, [active]);

  if (isLoading) return <Loading />;

  const row = (u: Unit) => (
    <tr key={u.id} className={u.releasedAt ? 'row-muted' : ''}>
      <td>
        <div className="cell-title">{u.callsign}</div>
        <div className="cell-sub">{[u.unitType, u.organization].filter(Boolean).join(' · ') || '–'}</div>
        {u.notes && <div className="cell-sub">{u.notes}</div>}
      </td>
      <td className="mono">{formatStrength(u.strength)}</td>
      <td>
        {readOnly || u.releasedAt ? (
          <span className={`fms fms-${u.fmsStatus}`}>{u.fmsStatus ?? '–'}</span>
        ) : (
          <select
            className={`fms-select fms-${u.fmsStatus}`}
            value={u.fmsStatus ?? ''}
            onChange={(e) => patch.mutate({ id: u.id, p: { fmsStatus: Number(e.target.value) } })}
            aria-label={`Status ${u.callsign}`}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s} – {FMS_STATUS[s]!.short}
              </option>
            ))}
          </select>
        )}
      </td>
      <td>
        {fmtTime(u.arrivedAt)}
        {u.releasedAt && <div className="cell-sub">entl. {fmtTime(u.releasedAt)}</div>}
      </td>
      {!readOnly && (
        <td className="cell-actions">
          {u.releasedAt ? (
            <button className="btn btn-ghost btn-sm" onClick={() => patch.mutate({ id: u.id, p: { released: false } })}>
              <Undo2 size={14} /> Zurück
            </button>
          ) : (
            <>
              <button className="btn btn-ghost btn-icon" onClick={() => setEditing(u)} aria-label={`${u.callsign} bearbeiten`}>
                <Pencil size={16} />
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => window.confirm(`${u.callsign} aus dem Einsatz entlassen?`) && patch.mutate({ id: u.id, p: { released: true } })}
                aria-label={`${u.callsign} entlassen`}
              >
                <LogOut size={16} />
              </button>
            </>
          )}
        </td>
      )}
    </tr>
  );

  const table = (rows: Unit[]) => (
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
        <tbody>{rows.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="grid">
      <Card className="span-3">
        <div className="summary-row">
          <Stat label="Einheiten im Einsatz" value={active.length} />
          <Stat label="Gesamtstärke" value={formatStrength(sumStrength(active))} />
          <Stat label="Einsatzabschnitte" value={sections.length} />
          <Stat label="Am Einsatzort (S4)" value={active.filter((u) => u.fmsStatus === 4).length} />
          {!readOnly && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <Plus size={18} /> Einheit
            </button>
          )}
        </div>
      </Card>

      {groups.length === 0 && (
        <Card className="span-3">
          <EmptyState title="Noch keine Einheiten erfasst">{!readOnly && <p>Eintreffende Einheiten über „+ Einheit“ erfassen.</p>}</EmptyState>
        </Card>
      )}

      {groups.map(([section, list]) => (
        <Card key={section} title={section} className="span-3" actions={<span className="muted mono">{formatStrength(sumStrength(list))}</span>}>
          {table(list)}
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
          {showReleased && table(released)}
        </Card>
      )}

      <Modal open={adding} title="Einheit hinzufügen" onClose={() => setAdding(false)}>
        <UnitForm sections={sections} pending={add.isPending} onSubmit={(u) => add.mutate(u)} />
      </Modal>
      <Modal open={!!editing} title={`${editing?.callsign ?? ''} bearbeiten`} onClose={() => setEditing(null)}>
        {editing && <UnitForm initial={editing} sections={sections} pending={patch.isPending} onSubmit={(p) => patch.mutate({ id: editing.id, p })} />}
      </Modal>
    </div>
  );
}
