import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  MONITORING_DEFAULT_LIMITS,
  MONITORING_DEFAULT_PORTS,
  MONITORING_KIND_LABELS,
  type MonitoringCheck,
  type MonitoringKind,
  type MonitoringLimits,
  type MonitoringTargetConfig,
  type MonitoringTargetInput,
  type MonitoringTestResult,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useDevice } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { MetricList, TargetBadge } from '../../components/monitoring';
import { Badge, Card, Field, Loading, Modal, Segmented, Toggle } from '../../components/ui';

const EMPTY: MonitoringTargetInput = {
  name: '',
  kind: 'snmp-printer',
  host: '',
  port: 161,
  snmpVersion: '2c',
  community: 'public',
  alwaysOn: true,
  limits: MONITORING_DEFAULT_LIMITS,
  checks: [],
  enabled: true,
};

const EMPTY_CHECK: MonitoringCheck = { label: '', query: '', scale: 1, unit: '', warnBelow: null, warnAbove: null, alarmBelow: null, alarmAbove: null };

const KINDS = (Object.keys(MONITORING_KIND_LABELS) as MonitoringKind[]).map((value) => ({ value, label: MONITORING_KIND_LABELS[value] }));

/** Zahlenfeld; leer = keine Grenze (nullable) bzw. 0 */
function NumberInput({ value, onChange, placeholder, step = 'any' }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string; step?: string }) {
  return (
    <input
      type="number"
      step={step}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
}

/** Fest eingebaute Prüfungen je Art mit ihren Schwellen */
function LimitFields({ kind, limits, onChange }: { kind: MonitoringKind; limits: MonitoringLimits; onChange: (l: MonitoringLimits) => void }) {
  const field = (key: keyof MonitoringLimits, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <NumberInput value={limits[key]} onChange={(v) => onChange({ ...limits, [key]: v ?? 0 })} />
    </Field>
  );
  if (kind === 'snmp') return <p className="field-hint">Ohne feste Prüfungen: ELVIS liest Gerätename und Laufzeit, Messwerte kommen aus den eigenen Prüfungen.</p>;
  if (kind === 'snmp-printer')
    return (
      <>
        <p className="field-hint">Geprüft werden Zustand und Störungen (Papierstau, kein Papier, Klappe offen …) sowie die Füllstände laut Drucker-MIB.</p>
        <div className="form-grid">{field('suppliesWarnPct', 'Verbrauchsmaterial: Warnung unter … %')}</div>
      </>
    );
  return (
    <>
      <p className="field-hint">Geprüft werden Last, Arbeitsspeicher, alle Dateisysteme und die Temperatur (sofern der Rechner sie meldet).</p>
      <div className="form-grid">
        {field('loadWarn', 'Last je Kern: Warnung über')}
        {field('memWarnPct', 'Freier Arbeitsspeicher: Warnung unter … %')}
        {field('diskWarnPct', 'Freier Platz: Warnung unter … %')}
        {field('diskAlarmPct', 'Freier Platz: Alarm unter … %')}
        {field('tempWarnC', 'Temperatur: Warnung über … °C')}
        {field('tempAlarmC', 'Temperatur: Alarm über … °C')}
      </div>
    </>
  );
}

function CheckRow({ kind, check, onChange, onRemove }: { kind: MonitoringKind; check: MonitoringCheck; onChange: (c: MonitoringCheck) => void; onRemove: () => void }) {
  const set = <K extends keyof MonitoringCheck>(k: K, v: MonitoringCheck[K]) => onChange({ ...check, [k]: v });
  return (
    <div className="monitoring-check">
      <div className="form-grid">
        <Field label="Bezeichnung">
          <input value={check.label} onChange={(e) => set('label', e.target.value)} maxLength={60} placeholder="z. B. Innentemperatur" />
        </Field>
        <Field label={kind === 'node-exporter' ? 'Metrik' : 'OID'}>
          <input
            className="mono"
            value={check.query}
            onChange={(e) => set('query', e.target.value.trim())}
            placeholder={kind === 'node-exporter' ? 'node_filesystem_avail_bytes{mountpoint="/data"}' : '1.3.6.1.4.1.…'}
          />
        </Field>
        <Field label="Faktor" hint="Rohwert × Faktor">
          <NumberInput value={check.scale} onChange={(v) => set('scale', v ?? 1)} />
        </Field>
        <Field label="Einheit">
          <input value={check.unit} onChange={(e) => set('unit', e.target.value)} maxLength={12} placeholder="°C" />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Warnung unter">
          <NumberInput value={check.warnBelow} onChange={(v) => set('warnBelow', v)} placeholder="–" />
        </Field>
        <Field label="Warnung über">
          <NumberInput value={check.warnAbove} onChange={(v) => set('warnAbove', v)} placeholder="–" />
        </Field>
        <Field label="Alarm unter">
          <NumberInput value={check.alarmBelow} onChange={(v) => set('alarmBelow', v)} placeholder="–" />
        </Field>
        <Field label="Alarm über">
          <NumberInput value={check.alarmAbove} onChange={(v) => set('alarmAbove', v)} placeholder="–" />
        </Field>
      </div>
      <button type="button" className="btn btn-icon monitoring-check-remove" aria-label="Prüfung entfernen" onClick={onRemove}>
        <X size={16} />
      </button>
    </div>
  );
}

function TargetDialog({ target, onClose }: { target: MonitoringTargetConfig | null; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<MonitoringTargetInput>(target ?? EMPTY);
  const [test, setTest] = useState<MonitoringTestResult | null>(null);
  const set = <K extends keyof MonitoringTargetInput>(k: K, value: MonitoringTargetInput[K]) => (setV((prev) => ({ ...prev, [k]: value })), setTest(null));
  const snmp = v.kind !== 'node-exporter';
  const valid = v.name.trim() !== '' && v.host.trim() !== '' && (!snmp || v.community !== '') && v.checks.every((c) => c.label.trim() && c.query.trim());

  const setKind = (kind: MonitoringKind) => {
    // Port mitziehen, solange er auf der Vorgabe der bisherigen Art steht
    setV((prev) => ({ ...prev, kind, port: prev.port === MONITORING_DEFAULT_PORTS[prev.kind] ? MONITORING_DEFAULT_PORTS[kind] : prev.port }));
    setTest(null);
  };
  const setCheck = (i: number, c: MonitoringCheck | null) =>
    set(
      'checks',
      c ? v.checks.map((x, j) => (j === i ? c : x)) : v.checks.filter((_, j) => j !== i),
    );

  const runTest = useMutation({ mutationFn: () => api.testMonitoringTarget(v), onSuccess: setTest, onError: (e) => toast('error', e.message) });
  const save = useMutation({
    mutationFn: () => (target ? api.updateMonitoringTarget(target.id, v) : api.createMonitoringTarget(v)),
    onSuccess: (t) => (toast('success', `„${t.name}“ gespeichert`), onClose()),
    onError: (e) => toast('error', e.message),
  });

  return (
    <Modal open wide title={target ? `Monitoring-Ziel „${target.name}“` : 'Monitoring-Ziel hinzufügen'} onClose={onClose}>
      <Field label="Art">
        <Segmented label="Art" value={v.kind} onChange={setKind} options={KINDS} />
      </Field>
      <div className="form-grid">
        <Field label="Name">
          <input value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={60} placeholder={snmp ? 'z. B. Drucker Führungsraum' : 'z. B. ELW-Server'} autoFocus />
        </Field>
        <Field label="Adresse" hint="IP-Adresse oder Hostname im Fahrzeugnetz">
          <input value={v.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="192.168.1.20" />
        </Field>
        <Field label="Port" hint={snmp ? 'SNMP: 161' : 'Node Exporter: 9100, abgefragt wird /metrics'}>
          <NumberInput value={v.port} step="1" onChange={(p) => set('port', p ?? MONITORING_DEFAULT_PORTS[v.kind])} />
        </Field>
        {snmp && (
          <>
            <Field label="SNMP-Version">
              <Segmented
                label="SNMP-Version"
                value={v.snmpVersion}
                onChange={(s) => set('snmpVersion', s)}
                options={[
                  { value: '2c', label: 'v2c' },
                  { value: '1', label: 'v1' },
                ]}
              />
            </Field>
            <Field label="Community" hint="Lese-Community, ab Werk meist „public“">
              <input value={v.community} onChange={(e) => set('community', e.target.value)} autoComplete="off" />
            </Field>
          </>
        )}
      </div>
      <Toggle label="Dauerhaft eingeschaltet" checked={v.alwaysOn} onChange={(on) => set('alwaysOn', on)} />
      <p className="field-hint">
        {v.alwaysOn
          ? 'Ist das Gerät nicht erreichbar, gibt es einen Alarm.'
          : 'Gerät wird nur bei Bedarf eingeschaltet: Ist es nicht erreichbar, gilt es als ausgeschaltet – gemeldet werden nur Probleme in den Messwerten, solange es läuft.'}
      </p>

      <h3 className="section-title">Prüfungen</h3>
      <LimitFields kind={v.kind} limits={v.limits} onChange={(l) => set('limits', l)} />
      {v.checks.map((c, i) => (
        <CheckRow key={i} kind={v.kind} check={c} onChange={(next) => setCheck(i, next)} onRemove={() => setCheck(i, null)} />
      ))}
      <button type="button" className="btn btn-sm" disabled={v.checks.length >= 30} onClick={() => set('checks', [...v.checks, EMPTY_CHECK])}>
        <Plus size={16} /> Eigene Prüfung
      </button>
      <p className="field-hint">
        {snmp
          ? 'Eigene Prüfung: beliebige OID mit Zahlenwert, z. B. eine Temperatur aus der Hersteller-MIB. Leere Grenzen werden nicht geprüft.'
          : 'Eigene Prüfung: Metrik des Node Exporters, ggf. mit Labels; bei mehreren Treffern zählt der erste. Leere Grenzen werden nicht geprüft.'}
      </p>

      <Toggle label="Ziel aktiv" checked={v.enabled} onChange={(on) => set('enabled', on)} />
      {test && (
        <div className="monitoring-test">
          <p className={test.ok ? 'tone-ok' : 'tone-alarm'}>{test.message}</p>
          {test.ok && <MetricList metrics={test.metrics} />}
        </div>
      )}
      <div className="form-actions spread">
        <button type="button" className="btn" disabled={!valid || runTest.isPending} onClick={() => runTest.mutate()}>
          {runTest.isPending ? 'Frage ab …' : 'Verbindung testen'}
        </button>
        <span className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>
    </Modal>
  );
}

/** Ziele des Monitorings (SNMP, Node Exporter) – nur Admins */
export function MonitoringCard() {
  const toast = useToast();
  const { data: targets } = useQuery({ queryKey: ['monitoring'], queryFn: api.monitoringTargets });
  const live = useDevice('monitoring');
  const [editing, setEditing] = useState<MonitoringTargetConfig | 'new' | null>(null);
  const remove = useMutation({ mutationFn: api.removeMonitoringTarget, onError: (e) => toast('error', e.message) });
  const reorder = useMutation({ mutationFn: api.reorderMonitoringTargets, onError: (e) => toast('error', e.message) });
  const move = (i: number, d: -1 | 1) => {
    if (!targets) return;
    const ids = targets.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <Card
      title="Monitoring"
      icon={<Activity size={18} />}
      className="span-3"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setEditing('new')}>
          <Plus size={16} /> Ziel hinzufügen
        </button>
      }
    >
      {!live && <p className="muted">Das Modul „Monitoring“ ist deaktiviert – die Ziele werden erst abgefragt, wenn es oben unter „Modul aktiv“ eingeschaltet ist.</p>}
      {!targets ? (
        <Loading />
      ) : targets.length === 0 ? (
        <p className="muted">Noch keine Ziele. Drucker und andere Geräte werden per SNMP abgefragt, Rechner über den Prometheus Node Exporter.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Art</th>
                <th>Adresse</th>
                <th>Betrieb</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {targets.map((t, i) => {
                const state = live?.state.targets.find((x) => x.id === t.id);
                return (
                  <tr key={t.id} className={t.enabled ? '' : 'row-muted'}>
                    <td>
                      <div className="cell-title">{t.name}</div>
                      {state?.description && <div className="cell-sub">{state.description}</div>}
                    </td>
                    <td>{MONITORING_KIND_LABELS[t.kind]}</td>
                    <td className="mono">{`${t.host}:${t.port}`}</td>
                    <td>{t.alwaysOn ? 'dauerhaft' : <Badge tone="info">bei Bedarf</Badge>}</td>
                    <td>
                      {t.enabled ? <TargetBadge target={state} /> : <Badge>deaktiviert</Badge>}
                      {t.enabled && state?.error && <div className="cell-sub">{state.error}</div>}
                    </td>
                    <td>
                      <span className="btn-row">
                        <button type="button" className="btn btn-icon" aria-label="nach oben" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                          <ArrowUp size={16} />
                        </button>
                        <button type="button" className="btn btn-icon" aria-label="nach unten" disabled={i === targets.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                          <ArrowDown size={16} />
                        </button>
                        <button type="button" className="btn btn-icon" aria-label={`${t.name} bearbeiten`} onClick={() => setEditing(t)}>
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`${t.name} entfernen`}
                          disabled={remove.isPending}
                          onClick={() => window.confirm(`Monitoring-Ziel „${t.name}“ entfernen?`) && remove.mutate(t.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <TargetDialog target={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
