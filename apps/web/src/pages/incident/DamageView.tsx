import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Archive, Check, CircleHelp, HeartPulse, MapPin, Pencil, Plus, RotateCcw } from 'lucide-react';
import {
  DAMAGE_COUNT_CATEGORIES,
  DAMAGE_COUNT_LABELS,
  DAMAGE_ENTRY_SIDE_LABELS,
  damageAccountLabel,
  damageTotals,
  formatDamageCount,
  formatStrength,
  sumStrength,
  type DamageAccount,
  type DamageAccountInput,
  type DamageCountCategory,
  type DamageCountInput,
  type DamageEntry,
  type DamageEntryInput,
  type DamageEntrySide,
  type Incident,
  type Unit,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Field, Loading, Modal, Stat, Toggle } from '../../components/ui';
import { TacticalSignImage } from '../../components/tactical/TacticalSign';
import { StatusBadge } from '../../components/forces/fields';
import { Dv102Image, Dv102Picker } from '../../components/map/dv102';
import { DamageNumber, useDamageAccounts } from '../../components/damage/damageParts';

/** Kopfdaten eines Kontos: Bezeichnung, Abschnittsleiter (Kraft oder Freitext), Fm-Verbindung */
function AccountForm({ initial, units, pending, onSubmit }: { initial?: DamageAccount; units: Unit[]; pending: boolean; onSubmit: (input: DamageAccountInput) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [leaderUnitId, setLeaderUnitId] = useState<number | null>(initial?.leaderUnitId ?? null);
  const [leader, setLeader] = useState(initial?.leaderUnitId ? '' : (initial?.leader ?? ''));
  const [radio, setRadio] = useState(initial?.radio ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit({ name, leaderUnitId, leader: leaderUnitId ? '' : leader, radio });
  };
  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Bezeichnung *" hint="Eindeutig und funktauglich, z. B. „EA Bahnhof“">
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={100} />
        </Field>
        <Field label="Fm-Verbindung">
          <input value={radio} onChange={(e) => setRadio(e.target.value)} placeholder="z. B. Kanal 301, Florian Bahnhof" maxLength={100} />
        </Field>
        <Field label="Abschnittsleiter">
          <select value={leaderUnitId ?? ''} onChange={(e) => setLeaderUnitId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">– Freitext –</option>
            {units
              .filter((u) => u.status !== 'entlassen')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </Field>
        {leaderUnitId === null && (
          <Field label="Name des Abschnittsleiters">
            <input value={leader} onChange={(e) => setLeader(e.target.value)} placeholder="z. B. BI Müller" maxLength={100} />
          </Field>
        )}
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
          {initial ? 'Speichern' : 'Einrichten'}
        </button>
      </div>
    </form>
  );
}

/** Schaden, Gefahr oder Maßnahme erfassen: Text und/oder Zeichen nach DV 102, Anzahl, „?“ für Unbestätigtes */
function EntryForm({ sides, pending, onSubmit }: { sides: DamageEntrySide[]; pending: boolean; onSubmit: (input: DamageEntryInput) => void }) {
  const [side, setSide] = useState<DamageEntrySide>(sides[0]!);
  const [text, setText] = useState('');
  const [count, setCount] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [sign, setSign] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ side, text, sign, count: count === '' ? null : Number(count), uncertain });
  };
  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        {sides.length > 1 && (
          <Field label="Art">
            <select value={side} onChange={(e) => setSide(e.target.value as DamageEntrySide)}>
              {sides.map((s) => (
                <option key={s} value={s}>
                  {DAMAGE_ENTRY_SIDE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Beschreibung">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={side === 'massnahme' ? 'z. B. Riegelstellung, Ausleuchten' : 'z. B. Gasaustritt, Person eingeklemmt'} maxLength={500} autoFocus />
        </Field>
        <Field label="Anzahl">
          <input type="number" min={0} value={count} onChange={(e) => setCount(e.target.value)} placeholder="optional" />
        </Field>
        <Field label="Zeichen">
          <div className="inline-form">
            {sign && <Dv102Image id={sign} size={36} />}
            <button type="button" className="btn btn-sm" onClick={() => setPicking((p) => !p)}>
              {sign ? 'Anderes Zeichen' : 'Zeichen wählen'}
            </button>
            {sign && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSign(null)}>
                Entfernen
              </button>
            )}
          </div>
        </Field>
      </div>
      {picking && <Dv102Picker value={sign} onPick={(id) => (setSign(id), setPicking(false))} />}
      <Toggle checked={uncertain} onChange={setUncertain} label="Unbestätigt bzw. vermutet („?“)" />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || (!text.trim() && !sign)}>
          Eintragen
        </button>
      </div>
    </form>
  );
}

/** Personenschäden: aktueller Stand je Kategorie und neue Buchung mit Verlauf */
function CountsDialog({ account, readOnly }: { account: DamageAccount; readOnly: boolean }) {
  const toast = useToast();
  const [category, setCategory] = useState<DamageCountCategory>('sk1');
  const current = account.counts.find((c) => c.category === category);
  const [value, setValue] = useState(String(current?.value ?? 0));
  const [forces, setForces] = useState(String(current?.forces ?? 0));
  const [estimated, setEstimated] = useState(current?.estimated ?? false);
  const [note, setNote] = useState('');
  const { data: history = [] } = useQuery({ queryKey: ['damage', 'counts', account.id, account.updatedAt], queryFn: () => api.damageCounts(account.id) });
  const book = useMutation({
    mutationFn: (input: DamageCountInput) => api.bookDamageCount(account.id, input),
    onSuccess: () => (setNote(''), toast('success', `${DAMAGE_COUNT_LABELS[category]} gebucht`)),
    onError: (e: Error) => toast('error', e.message),
  });
  const pick = (c: DamageCountCategory) => {
    const cur = account.counts.find((x) => x.category === c);
    setCategory(c);
    setValue(String(cur?.value ?? 0));
    setForces(String(cur?.forces ?? 0));
    setEstimated(cur?.estimated ?? false);
  };
  return (
    <div className="form">
      <div className="damage-count-grid">
        {DAMAGE_COUNT_CATEGORIES.map((c) => {
          const cur = account.counts.find((x) => x.category === c);
          return (
            <button key={c} type="button" className={`damage-count damage-count-${c} ${c === category ? 'active' : ''}`} onClick={() => pick(c)} disabled={readOnly && !cur}>
              <span className="damage-count-value">{cur ? formatDamageCount(cur) : '–'}</span>
              <span className="damage-count-label">{DAMAGE_COUNT_LABELS[c]}</span>
              {cur?.forces ? <span className="cell-sub">davon {cur.forces} EK</span> : null}
            </button>
          );
        })}
      </div>
      {!readOnly && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            book.mutate({ category, value: Number(value), forces: Number(forces), estimated, note });
          }}
        >
          <div className="form-grid">
            <Field label={`${DAMAGE_COUNT_LABELS[category]} – neuer Stand`}>
              <input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} required />
            </Field>
            <Field label="davon Einsatzkräfte">
              <input type="number" min={0} max={Number(value) || 0} value={forces} onChange={(e) => setForces(e.target.value)} />
            </Field>
            <Field label="Bemerkung">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Quelle der Meldung" maxLength={300} />
            </Field>
          </div>
          <Toggle checked={estimated} onChange={setEstimated} label="Schätzwert" />
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={book.isPending}>
              Buchen
            </button>
          </div>
        </form>
      )}
      {history.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Zeit</th>
              <th>Kategorie</th>
              <th>Stand</th>
              <th>von</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td className="mono">{fmtTime(h.at)}</td>
                <td>{DAMAGE_COUNT_LABELS[h.category]}</td>
                <td className="mono">
                  {formatDamageCount(h)}
                  {h.forces ? ` (davon ${h.forces} EK)` : ''}
                  {h.note && <div className="cell-sub">{h.note}</div>}
                </td>
                <td>{h.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EntryItem({ entry: e, readOnly, onPatch }: { entry: DamageEntry; readOnly: boolean; onPatch: (p: { uncertain?: boolean; done?: boolean }) => void }) {
  const done = e.doneAt !== null;
  return (
    <li className={`damage-entry damage-entry-${e.side} ${done ? 'done' : ''}`}>
      {e.sign ? <Dv102Image id={e.sign} size={30} /> : <span className="damage-entry-dot" />}
      <span className="grow">
        {e.uncertain && <strong className="damage-uncertain">?</strong>}
        {e.count !== null && <span className="mono">{e.count} × </span>}
        {e.text || <span className="muted">(Zeichen)</span>}
        {done && <span className="cell-sub"> erledigt {fmtTime(e.doneAt!)}</span>}
      </span>
      {!readOnly && (
        <span className="damage-entry-actions">
          {!done && (
            <button type="button" className="btn btn-ghost btn-icon btn-sm" title={e.uncertain ? 'Bestätigt' : 'Unbestätigt („?“)'} onClick={() => onPatch({ uncertain: !e.uncertain })}>
              <CircleHelp size={15} />
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" title={done ? 'Wieder offen' : 'Erledigt'} onClick={() => onPatch({ done: !done })}>
            {done ? <RotateCcw size={15} /> : <Check size={15} />}
          </button>
        </span>
      )}
    </li>
  );
}

/** Ein Schadenkonto als T-Konto: links Schäden/Gefahren, rechts Kräfte/Maßnahmen, darunter Personenschäden */
function AccountCard({
  account: a,
  units,
  readOnly,
  onEdit,
  onAdd,
  onCounts,
  onClose,
}: {
  account: DamageAccount;
  units: Unit[];
  readOnly: boolean;
  onEdit: () => void;
  onAdd: (sides: DamageEntrySide[]) => void;
  onCounts: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const patch = useMutation({
    mutationFn: ({ id, p }: { id: number; p: { uncertain?: boolean; done?: boolean } }) => api.updateDamageEntry(id, p),
    onError: (e: Error) => toast('error', e.message),
  });
  const [showDone, setShowDone] = useState(false);
  const closed = a.closedAt !== null;
  const ro = readOnly || closed;
  const visible = (e: DamageEntry) => showDone || e.doneAt === null;
  const left = a.entries.filter((e) => e.side !== 'massnahme');
  const right = a.entries.filter((e) => e.side === 'massnahme');
  const doneCount = a.entries.filter((e) => e.doneAt !== null).length;
  const forces = units.filter((u) => u.accountId === a.id && u.status !== 'entlassen');
  const item = (e: DamageEntry) => <EntryItem key={e.id} entry={e} readOnly={ro} onPatch={(p) => patch.mutate({ id: e.id, p })} />;

  return (
    <Card
      className={`damage-account ${closed ? 'damage-account-closed' : ''}`}
      title={
        <>
          <DamageNumber number={a.number} /> {a.name}
          {closed && <Badge>aufgelöst {fmtTime(a.closedAt!)}</Badge>}
        </>
      }
      actions={
        !ro && (
          <>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title={a.lat !== null ? 'Auf der Karte zeigen und verschieben' : 'Auf der Karte setzen'}
              onClick={() => navigate(`/karte?konto=${a.id}`)}
            >
              <MapPin size={16} />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" title="Kopfdaten bearbeiten" onClick={onEdit}>
              <Pencil size={16} />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" title="Konto auflösen" onClick={onClose}>
              <Archive size={16} />
            </button>
          </>
        )
      }
    >
      <div className="damage-meta cell-sub">
        {[a.leader && `Leiter ${a.leader}`, a.radio && `Fm ${a.radio}`, `Stand ${fmtTime(a.updatedAt)}`].filter(Boolean).join(' · ')}
      </div>
      <div className="damage-t">
        <div className="damage-t-col">
          <h4>Schäden / Gefahren</h4>
          <ul className="damage-entries">{left.filter(visible).map(item)}</ul>
          {!left.some(visible) && <p className="muted">–</p>}
          {!ro && (
            <button className="btn btn-sm" onClick={() => onAdd(['schaden', 'gefahr'])}>
              <Plus size={14} /> Schaden / Gefahr
            </button>
          )}
        </div>
        <div className="damage-t-col">
          <h4>
            Kräfte / Maßnahmen {forces.length > 0 && <span className="muted mono">{formatStrength(sumStrength(forces))}</span>}
          </h4>
          <ul className="damage-entries">
            {forces.map((u) => (
              <li key={u.id} className="damage-entry">
                <TacticalSignImage sign={u.sign} height={24} />
                <span className="grow">
                  <Link to={`/einsatz/kraefte/${u.id}`} className="unit-link">
                    {u.name}
                  </Link>
                </span>
                <StatusBadge status={u.status} />
              </li>
            ))}
            {right.filter(visible).map(item)}
          </ul>
          {!forces.length && !right.some(visible) && <p className="muted">–</p>}
          {!ro && (
            <button className="btn btn-sm" onClick={() => onAdd(['massnahme'])}>
              <Plus size={14} /> Maßnahme
            </button>
          )}
        </div>
      </div>
      <div className="damage-foot">
        <button type="button" className="damage-counts-summary" onClick={onCounts} title="Personenschäden">
          <HeartPulse size={16} />
          {a.counts.filter((c) => c.value > 0).length === 0 ? (
            <span className="muted">Keine Personenschäden gemeldet</span>
          ) : (
            a.counts
              .filter((c) => c.value > 0)
              .map((c) => (
                <span key={c.category} className={`damage-chip damage-count-${c.category}`}>
                  {DAMAGE_COUNT_LABELS[c.category].replace('Verletzte ', '')} <strong className="mono">{formatDamageCount(c)}</strong>
                </span>
              ))
          )}
        </button>
        {doneCount > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowDone((s) => !s)}>
            {showDone ? 'Erledigte ausblenden' : `${doneCount} erledigt`}
          </button>
        )}
      </div>
    </Card>
  );
}

/** Schadenkonten im Einsatz (Lagedarstellung S2) mit Summe der Personenschäden für die Lagemeldung */
export function DamageView({ incident }: { incident: Incident }) {
  const toast = useToast();
  const readOnly = !!incident.closedAt;
  const { data: accounts, isLoading } = useDamageAccounts(incident.id);
  const { data: units = [] } = useQuery({ queryKey: ['units', incident.id], queryFn: () => api.units(incident.id) });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DamageAccount | null>(null);
  const [adding, setAdding] = useState<{ account: DamageAccount; sides: DamageEntrySide[] } | null>(null);
  const [countsId, setCountsId] = useState<number | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const onError = (e: Error) => toast('error', e.message);

  const create = useMutation({
    mutationFn: (input: DamageAccountInput) => api.createDamageAccount(incident.id, input),
    onSuccess: (a) => (setCreating(false), toast('success', `Schadenkonto ${damageAccountLabel(a)} eingerichtet`)),
    onError,
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: number; input: DamageAccountInput }) => api.updateDamageAccount(id, input),
    onSuccess: () => setEditing(null),
    onError,
  });
  const close = useMutation({
    mutationFn: (a: DamageAccount) => api.closeDamageAccount(a.id),
    onSuccess: (a) => toast('success', `Schadenkonto ${damageAccountLabel(a)} aufgelöst`),
    onError,
  });
  const addEntry = useMutation({
    mutationFn: ({ id, input }: { id: number; input: DamageEntryInput }) => api.addDamageEntry(id, input),
    onSuccess: () => setAdding(null),
    onError,
  });

  const all = useMemo(() => accounts ?? [], [accounts]);
  const totals = useMemo(() => damageTotals(all), [all]);
  if (isLoading) return <Loading />;

  const open = all.filter((a) => !a.closedAt);
  const closed = all.filter((a) => a.closedAt);
  const counting = all.find((a) => a.id === countsId) ?? null;
  const unassigned = units.filter((u) => u.accountId === null && u.status !== 'entlassen' && u.status !== 'geplant');
  const card = (a: DamageAccount) => (
    <AccountCard
      key={a.id}
      account={a}
      units={units}
      readOnly={readOnly}
      onEdit={() => setEditing(a)}
      onAdd={(sides) => setAdding({ account: a, sides })}
      onCounts={() => setCountsId(a.id)}
      onClose={() => window.confirm(`Schadenkonto ${damageAccountLabel(a)} auflösen?`) && close.mutate(a)}
    />
  );

  return (
    <div className="grid">
      <Card className="span-3" title="Personenschäden gesamt" icon={<HeartPulse size={18} />}>
        <div className="summary-row">
          {totals.length === 0 ? (
            <span className="muted">Noch keine Personenschäden gemeldet.</span>
          ) : (
            totals.map((t) => (
              <Stat
                key={t.category}
                label={DAMAGE_COUNT_LABELS[t.category]}
                value={formatDamageCount(t)}
                sub={[t.forces ? `davon ${t.forces} EK` : '', `Stand ${fmtTime(t.at)}`].filter(Boolean).join(' · ')}
              />
            ))
          )}
          {!readOnly && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={18} /> Schadenkonto
            </button>
          )}
        </div>
        {totals.some((t) => t.estimated) && <p className="cell-sub">~ enthält Schätzwerte. Doppelzählungen zwischen Konten sind möglich.</p>}
        {unassigned.length > 0 && (
          <p className="cell-sub">
            {unassigned.length} Einheit{unassigned.length === 1 ? '' : 'en'} ohne Abschnitt: {unassigned.map((u) => u.name).join(', ')}
          </p>
        )}
      </Card>

      {open.length === 0 && (
        <Card className="span-3">
          <EmptyState title="Noch keine Schadenkonten">
            {!readOnly && <p>Je Schadenstelle bzw. Einsatzabschnitt ein Konto über „+ Schadenkonto“ einrichten. Einheiten werden ihm in der Kräfteübersicht als Abschnitt zugeordnet.</p>}
          </EmptyState>
        </Card>
      )}
      <div className="span-3 damage-grid">{open.map(card)}</div>

      {closed.length > 0 && (
        <Card
          title={`Aufgelöst (${closed.length})`}
          className="span-3"
          actions={
            <button className="btn btn-sm" onClick={() => setShowClosed((s) => !s)}>
              {showClosed ? 'Ausblenden' : 'Anzeigen'}
            </button>
          }
        >
          {showClosed && <div className="damage-grid">{closed.map(card)}</div>}
        </Card>
      )}

      <Modal open={creating} title="Schadenkonto einrichten" onClose={() => setCreating(false)}>
        <AccountForm units={units} pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
      <Modal open={!!editing} title={editing ? `Schadenkonto ${damageAccountLabel(editing)}` : ''} onClose={() => setEditing(null)}>
        {editing && <AccountForm initial={editing} units={units} pending={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Modal>
      <Modal
        open={!!adding}
        title={adding ? `${adding.sides.map((s) => DAMAGE_ENTRY_SIDE_LABELS[s]).join(' / ')} – ${damageAccountLabel(adding.account)}` : ''}
        onClose={() => setAdding(null)}
        wide
      >
        {adding && <EntryForm sides={adding.sides} pending={addEntry.isPending} onSubmit={(input) => addEntry.mutate({ id: adding.account.id, input })} />}
      </Modal>
      <Modal open={!!counting} title={counting ? `Personenschäden – ${damageAccountLabel(counting)}` : ''} onClose={() => setCountsId(null)} wide>
        {counting && <CountsDialog account={counting} readOnly={readOnly || !!counting.closedAt} />}
      </Modal>
    </div>
  );
}

