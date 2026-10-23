import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { DeviceId, VehicleInfo } from '@elvis/shared';
import { api } from './api';
import { useAuth } from './auth';
import { useLive } from './live';
import { useToast } from './toast';

export interface ServerInfo {
  vehicle: VehicleInfo;
  drivers: Record<DeviceId, string>;
  limits: { stormWarnMs: number };
  docker: { enabled: boolean };
}

export function useInfo() {
  return useQuery({ queryKey: ['info'], queryFn: () => fetch('/api/info').then((r) => r.json() as Promise<ServerInfo>), staleTime: Infinity });
}

/** Laufender Einsatz – nur für angemeldete Benutzer (anonym gibt es keine Einsatzdaten). */
export function useActiveIncident() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['incident', 'active', user?.id ?? 0], queryFn: api.activeIncident, enabled: !!user });
  return user ? q : { ...q, data: null, isLoading: false };
}

/** Sends a device command and reports the outcome as toast. */
export function useCommand(device: DeviceId) {
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: ({ action, params }: { action: string; params?: Record<string, unknown> }) => api.command(device, action, params),
    onSuccess: (res) => res.message && toast('success', res.message),
    onError: (err) => toast('error', err.message),
  });
  return {
    send: (action: string, params?: Record<string, unknown>) => mutation.mutate({ action, params }),
    pending: mutation.isPending,
  };
}

/** Current time corrected by the server clock offset, ticking every second. */
export function useNow(): Date {
  const { clockOffsetMs } = useLive();
  const [now, setNow] = useState(() => new Date(Date.now() + clockOffsetMs));
  useEffect(() => {
    const t = setInterval(() => setNow(new Date(Date.now() + clockOffsetMs)), 1000);
    return () => clearInterval(t);
  }, [clockOffsetMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

/** Fahrzeugname, Funkrufname, Einheit und Kartenzeichen aus den Systemeinstellungen. */
export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: Infinity });
}
