import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { REQUEST_STATUS_LABELS, type Incident, type MaterialRequest, type RequestStatus } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLive } from '../../lib/live';
import { Badge, type Tone } from '../ui';
import { DueFields, fromLocalInput, toLocalInput, type DueMode } from '../tasks/TaskForm';

export const REQUESTS_PATH = '/einsatz/anforderungen';

export function useRequests(incident: Incident | null | undefined) {
  const { user } = useAuth();
  return useQuery({ queryKey: ['requests', incident?.id ?? 0], queryFn: () => api.requests(incident!.id), enabled: !!user && !!incident });
}

export function useRequestSettings() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['requests', 'settings'], queryFn: api.requestSettings, enabled: !!user });
}

const STATUS_TONE: Record<RequestStatus, Tone> = {
  planned: 'muted',
  approved: 'info',
  ordered: 'warn',
  delivered: 'ok',
  rejected: 'alarm',
  cancelled: 'muted',
};

export function RequestStatusBadge({ request: r }: { request: Pick<MaterialRequest, 'status'> }) {
  return <Badge tone={STATUS_TONE[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</Badge>;
}

/** Bedarf: sofort oder bis Zeitpunkt */
export type NeedMode = 'now' | 'at';

/**
 * Wiedervorlage („in … Minuten“ oder Zeitpunkt) – Pflicht für offene Anforderungen. value() liefert ISO oder null,
 * wenn der Zeitpunkt fehlt; in Minuten zählt ab der Serverzeit.
 */
export function useFollowUp(initial?: string, defaultMinutes = 30) {
  const { clockOffsetMs } = useLive();
  const [mode, setMode] = useState<DueMode>(initial ? 'at' : 'in');
  const [inMinutes, setInMinutes] = useState(defaultMinutes);
  const [at, setAt] = useState(initial ? toLocalInput(initial) : '');
  const value = () => (mode === 'in' ? new Date(Date.now() + clockOffsetMs + inMinutes * 60_000).toISOString() : fromLocalInput(at));
  const field = <DueFields label="Wiedervorlage *" mode={mode} setMode={setMode} inMinutes={inMinutes} setInMinutes={setInMinutes} at={at} setAt={setAt} allowNone={false} />;
  return { field, value };
}
