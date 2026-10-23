import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Alert, DeviceId, DeviceSnapshot, ServerMessage, VehicleInfo } from '@elvis/shared';

export type ConnectionState = 'connecting' | 'online' | 'offline';

interface LiveState {
  connection: ConnectionState;
  vehicle: VehicleInfo | null;
  devices: Partial<Record<DeviceId, DeviceSnapshot>>;
  alerts: Alert[];
  /** Offset between server and local clock in ms, for an accurate Einsatzuhr. */
  clockOffsetMs: number;
}

type Action = { type: 'connection'; state: ConnectionState } | { type: 'message'; msg: ServerMessage };

const initial: LiveState = { connection: 'connecting', vehicle: null, devices: {}, alerts: [], clockOffsetMs: 0 };

function reducer(state: LiveState, action: Action): LiveState {
  if (action.type === 'connection') return { ...state, connection: action.state };
  const { msg } = action;
  switch (msg.type) {
    case 'hello':
      return {
        connection: 'online',
        vehicle: msg.vehicle,
        devices: Object.fromEntries(msg.devices.map((d) => [d.id, d])),
        alerts: msg.alerts,
        clockOffsetMs: new Date(msg.serverTime).getTime() - Date.now(),
      };
    case 'device':
      return { ...state, devices: { ...state.devices, [msg.device.id]: msg.device } };
    case 'deviceRemoved': {
      const { [msg.id]: _removed, ...devices } = state.devices;
      return { ...state, devices };
    }
    case 'alerts':
      return { ...state, alerts: msg.alerts };
    default:
      return state;
  }
}

/** Befehle an diesen Bildschirm (nur auf /bildschirm relevant) */
export const DISPLAY_COMMAND_EVENT = 'elvis-display-command';
/** Kartenausschnitt aus ELVIS (Fernsteuerung), detail: { tileId, view } */
export const DISPLAY_MAP_VIEW_EVENT = 'elvis-display-map-view';

const LiveContext = createContext<LiveState>(initial);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const queryClient = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      dispatch({ type: 'connection', state: 'connecting' });
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/api/live`);
      socket.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type === 'displayCommand') {
          window.dispatchEvent(new CustomEvent(DISPLAY_COMMAND_EVENT, { detail: msg.action }));
          return;
        }
        if (msg.type === 'displayMapView') {
          window.dispatchEvent(new CustomEvent(DISPLAY_MAP_VIEW_EVENT, { detail: { tileId: msg.tileId, view: msg.view } }));
          return;
        }
        if (msg.type === 'invalidate') {
          for (const topic of msg.topics) void queryClient.invalidateQueries({ queryKey: [topic] });
          return;
        }
        if (msg.type === 'hello') {
          retry = 0;
          // Data may have changed while disconnected.
          void queryClient.invalidateQueries();
        }
        dispatch({ type: 'message', msg });
      };
      socket.onclose = () => {
        if (disposed) return;
        dispatch({ type: 'connection', state: 'offline' });
        const delay = Math.min(10_000, 500 * 2 ** retry++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [queryClient]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

export function useDevice<K extends DeviceId>(id: K): DeviceSnapshot<K> | undefined {
  return useContext(LiveContext).devices[id] as DeviceSnapshot<K> | undefined;
}

export const useAlerts = () => useContext(LiveContext).alerts;
