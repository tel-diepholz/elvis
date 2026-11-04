import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ENERGY_KIND_LABELS,
  ENERGY_NODE_KINDS,
  ENERGY_SLOTS,
  ENERGY_SLOT_LABELS,
  INVERTER_CHANNEL_LABELS,
  VICTRON_READOUT_LABELS,
  energyFlowConfigSchema,
  type EnergyFlowConfig,
  type EnergyFlowNode,
  type EnergyNodeKind,
  type EnergySlot,
  type EnergySource,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useInfo } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { EnergyFlow } from '../../components/energy/EnergyFlow';
import { useEnergyFlow } from '../../components/energy/useEnergyFlow';
import { Badge, Loading } from '../../components/ui';

/** Quelle ↔ Wert im Auswahlfeld */
const encode = (s: EnergySource | null) => (!s ? '' : s.type === 'inverter' ? `inverter:${s.channel}` : s.type === 'bluetooth' ? `bt:${s.deviceId}` : 'balance');
function decode(v: string): EnergySource | null {
  if (v.startsWith('inverter:')) return { type: 'inverter', channel: v.slice(9) as 'ac-in' | 'ac-out' | 'dc' };
  if (v.startsWith('bt:')) return { type: 'bluetooth', deviceId: v.slice(3) };
  if (v === 'balance') return { type: 'balance' };
  return null;
}

/** Sinnvolle erste Quelle, wenn ein Platz eine Art bekommt */
function defaultSource(kind: EnergyNodeKind): EnergySource {
  if (kind === 'shore' || kind === 'generator') return { type: 'inverter', channel: 'ac-in' };
  if (kind === 'ac-loads') return { type: 'inverter', channel: 'ac-out' };
  if (kind === 'battery') return { type: 'inverter', channel: 'dc' };
  return { type: 'balance' };
}

/** Belegung des Energieflusses (Seite „Energie“): je Platz Art, Bezeichnung und Datenquellen. Nur Admins. */
export function EnergyFlowCard() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, settings, config, auto, custom, isLoading } = useEnergyFlow();
  const { data: info } = useInfo();
  const [draft, setDraft] = useState<EnergyFlowConfig | null>(null);

  useEffect(() => {
    if (!isLoading && !draft) setDraft(structuredClone(config));
  }, [isLoading, config, draft]);

  const save = useMutation({
    mutationFn: (next: EnergyFlowConfig | null) => api.saveEnergyFlow({ config: next }),
    onSuccess: (res) => {
      toast('success', res.config ? 'Energiefluss gespeichert' : 'Energiefluss wieder automatisch');
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['energyFlow'] });
    },
    onError: (err) => toast('error', err.message),
  });

  if (isLoading || !draft) return <Loading />;

  const nodeAt = (slot: EnergySlot) => draft.nodes.find((n) => n.slot === slot) ?? null;
  const setNode = (slot: EnergySlot, next: EnergyFlowNode | null) =>
    setDraft({ ...draft, nodes: [...draft.nodes.filter((n) => n.slot !== slot), ...(next ? [next] : [])].sort((a, b) => ENERGY_SLOTS.indexOf(a.slot) - ENERGY_SLOTS.indexOf(b.slot)) });
  const validation = energyFlowConfigSchema.safeParse(draft);
  const problem = validation.success ? null : validation.error.issues[0]!.message;
  const balanceUsed = (slot: EnergySlot) => draft.nodes.some((n) => n.slot !== slot && n.source.type === 'balance');

  const sourceOptions = (slot: EnergySlot, allowBalance: boolean) => (
    <>
      <optgroup label="Wechselrichter (VE.Bus)">
        {(Object.keys(INVERTER_CHANNEL_LABELS) as (keyof typeof INVERTER_CHANNEL_LABELS)[]).map((c) => (
          <option key={c} value={`inverter:${c}`}>
            {INVERTER_CHANNEL_LABELS[c].replace('Wechselrichter: ', '')}
            {!data.modules.inverter ? ' (Modul aus)' : ''}
          </option>
        ))}
      </optgroup>
      <optgroup label="Bluetooth (Instant Readout)">
        {data.bluetooth.length === 0 && <option disabled>{data.modules.bluetooth ? 'Keine Geräte eingetragen' : 'Modul Bluetooth aus'}</option>}
        {data.bluetooth.map((d) => (
          <option key={d.id} value={`bt:${d.id}`}>
            {d.name}
            {d.readout ? ` – ${VICTRON_READOUT_LABELS[d.readout.type]}` : ''}
          </option>
        ))}
      </optgroup>
      {allowBalance && (
        <option value="balance" disabled={balanceUsed(slot)}>
          Bilanz (Rest aus den anderen Plätzen)
        </option>
      )}
    </>
  );

  return (
    <div className="energy-flow-settings">
      <p className="muted">
        Sechs Plätze um das Fahrzeug. Je Platz die Art (bestimmt Symbol, Farbe und Flussrichtung), eine Bezeichnung und woher die Werte kommen. Eine
        Zusatzquelle füllt Werte, die der ersten fehlen – z. B. Batterie: Strom vom Wechselrichter, Ladezustand vom SmartShunt. „Bilanz“ zeigt, was
        nach allen anderen Plätzen übrig bleibt (sinnvoll für DC-Verbraucher, wenn ein Shunt die Batterie misst).
      </p>
      <p>
        {custom ? (
          <Badge tone="info">Eigene Belegung{settings?.updatedAt ? ` · ${fmtDateTime(settings.updatedAt)}${settings.updatedBy ? ` · ${settings.updatedBy}` : ''}` : ''}</Badge>
        ) : (
          <Badge>Automatisch aus den vorhandenen Geräten</Badge>
        )}
      </p>

      <div className="energy-flow-editor">
        <div className="energy-flow-slots">
          {ENERGY_SLOTS.map((slot) => {
            const n = nodeAt(slot);
            return (
              <fieldset key={slot} className="energy-flow-slot">
                <legend>{ENERGY_SLOT_LABELS[slot]}</legend>
                <label className="field">
                  <span className="field-label">Art</span>
                  <select
                    value={n?.kind ?? ''}
                    onChange={(e) => {
                      const kind = e.target.value as EnergyNodeKind | '';
                      if (!kind) return setNode(slot, null);
                      setNode(slot, n ? { ...n, kind } : { slot, kind, label: ENERGY_KIND_LABELS[kind], source: defaultSource(kind), extra: null });
                    }}
                  >
                    <option value="">– leer –</option>
                    {ENERGY_NODE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {ENERGY_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
                {n && (
                  <>
                    <label className="field">
                      <span className="field-label">Bezeichnung</span>
                      <input value={n.label} maxLength={30} placeholder={ENERGY_KIND_LABELS[n.kind]} onChange={(e) => setNode(slot, { ...n, label: e.target.value })} />
                    </label>
                    <label className="field">
                      <span className="field-label">Werte von</span>
                      <select value={encode(n.source)} onChange={(e) => setNode(slot, { ...n, source: decode(e.target.value)!, extra: e.target.value === 'balance' ? null : n.extra })}>
                        {sourceOptions(slot, true)}
                      </select>
                    </label>
                    {n.source.type !== 'balance' && (
                      <label className="field">
                        <span className="field-label">Zusätzlich (fehlende Werte)</span>
                        <select value={encode(n.extra)} onChange={(e) => setNode(slot, { ...n, extra: decode(e.target.value) })}>
                          <option value="">– keine –</option>
                          {sourceOptions(slot, false)}
                        </select>
                      </label>
                    )}
                  </>
                )}
              </fieldset>
            );
          })}
          <label className="field">
            <span className="field-label">Bezeichnung der Mitte</span>
            <input value={draft.hubLabel} maxLength={30} placeholder={info?.vehicle.name ?? 'Fahrzeug'} onChange={(e) => setDraft({ ...draft, hubLabel: e.target.value })} />
          </label>
        </div>
        <div className="energy-flow-preview">
          <span className="field-label">Vorschau mit Live-Werten</span>
          <EnergyFlow config={draft} data={data} hubLabel={draft.hubLabel || info?.vehicle.name || 'Fahrzeug'} />
        </div>
      </div>

      {problem && <p className="tone-alarm">{problem}</p>}
      <div className="btn-row">
        <button className="btn btn-primary" type="button" disabled={!!problem || save.isPending} onClick={() => save.mutate(draft)}>
          Speichern
        </button>
        <button className="btn" type="button" disabled={save.isPending} onClick={() => setDraft(structuredClone(auto))}>
          Automatische Belegung übernehmen
        </button>
        {custom && (
          <button className="btn btn-ghost" type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Zurück auf automatisch
          </button>
        )}
      </div>
    </div>
  );
}
