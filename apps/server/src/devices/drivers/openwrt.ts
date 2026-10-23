import type { WifiApLive, WifiState } from '@elvis/shared';
import type { WifiApSecretConfig } from '../../services/wifi.js';
import { fetchStations, UbusClient, type ApStation, type UbusHttp } from '../../services/openwrt.js';
import { BaseAdapter, command, noParams, type AdapterContext } from '../adapter.js';

/** Ergebnis einer Abfrage je AP; stations = null, wenn der AP nicht antwortete */
export interface ApPollResult {
  ap: WifiApSecretConfig;
  stations: ApStation[] | null;
}

/** Accesspoints aus den Systemeinstellungen und Ablage der angemeldeten Geräte (Tabelle wifi_clients) */
export interface WifiSource {
  list(): WifiApSecretConfig[];
  onChange(listener: () => void): () => void;
  storeClients(results: ApPollResult[]): void;
  clearClients(): void;
  /** Für Tests: HTTP-Zugriff auf ubus ersetzen */
  readonly http?: UbusHttp;
}

/**
 * WLAN-Accesspoints mit OpenWrt: fragt reihum die angemeldeten Geräte ab (iwinfo über ubus) und schreibt sie in die
 * Datenbank. Im Zustand steht je AP, ob er erreichbar ist – daraus entsteht die Meldung „Accesspoint nicht erreichbar“.
 * Das Einrichten der WLANs übernimmt der WifiService (Systemeinstellungen), unabhängig von diesem Modul.
 */
export class OpenWrtWifiAdapter extends BaseAdapter<'wifi'> {
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private polling = false;
  private stopped = false;

  protected readonly commands = {
    refresh: command(noParams, async () => {
      await this.pollAll();
    }),
  };

  constructor(
    private readonly source: WifiSource,
    private readonly pollMs: number,
  ) {
    super('wifi', 'openwrt', { aps: [] } satisfies WifiState);
  }

  isQuiet(action: string): boolean {
    return action === 'refresh';
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    // AP angelegt, geändert oder entfernt: sofort neu abfragen
    this.unsubscribe = this.source.onChange(() => void this.pollAll());
    this.timer = setInterval(() => void this.pollAll(), this.pollMs);
    await this.pollAll();
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.source.clearClients();
  }

  /** Alle aktiven APs abfragen; überlappende Läufe (langsamer AP) werden übersprungen */
  async pollAll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const aps = this.source.list().filter((a) => a.enabled);
      const results = await Promise.all(
        aps.map(async (ap): Promise<ApPollResult & { error: string | null }> => {
          try {
            return { ap, stations: await fetchStations(new UbusClient(ap, this.source.http)), error: null };
          } catch (err) {
            return { ap, stations: null, error: (err as Error).message };
          }
        }),
      );
      if (this.stopped) return;
      this.source.storeClients(results);
      const previous = new Map(this.state.aps.map((a) => [a.id, a]));
      const next: WifiApLive[] = results.map(({ ap, stations, error }) => ({
        id: ap.id,
        name: ap.name,
        online: !error,
        error,
        // nicht erreichbar: letzte bekannte Anzahl stehen lassen (die Geräte bleiben auch in der Tabelle)
        clients: stations
          ? { ops: stations.filter((s) => s.role === 'ops').length, guest: stations.filter((s) => s.role === 'guest').length }
          : (previous.get(ap.id)?.clients ?? { ops: 0, guest: 0 }),
      }));
      if (JSON.stringify(next) !== JSON.stringify(this.state.aps)) this.update((s) => void (s.aps = next));
    } finally {
      this.polling = false;
    }
  }
}
