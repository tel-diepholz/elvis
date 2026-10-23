import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { ServerMessage, Topic, VehicleInfo } from '@elvis/shared';
import type { DeviceManager } from '../devices/manager.js';

/** WebSocket hub: pushes device states, alerts and REST invalidations to all clients. */
export interface DisplayPresence {
  identify(req: FastifyRequest): string | null;
  setOnline(id: string, online: boolean): void;
}

export class LiveHub {
  private readonly clients = new Set<WebSocket>();
  /** Verbindungen gekoppelter Bildschirme (Bildschirm-ID → Sockets) */
  private readonly displaySockets = new Map<string, Set<WebSocket>>();
  private displays: DisplayPresence | null = null;

  constructor(
    private readonly devices: DeviceManager,
    private readonly vehicle: () => VehicleInfo,
  ) {
    devices.onDevice((device) => this.broadcast({ type: 'device', device }));
    devices.onRemoved((id) => this.broadcast({ type: 'deviceRemoved', id }));
    devices.onAlerts((alerts) => this.broadcast({ type: 'alerts', alerts }));
  }

  /** Bildschirme an ihrem Gerätecookie erkennen (Online-Status, gezielte Befehle) */
  attachDisplays(presence: DisplayPresence): void {
    this.displays = presence;
  }

  register(app: FastifyInstance): void {
    app.get('/api/live', { websocket: true }, (socket, req) => {
      this.clients.add(socket);
      const displayId = this.displays?.identify(req) ?? null;
      if (displayId) {
        const set = this.displaySockets.get(displayId) ?? new Set();
        set.add(socket);
        this.displaySockets.set(displayId, set);
        this.displays!.setOnline(displayId, true);
      }
      const gone = () => {
        this.clients.delete(socket);
        if (!displayId) return;
        const set = this.displaySockets.get(displayId);
        set?.delete(socket);
        if (!set?.size) {
          this.displaySockets.delete(displayId);
          this.displays?.setOnline(displayId, false);
        }
      };
      socket.on('close', gone);
      socket.on('error', gone);
      this.send(socket, {
        type: 'hello',
        serverTime: new Date().toISOString(),
        vehicle: this.vehicle(),
        devices: this.devices.snapshots(),
        alerts: this.devices.getAlerts(),
      });
    });
  }

  invalidate(topics: Topic[]): void {
    this.broadcast({ type: 'invalidate', topics });
  }

  /** Nachricht nur an einen Bildschirm; false = nicht verbunden */
  sendToDisplay(displayId: string, msg: ServerMessage): boolean {
    const set = this.displaySockets.get(displayId);
    if (!set?.size) return false;
    for (const c of set) if (c.readyState === c.OPEN) this.send(c, msg);
    return true;
  }

  /** Verbindungen eines entkoppelten Bildschirms trennen */
  disconnectDisplay(displayId: string): void {
    for (const c of this.displaySockets.get(displayId) ?? []) c.close(4001, 'Bildschirm entkoppelt');
  }

  closeAll(): void {
    for (const c of this.clients) c.close(1001, 'Server fährt herunter');
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(data);
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    socket.send(JSON.stringify(msg));
  }
}
