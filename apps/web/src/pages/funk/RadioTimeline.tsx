import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, MessageSquarePlus } from 'lucide-react';
import type { Incident, MessageInput, RadioActivity, RadioActivityKind, RadioDevice, RadioIdentity } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useActiveIncident } from '../../lib/hooks';
import { useLive } from '../../lib/live';
import { fmtTimeSec } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Modal, Segmented } from '../../components/ui';
import { MessageForm, type MessagePrefill } from '../../components/messages/MessageForm';
import { useMessageContext } from '../../components/messages/messageHooks';

export const ACTIVITY_LABEL: Record<RadioActivityKind, string> = {
  tx: 'Gesendet',
  rx: 'Sprache',
  sds: 'SDS',
  status: 'Status',
  gps: 'Position',
  event: 'Ereignis',
};

/** Funksprüche, aus denen sich eine Meldung erfassen lässt (eingehend, mit bekanntem Absender) */
const MESSAGE_KINDS: RadioActivityKind[] = ['rx', 'sds', 'status'];
const RADIO_KINDS: RadioActivityKind[] = ['rx', 'tx', 'sds', 'status'];
/** Derselbe Funkspruch auf mehreren eigenen Geräten (z. B. alle auf der Rufgruppe) wird ein Eintrag */
const SAME_CALL_MS = 2500;
const PAGE = 100;

/** Ein Funkspruch auf der Timeline; bei Sprache ggf. von mehreren eigenen Geräten gehört */
interface TimelineItem {
  id: string;
  kind: RadioActivityKind;
  start: string;
  end: string | null;
  peer: string | null;
  text: string | null;
  talkgroup: string | null;
  deviceIds: string[];
}

/** Verlauf vom Server (bis 12 h) plus laufende Einträge aus dem Gerätezustand – bleibt beim Herausfallen erhalten */
function useRadioActivity(live: RadioActivity[]): RadioActivity[] {
  const store = useRef(new Map<string, RadioActivity>());
  const [version, setVersion] = useState(0);
  const { data: history } = useQuery({ queryKey: ['radioActivity'], queryFn: () => api.radioActivity(), staleTime: Infinity });

  useEffect(() => {
    if (!history) return;
    for (const a of history) if (!store.current.has(a.id)) store.current.set(a.id, a);
    setVersion((v) => v + 1);
  }, [history]);

  useEffect(() => {
    for (const a of live) store.current.set(a.id, a);
    setVersion((v) => v + 1);
  }, [live]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => [...store.current.values()], [version]);
}

function group(entries: RadioActivity[]): TimelineItem[] {
  const sorted = [...entries].sort((a, b) => b.start.localeCompare(a.start));
  const items: TimelineItem[] = [];
  for (const a of sorted) {
    const t = new Date(a.start).getTime();
    const same =
      a.kind === 'rx' ? items.find((i) => i.kind === 'rx' && i.peer === a.peer && Math.abs(new Date(i.start).getTime() - t) < SAME_CALL_MS) : undefined;
    if (same) {
      if (!same.deviceIds.includes(a.deviceId)) same.deviceIds.push(a.deviceId);
      if (a.end === null) same.end = null;
      else if (same.end !== null && a.end > same.end) same.end = a.end;
      if (a.start < same.start) same.start = a.start;
      continue;
    }
    items.push({ id: a.id, kind: a.kind, start: a.start, end: a.end, peer: a.peer, text: a.text, talkgroup: a.talkgroup ?? null, deviceIds: [a.deviceId] });
  }
  // Zusammengefasste Einträge können früher begonnen haben als der zuerst gefundene
  return items.sort((a, b) => b.start.localeCompare(a.start));
}

function duration(item: TimelineItem, now: number): string | null {
  if (item.kind !== 'rx' && item.kind !== 'tx') return null;
  // Zeitpunkt ohne Dauer (z. B. Sprache von der Reichert ZBE)
  if (item.end !== null && item.end === item.start) return null;
  const ms = (item.end ? new Date(item.end).getTime() : now) - new Date(item.start).getTime();
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * Timeline des Funkverkehrs für Fernmelder: wer hat wann auf welchem Gerät gefunkt. Bekannte ISSIs erscheinen mit
 * der Kraft aus dem Einsatz; „Meldung erstellen“ erfasst den Funkspruch als Eingangsmeldung – wählt der Fernmelder
 * dabei eine Kraft, merkt sie sich die ISSI für diesen Einsatz.
 */
export function RadioTimeline({ devices, live }: { devices: RadioDevice[]; live: RadioActivity[] }) {
  const { user } = useAuth();
  const { data: incident } = useActiveIncident();
  const openIncident = incident && !incident.closedAt ? incident : null;
  const { data: msgCtx } = useMessageContext();
  const { data: radioIds = [] } = useQuery({
    queryKey: ['radioIds', openIncident?.id ?? 0],
    queryFn: () => api.radioIds(openIncident!.id),
    enabled: !!user && !!openIncident,
  });
  const { clockOffsetMs } = useLive();
  const activity = useRadioActivity(live);
  const [filter, setFilter] = useState<'radio' | 'all'>('radio');
  const [deviceFilter, setDeviceFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [compose, setCompose] = useState<TimelineItem | null>(null);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now() + clockOffsetMs);

  // Laufende Gespräche: Dauer mitzählen
  const running = activity.some((a) => a.end === null);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now() + clockOffsetMs), 1000);
    return () => clearInterval(t);
  }, [running, clockOffsetMs]);

  const byIssi = useMemo(() => new Map(radioIds.map((r) => [r.issi, r])), [radioIds]);
  const ownByIssi = useMemo(() => new Map(devices.filter((d) => d.issi).map((d) => [d.issi, d])), [devices]);
  const deviceName = useMemo(() => new Map(devices.map((d) => [d.id, d.name])), [devices]);

  const items = useMemo(() => {
    const kinds = filter === 'radio' ? RADIO_KINDS : null;
    return group(activity.filter((a) => (!kinds || kinds.includes(a.kind)) && (!deviceFilter || a.deviceId === deviceFilter)));
  }, [activity, filter, deviceFilter]);

  return (
    <div className="radio-timeline">
      <div className="radio-timeline-toolbar">
        <Segmented
          label="Anzeige"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'radio', label: 'Funksprüche' },
            { value: 'all', label: 'Alles', title: 'Auch Positionsmeldungen und sonstige Ereignisse' },
          ]}
        />
        <select value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)} aria-label="Funkgerät">
          <option value="">Alle Funkgeräte</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {items.length === 0 ? (
        <p className="muted">Noch kein Funkverkehr{deviceFilter ? ' auf diesem Gerät' : ''}.</p>
      ) : (
        <ol className="timeline-list">
          {items.slice(0, limit).map((item) => {
            const known = item.peer ? byIssi.get(item.peer) : undefined;
            const own = item.peer ? ownByIssi.get(item.peer) : undefined;
            // Sprache auch ohne erkannten Sprecher – der Fernmelder trägt den Absender dann selbst ein
            const canMessage = MESSAGE_KINDS.includes(item.kind) && (!!item.peer || item.kind === 'rx') && !own;
            const dur = duration(item, now);
            return (
              <li key={item.id} className={`timeline-item ${item.end === null ? 'live' : ''}`}>
                <time className="timeline-time" dateTime={item.start}>
                  {fmtTimeSec(item.start)}
                </time>
                <span className={`timeline-dot kind-${item.kind}`} aria-hidden />
                <div className="timeline-body">
                  <div className="timeline-head">
                    <span className={`timeline-kind tone-kind-${item.kind}`}>{ACTIVITY_LABEL[item.kind]}</span>
                    <Sender item={item} known={known} own={own} />
                    {item.end === null && <span className="timeline-live">spricht …</span>}
                  </div>
                  <div className="cell-sub">
                    {item.kind === 'tx' ? 'von ' : 'auf '}
                    {item.deviceIds.map((id) => deviceName.get(id) ?? id).join(', ')}
                    {item.talkgroup ? ` · ${item.talkgroup}` : ''}
                    {dur ? ` · ${dur}` : ''}
                  </div>
                  {item.text && <div className="timeline-text">{item.text}</div>}
                </div>
                {canMessage && openIncident && user && (
                  <div className="timeline-actions">
                    {done.has(item.id) ? (
                      <span className="tone-ok timeline-done">
                        <Check size={16} /> Meldung erstellt
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!msgCtx?.radio}
                        title={msgCtx?.radio ? undefined : 'Eingangsmeldungen erfassen nur Fernmelder (Rolle über das Profilmenü übernehmen)'}
                        onClick={() => setCompose(item)}
                      >
                        <MessageSquarePlus size={16} /> Meldung erstellen
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {items.length > limit && (
        <button type="button" className="btn btn-sm" onClick={() => setLimit((l) => l + PAGE)}>
          Ältere anzeigen ({items.length - limit})
        </button>
      )}

      <Modal open={compose !== null && !!openIncident} title="Eingangsmeldung aus Funkspruch" onClose={() => setCompose(null)} wide>
        {compose && openIncident && (
          <RadioToMessage
            incident={openIncident}
            item={compose}
            known={compose.peer ? byIssi.get(compose.peer) : undefined}
            onDone={() => {
              setDone((d) => new Set(d).add(compose.id));
              setCompose(null);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function Sender({ item, known, own }: { item: TimelineItem; known?: RadioIdentity; own?: RadioDevice }) {
  if (item.kind === 'tx') return <strong>Eigenes Funkgerät</strong>;
  if (!item.peer) return item.kind === 'rx' ? <strong className="muted">Sprecher unbekannt</strong> : <strong>Eigenes Funkgerät</strong>;
  if (own) return <strong>{own.name} (eigenes Gerät)</strong>;
  if (known)
    return (
      <span>
        <strong>{known.callsign || known.name}</strong>
        {known.callsign && known.callsign !== known.name ? <span className="muted"> · {known.name}</span> : null}
        <span className="muted"> · ISSI {item.peer}</span>
      </span>
    );
  return (
    <span>
      <strong>ISSI {item.peer}</strong> <span className="muted">· unbekannt</span>
    </span>
  );
}

/** Meldungsformular für einen Funkspruch: bekannte ISSI → Kraft als Absender, sonst bleibt der Absender leer */
function RadioToMessage({ incident, item, known, onDone }: { incident: Incident; item: TimelineItem; known?: RadioIdentity; onDone: () => void }) {
  const toast = useToast();
  const create = useMutation({
    mutationFn: (input: MessageInput) => api.createMessage(incident.id, input),
    onSuccess: () => (toast('success', 'Eingangsmeldung erstellt'), onDone()),
    onError: (e) => toast('error', e.message),
  });
  const prefill: MessagePrefill = {
    direction: 'in',
    sender: known?.unitId
      ? { unitId: known.unitId, text: known.name }
      : known?.forceUnitId
        ? { forceUnitId: known.forceUnitId, text: known.name }
        : { text: '' },
    radio: item.peer ? { issi: item.peer } : undefined,
    body: item.kind === 'rx' ? '' : (item.text ?? ''),
  };
  return <MessageForm incidentId={incident.id} prefill={prefill} pending={create.isPending} onSubmit={(input) => create.mutate(input)} />;
}
