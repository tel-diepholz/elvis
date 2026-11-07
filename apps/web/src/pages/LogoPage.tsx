import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil, Plus, Power, RefreshCw, ToggleRight, Trash2 } from 'lucide-react';
import {
  LOGO_OPS,
  LOGO_SIGNALS,
  isLogoAnalog,
  logoName,
  logoRuleActive,
  logoSignalId,
  type LogoLink,
  type LogoLinkInput,
  type LogoRule,
  type LogoRuleInput,
  type LogoSignalKind,
  type LogoState,
} from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtTime } from '../lib/format';
import { useCommand } from '../lib/hooks';
import { useDevice } from '../lib/live';
import { useToast } from '../lib/toast';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { Badge, Card, Dot, EmptyState, Field, Modal, PageHeader, Toggle, type Tone } from '../components/ui';

const SEVERITY_LABELS = { alarm: 'Alarm', warn: 'Warnung', info: 'Hinweis' } as const;
const SEVERITY_TONE: Record<keyof typeof SEVERITY_LABELS, Tone> = { alarm: 'alarm', warn: 'warn', info: 'info' };

const kindIds = (kind: LogoSignalKind) => {
  const spec = LOGO_SIGNALS.find((s) => s.kind === kind)!;
  return Array.from({ length: spec.count }, (_, i) => logoSignalId(kind, i + 1));
};

function SignalSelect({ value, onChange, kinds, labels }: { value: string; onChange: (id: string) => void; kinds?: LogoSignalKind[]; labels: Record<string, string> }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {LOGO_SIGNALS.filter((s) => !kinds || kinds.includes(s.kind)).map((s) => (
        <optgroup key={s.kind} label={s.label}>
          {kindIds(s.kind).map((id) => (
            <option key={id} value={id}>
              {labels[id] ? `${id} – ${labels[id]}` : id}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function RuleDialog({ rule, state, onClose }: { rule?: LogoRule; state: LogoState; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<LogoRuleInput>(rule ?? { signal: 'NI1', op: '=', value: 1, severity: 'warn', title: '', detail: '', enabled: true });
  const set = <K extends keyof LogoRuleInput>(k: K, x: LogoRuleInput[K]) => setV((p) => ({ ...p, [k]: x }));
  const digital = !isLogoAnalog(v.signal);
  const save = useMutation({
    mutationFn: () => (rule ? api.updateLogoRule(rule.id, v) : api.createLogoRule(v)),
    onSuccess: (r) => (toast('success', `Regel „${r.title}“ gespeichert`), onClose()),
    onError: (e) => toast('error', e.message),
  });
  return (
    <Modal open title={rule ? 'Regel ändern' : 'Regel anlegen'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Signal">
          <SignalSelect
            value={v.signal}
            labels={state.labels}
            onChange={(id) => setV((p) => ({ ...p, signal: id, op: '=', value: isLogoAnalog(id) ? 0 : 1 }))}
          />
        </Field>
        <Field label="Bedingung">
          {digital ? (
            <select value={v.value} onChange={(e) => setV((p) => ({ ...p, op: '=', value: Number(e.target.value) }))}>
              <option value={1}>ist 1 (an)</option>
              <option value={0}>ist 0 (aus)</option>
            </select>
          ) : (
            <span className="btn-row">
              <select value={v.op} onChange={(e) => set('op', e.target.value as LogoRuleInput['op'])}>
                {LOGO_OPS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <input type="number" value={v.value} onChange={(e) => set('value', Math.trunc(Number(e.target.value)))} />
            </span>
          )}
        </Field>
        <Field label="Meldungstext">
          <input value={v.title} onChange={(e) => set('title', e.target.value)} maxLength={100} placeholder="z. B. Lichtmast ausgefahren" autoFocus />
        </Field>
        <Field label="Zusatztext (optional)">
          <input value={v.detail ?? ''} onChange={(e) => set('detail', e.target.value)} maxLength={200} />
        </Field>
        <Field label="Schwere">
          <select value={v.severity} onChange={(e) => set('severity', e.target.value as LogoRuleInput['severity'])}>
            {Object.entries(SEVERITY_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Toggle label="Regel aktiv" checked={v.enabled ?? true} onChange={(on) => set('enabled', on)} />
      </div>
      <div className="form-actions">
        <span className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" disabled={!v.title.trim() || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>
    </Modal>
  );
}

function LinkDialog({ link, state, onClose }: { link?: LogoLink; state: LogoState; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<LogoLinkInput>(link ?? { name: '', button: 'NI1', output: 'Q1' });
  const save = useMutation({
    mutationFn: () => (link ? api.updateLogoLink(link.id, v) : api.createLogoLink(v)),
    onSuccess: (l) => (toast('success', `„${l.name}“ gespeichert`), onClose()),
    onError: (e) => toast('error', e.message),
  });
  return (
    <Modal open title={link ? 'Verknüpfung ändern' : 'Taster und Ausgang verknüpfen'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Name">
          <input value={v.name} onChange={(e) => setV((p) => ({ ...p, name: e.target.value }))} maxLength={60} placeholder="z. B. Umfeldbeleuchtung" autoFocus />
        </Field>
        <Field label="Taster (Netzwerk-Eingang)" hint="ELVIS setzt ihn kurz auf 1 und wieder auf 0">
          <SignalSelect value={v.button} kinds={['NI']} labels={state.labels} onChange={(id) => setV((p) => ({ ...p, button: id }))} />
        </Field>
        <Field label="Schaltausgang" hint="Zeigt, ob „an“ ist (1)">
          <SignalSelect value={v.output} kinds={['Q', 'M', 'NQ']} labels={state.labels} onChange={(id) => setV((p) => ({ ...p, output: id }))} />
        </Field>
      </div>
      <div className="form-actions">
        <span className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" disabled={!v.name.trim() || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>
    </Modal>
  );
}

/** Eingabefeld für die Bezeichnung eines Signals; gespeichert wird beim Verlassen oder mit Enter */
function LabelInput({ id, label, disabled }: { id: string; label: string; disabled: boolean }) {
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (value: string) => api.setLogoLabel(id, value),
    onError: (e) => toast('error', e.message),
    onSettled: () => setText(null),
  });
  const commit = () => {
    if (text !== null && text.trim() !== label) save.mutate(text.trim());
    else setText(null);
  };
  return (
    <input
      className="logo-label-input"
      value={text ?? label}
      disabled={disabled}
      maxLength={60}
      placeholder={disabled ? '' : 'Bezeichnung'}
      aria-label={`Bezeichnung von ${id}`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

function SignalTable({ kind, state, canEdit }: { kind: LogoSignalKind; state: LogoState; canEdit: boolean }) {
  const spec = LOGO_SIGNALS.find((s) => s.kind === kind)!;
  const ids = kindIds(kind);
  const named = ids.filter((id) => state.labels[id]).length;
  const active = ids.filter((id) => (state.values[id] ?? 0) !== 0).length;
  return (
    <details className="logo-group" open={kind === 'I' || kind === 'Q' || kind === 'NI'}>
      <summary>
        <strong>{spec.label}</strong> <span className="muted">({kind}) · {named} bezeichnet{!spec.analog && ` · ${active} an`}</span>
      </summary>
      <div className="table-wrap">
        <table className="table logo-table">
          <tbody>
            {ids.map((id) => {
              const value = state.values[id];
              return (
                <tr key={id}>
                  <td className="mono logo-id">{id}</td>
                  <td>
                    <LabelInput id={id} label={state.labels[id] ?? ''} disabled={!canEdit} />
                  </td>
                  <td className="logo-value">
                    {value === undefined ? (
                      <span className="muted">–</span>
                    ) : spec.analog ? (
                      <span className="mono">{value}</span>
                    ) : (
                      <Badge tone={value ? 'ok' : 'muted'}>{value ? 'an' : 'aus'}</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Siemens LOGO!: Werte, Bezeichnungen, Meldungsregeln und Taster mit Ausgang (live vom Modul „logo“) */
export function LogoPage() {
  const logo = useDevice('logo');
  const user = useAuth().user;
  const toast = useToast();
  const { send, pending } = useCommand('logo');
  const [ruleDialog, setRuleDialog] = useState<LogoRule | 'new' | null>(null);
  const [linkDialog, setLinkDialog] = useState<LogoLink | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (f: () => Promise<void>) => f(),
    onError: (e) => toast('error', e.message),
  });
  if (!logo) return <ModuleDisabled name="LOGO" module="logo" />;
  const state = logo.state;
  const canEdit = !!user;
  const connectionBadge = state.connected ? <Badge tone="ok">verbunden</Badge> : <Badge tone="alarm">nicht erreichbar</Badge>;

  return (
    <>
      <PageHeader
        title="LOGO"
        subtitle="Steuerung im Fahrzeug (Siemens LOGO!)"
        actions={
          <>
            {connectionBadge}
            {user && (
              <button type="button" className="btn" disabled={pending} onClick={() => send('refresh')}>
                <RefreshCw size={16} /> Jetzt abfragen
              </button>
            )}
          </>
        }
      />
      {!state.connected && <p className="tone-alarm">{state.error ?? 'Noch keine Verbindung zur LOGO.'}</p>}

      <div className="grid">
        <Card
          title="Geräte"
          icon={<Power size={18} />}
          actions={
            canEdit && (
              <button type="button" className="btn btn-sm" onClick={() => setLinkDialog('new')}>
                <Plus size={16} /> Verknüpfen
              </button>
            )
          }
        >
          {state.links.length === 0 ? (
            <p className="muted">Ein Taster (NI) und ein Schaltausgang (Q) lassen sich zu einem Gerät verknüpfen, z. B. „Umfeldbeleuchtung“.</p>
          ) : (
            <ul className="logo-links">
              {state.links.map((l) => {
                const on = state.values[l.output] === 1;
                const known = state.values[l.output] !== undefined;
                return (
                  <li key={l.id} className="logo-link">
                    <Dot tone={!known ? 'muted' : on ? 'ok' : 'muted'} />
                    <span className="logo-link-name">
                      {l.name}
                      <span className="cell-sub">
                        {l.button} → {logoName(state.labels, l.output)}
                      </span>
                    </span>
                    <Badge tone={!known ? 'muted' : on ? 'ok' : 'muted'}>{!known ? 'unbekannt' : on ? 'an' : 'aus'}</Badge>
                    {canEdit && (
                      <>
                        <button type="button" className="btn btn-primary btn-sm" disabled={pending || !state.connected} onClick={() => send('pulse', { signal: l.button })}>
                          {on ? 'Ausschalten' : 'Einschalten'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon" aria-label="Ändern" onClick={() => setLinkDialog(l)}>
                          <Pencil size={16} />
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon" aria-label="Entfernen" onClick={() => confirm(`Verknüpfung „${l.name}“ entfernen?`) && remove.mutate(() => api.removeLogoLink(l.id))}>
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card
          title="Meldungen"
          icon={<ToggleRight size={18} />}
          actions={
            canEdit && (
              <button type="button" className="btn btn-sm" onClick={() => setRuleDialog('new')}>
                <Plus size={16} /> Regel
              </button>
            )
          }
        >
          {state.rules.length === 0 ? (
            <EmptyState title="Keine Regeln">Z. B. „NI1 ist 1“ → Warnung „Lichtmast ausgefahren“.</EmptyState>
          ) : (
            <ul className="logo-links">
              {state.rules.map((r) => {
                const active = r.enabled && state.connected && logoRuleActive(r, state.values);
                return (
                  <li key={r.id} className="logo-link">
                    <Dot tone={active ? SEVERITY_TONE[r.severity] : 'muted'} />
                    <span className="logo-link-name">
                      {r.title}
                      <span className="cell-sub">
                        {logoName(state.labels, r.signal)} {r.op} {r.value}
                        {!r.enabled && ' · abgeschaltet'}
                      </span>
                    </span>
                    <Badge tone={active ? SEVERITY_TONE[r.severity] : 'muted'}>{active ? SEVERITY_LABELS[r.severity] : 'ruhig'}</Badge>
                    {canEdit && (
                      <>
                        <button type="button" className="btn btn-ghost btn-icon" aria-label="Ändern" onClick={() => setRuleDialog(r)}>
                          <Pencil size={16} />
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon" aria-label="Entfernen" onClick={() => confirm(`Regel „${r.title}“ entfernen?`) && remove.mutate(() => api.removeLogoRule(r.id))}>
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Signale">
        {!canEdit && <p className="muted">Bezeichnungen können nur angemeldete Benutzer ändern.</p>}
        {state.updatedAt && <p className="cell-sub">abgefragt {fmtTime(state.updatedAt)}</p>}
        {LOGO_SIGNALS.map((s) => (
          <SignalTable key={s.kind} kind={s.kind} state={state} canEdit={canEdit} />
        ))}
      </Card>

      {ruleDialog && <RuleDialog rule={ruleDialog === 'new' ? undefined : ruleDialog} state={state} onClose={() => setRuleDialog(null)} />}
      {linkDialog && <LinkDialog link={linkDialog === 'new' ? undefined : linkDialog} state={state} onClose={() => setLinkDialog(null)} />}
    </>
  );
}

