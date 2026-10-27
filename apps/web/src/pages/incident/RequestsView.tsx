import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { AlarmClock, PackageOpen, PackagePlus, Plus } from 'lucide-react';
import { PROCUREMENT_MODE_LABELS, requestLabel, requestOpen, requestOverdue, type Incident, type MaterialRequest, type RequestInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime, fmtTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Loading, Modal, Segmented } from '../../components/ui';
import { RequestDialog } from '../../components/requests/RequestDialog';
import { RequestForm } from '../../components/requests/RequestForm';
import { RequestStatusBadge, useRequests } from '../../components/requests/requestParts';

type Filter = 'open' | 'due' | 'all';

function RequestRow({ request: r, now, onOpen }: { request: MaterialRequest; now: Date; onOpen: () => void }) {
  const overdue = requestOverdue(r, now);
  const open = requestOpen(r.status);
  return (
    <li className={`message-item ${overdue ? 'message-attention' : ''} ${open ? '' : 'message-done'}`}>
      <button type="button" className="message-item-main" onClick={onOpen}>
        <div className="message-item-head">
          <span>
            <strong className="mono">{requestLabel(r)}</strong> · <strong>{r.unit}</strong>
          </span>
          <span className="message-time">{fmtTime(r.createdAt)}</span>
        </div>
        <div className="message-preview">{r.material}</div>
        <div className="message-item-foot">
          <RequestStatusBadge request={r} />
          <span className="cell-sub">Bedarf {r.neededBy ? `bis ${fmtDateTime(r.neededBy)}` : 'sofort'}</span>
          {open && (
            <span className={overdue ? 'tone-alarm' : 'cell-sub'}>
              <AlarmClock size={13} /> Wiedervorlage {fmtDateTime(r.followUpAt)}
            </span>
          )}
          {r.forwardedAt && <Badge tone="info">an Stab {fmtTime(r.forwardedAt)}</Badge>}
        </div>
      </button>
    </li>
  );
}

/** Materialanforderungen im Einsatz: anlegen, Status und Wiedervorlage führen (Beschaffungsrolle) */
export function RequestsView({ incident }: { incident: Incident }) {
  const toast = useToast();
  const now = useNow();
  const { data: requests, isLoading } = useRequests(incident);
  const [filter, setFilter] = useState<Filter>('open');
  const [creating, setCreating] = useState(false);
  // ?id= öffnet eine Anforderung, z. B. aus ihrer Wiedervorlage-Aufgabe
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get('id')) || null;
  const setOpenId = (id: number | null) => setParams(id ? { id: String(id) } : {}, { replace: true });

  const create = useMutation({
    mutationFn: (input: RequestInput) => api.createRequest(incident.id, input),
    onSuccess: (r) => (setCreating(false), toast('success', `Anforderung ${requestLabel(r)} angelegt`)),
    onError: (e) => toast('error', e.message),
  });

  if (isLoading || !requests) return <Loading />;

  const lists: Record<Filter, MaterialRequest[]> = {
    open: requests.filter((r) => requestOpen(r.status)),
    due: requests.filter((r) => requestOverdue(r, now)),
    all: requests,
  };
  const shown = lists[filter];

  return (
    <>
      <Card
        title={lists.due.length ? `${lists.due.length} zur Wiedervorlage` : 'Anforderungen'}
        icon={<PackagePlus size={18} />}
        actions={
          !incident.closedAt && (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              <Plus size={16} /> Anforderung
            </button>
          )
        }
      >
        <p className="cell-sub">
          Beschaffung: {PROCUREMENT_MODE_LABELS[incident.procurementMode]}
          {incident.procurementMode === 'staff' && incident.procurementStaff && ` (${incident.procurementStaff})`} – einstellbar in den Einsatzdaten
        </p>
        <div className="message-filters">
          <Segmented<Filter>
            label="Filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'open', label: `Offen (${lists.open.length})` },
              { value: 'due', label: `Wiedervorlage fällig (${lists.due.length})` },
              { value: 'all', label: `Alle (${lists.all.length})` },
            ]}
          />
        </div>
        {shown.length === 0 ? (
          <EmptyState icon={<PackageOpen size={36} />} title={filter === 'all' ? 'Noch keine Anforderungen' : 'Keine Anforderungen'} />
        ) : (
          <ul className="message-list">
            {shown.map((r) => (
              <RequestRow key={r.id} request={r} now={now} onOpen={() => setOpenId(r.id)} />
            ))}
          </ul>
        )}
      </Card>

      <Modal open={creating} title="Neue Anforderung" onClose={() => setCreating(false)} wide>
        <RequestForm incidentId={incident.id} pending={create.isPending} onSubmit={(input) => create.mutate(input)} />
      </Modal>
      <RequestDialog incident={incident} requestId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
