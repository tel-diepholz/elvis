import { Fragment, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ClipboardList, Copy, Link2, Trash2, UserPlus } from 'lucide-react';
import { FORM_VALID_HOURS, personName, type PersonnelSheet, type SheetAssign, type Unit } from '@elvis/shared';
import { api } from '../../lib/api';
import { useActiveIncident } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Modal } from '../../components/ui';
import { QrCode } from '../../components/WifiQr';
import { PersonnelTable } from '../../components/forces/personnel';

async function copy(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Ohne HTTPS gibt es keine Zwischenablage-API
    input?.select();
    return document.execCommand('copy');
  }
}

/** Cloud-Personalabfrage: Link anfordern, zeigen (QR) und beenden */
function FormLinkCard() {
  const toast = useToast();
  const onError = (e: Error) => toast('error', e.message);
  const { data: incident } = useActiveIncident();
  const { data } = useQuery({ queryKey: ['personnelSheets', 'inbox'], queryFn: api.personnelSheets });
  const [hours, setHours] = useState(24);
  const urlRef = useRef<HTMLInputElement>(null);
  const create = useMutation({ mutationFn: () => api.createPersonnelForm({ validHours: hours }), onError });
  const close = useMutation({ mutationFn: api.closePersonnelForm, onSuccess: () => toast('success', 'Link beendet'), onError });
  if (!data?.relayEnabled) return null;
  const form = data.form;

  return (
    <Card title="Cloud-Personalabfrage" icon={<Link2 size={18} />} className="span-2">
      {!incident ? (
        <p className="muted">Ein Link lässt sich anfordern, sobald ein Einsatz aufgelegt ist.</p>
      ) : form ? (
        <div className="form-link">
          <QrCode data={form.url} label="QR-Code zur Cloud-Personalabfrage" className="qr" />
          <div className="form">
            <p className="muted">
              Einheitsführer öffnen diesen Link am Handy und tragen Einheit / Fahrzeug und ihr Personal ein. Eingereichte Bögen erscheinen hier im Dokumenten-Eingang. Gültig bis{' '}
              {fmtDateTime(form.expiresAt)}, längstens bis zum Einsatzende.
            </p>
            <div className="btn-row">
              <input ref={urlRef} className="grow mono form-link-url" value={form.url} readOnly onFocus={(e) => e.target.select()} aria-label="Adresse des Formulars" />
              <button className="btn" onClick={() => void copy(form.url, urlRef.current).then((ok) => toast(ok ? 'success' : 'error', ok ? 'Adresse kopiert' : 'Kopieren nicht möglich'))}>
                <Copy size={16} /> Kopieren
              </button>
            </div>
            <div className="btn-row">
              <button
                className="btn"
                disabled={create.isPending}
                onClick={() => window.confirm('Neuen Link erzeugen? Der bisherige gilt dann nicht mehr.') && create.mutate()}
              >
                Neuer Link
              </button>
              <button className="btn" disabled={close.isPending} onClick={() => window.confirm('Link beenden? Danach lassen sich keine Bögen mehr einreichen.') && close.mutate()}>
                Beenden
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="form">
          <p className="muted">
            ELVIS erzeugt einen Link, über den Einheitsführer das Personal ihrer Einheit melden. Die Angaben werden schon im Browser für diesen ELW verschlüsselt und
            sind in der Cloud nicht lesbar.
          </p>
          <div className="btn-row">
            <select className="auto-width" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Gültigkeit">
              {FORM_VALID_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h} Stunden gültig
                </option>
              ))}
            </select>
            <button className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Fordere an …' : 'Link anfordern'}
            </button>
          </div>
        </div>
      )}
      {data.lastError && <p className="tone-alarm">{data.lastError}</p>}
    </Card>
  );
}

/** Zuordnen: bestehende Einheit oder neue Einheit mit dem Namen aus dem Bogen */
function AssignForm({ sheet, units, pending, onSubmit }: { sheet: PersonnelSheet; units: Unit[]; pending: boolean; onSubmit: (input: SheetAssign) => void }) {
  const active = units.filter((u) => u.status !== 'entlassen');
  const match = active.find((u) => u.name.trim().toLowerCase() === sheet.unitLabel.trim().toLowerCase());
  const [target, setTarget] = useState<number | 'new'>(sheet.unitId ?? match?.id ?? 'new');
  const [name, setName] = useState(sheet.unitLabel);
  const [parentId, setParentId] = useState<number | null>(null);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(target === 'new' ? { newUnit: { name: name.trim(), parentId } } : { unitId: target });
      }}
    >
      <p>
        „{sheet.unitLabel}“ mit {sheet.persons.length} Person{sheet.persons.length === 1 ? '' : 'en'}
        {sheet.unitId && sheet.unitName && <> – bisher bei {sheet.unitName}; das Personal zieht mit</>}.
      </p>
      <Field label="Einheit">
        <select value={target} onChange={(e) => setTarget(e.target.value === 'new' ? 'new' : Number(e.target.value))} autoFocus>
          <option value="new">+ Neue Einheit anlegen</option>
          {active.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.callsign ? ` (${u.callsign})` : ''}
            </option>
          ))}
        </select>
      </Field>
      {target === 'new' && (
        <div className="form-grid">
          <Field label="Name der neuen Einheit" hint="Stärke wird aus dem Personal übernommen">
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </Field>
          <Field label="Unterstellt">
            <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">– eigenständig (oberste Ebene) –</option>
              {active.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || (target === 'new' && !name.trim()) || target === sheet.unitId}>
          Zuordnen
        </button>
      </div>
    </form>
  );
}

/** Personalbögen im Dokumenten-Eingang: neue markieren, ansehen, einer Einheit zuordnen (danach sind sie beim Personal der Einheit) */
export function PersonnelSheets() {
  const toast = useToast();
  const onError = (e: Error) => toast('error', e.message);
  const { data: incident } = useActiveIncident();
  const { data } = useQuery({ queryKey: ['personnelSheets', 'inbox'], queryFn: api.personnelSheets });
  const { data: units = [] } = useQuery({ queryKey: ['units', incident?.id ?? 0], queryFn: () => api.units(incident!.id), enabled: !!incident });
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [assigning, setAssigning] = useState<PersonnelSheet | null>(null);
  // Beim Öffnen neue Bögen merken (für die Markierung) und als gelesen melden
  const fresh = useRef(new Set<number>());
  const sheets = data?.sheets ?? [];
  const unread = sheets.filter((s) => !s.readAt);
  useEffect(() => {
    if (unread.length === 0) return;
    for (const s of unread) fresh.current.add(s.id);
    void api.markSheetsRead();
  }, [unread.map((s) => s.id).join()]);

  const assign = useMutation({
    mutationFn: ({ sheet, input }: { sheet: PersonnelSheet; input: SheetAssign }) => api.assignSheet(sheet.id, input),
    onSuccess: (s) => (setAssigning(null), toast('success', `Personalbogen ${s.unitName} zugeordnet`)),
    onError,
  });
  const remove = useMutation({ mutationFn: (s: PersonnelSheet) => api.removeSheet(s.id), onError });
  const toggle = (id: number) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <FormLinkCard />
      {sheets.length > 0 && (
        <Card title={`Personalbögen (${sheets.length})`} icon={<ClipboardList size={18} />} className="span-2">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Eingegangen</th>
                  <th>Einheit / Fahrzeug</th>
                  <th>Personal</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sheets.map((s) => (
                  <Fragment key={s.id}>
                    <tr className={fresh.current.has(s.id) ? 'sheet-new' : ''}>
                      <td className="mono">
                        {fmtDateTime(s.receivedAt)} {fresh.current.has(s.id) && <Badge tone="alarm">neu</Badge>}
                      </td>
                      <td className="cell-title">{s.unitLabel}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={() => toggle(s.id)} aria-expanded={open.has(s.id)}>
                          {open.has(s.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {s.persons.length} Person{s.persons.length === 1 ? '' : 'en'}
                        </button>
                        <div className="cell-sub">
                          {s.persons
                            .slice(0, 3)
                            .map((p) => personName(p))
                            .join('; ')}
                          {s.persons.length > 3 && ' …'}
                        </div>
                      </td>
                      <td>
                        <span className="btn-row">
                          {incident && (
                            <button
                              className="btn btn-ghost btn-icon"
                              onClick={() => setAssigning(s)}
                              aria-label="Einheit zuordnen"
                              title="Einheit zuordnen"
                            >
                              <UserPlus size={16} />
                            </button>
                          )}
                          <button
                            className="btn btn-ghost btn-icon"
                            onClick={() =>
                              window.confirm(`Personalbogen „${s.unitLabel}“ aus dem Dokumenten-Eingang löschen?`) &&
                              remove.mutate(s)
                            }
                            aria-label="Löschen"
                            title="Aus dem Dokumenten-Eingang löschen"
                          >
                            <Trash2 size={16} />
                          </button>
                        </span>
                      </td>
                    </tr>
                    {open.has(s.id) && (
                      <tr>
                        <td colSpan={4}>
                          <PersonnelTable persons={s.persons} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {!incident && <p className="muted">Zuordnen lässt sich ein Bogen, solange ein Einsatz aufgelegt ist.</p>}
        </Card>
      )}
      <Modal open={!!assigning} title="Personalbogen zuordnen" onClose={() => setAssigning(null)}>
        {assigning && <AssignForm sheet={assigning} units={units} pending={assign.isPending} onSubmit={(input) => assign.mutate({ sheet: assigning, input })} />}
      </Modal>
    </>
  );
}
