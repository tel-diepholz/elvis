import { DbusConnection, DbusError, Variant, systemBusPath, type DbusMessage } from './dbus.js';

/** Ein empfangenes Werbepaket */
export interface BleAdvertisement {
  address: string;
  name: string | null;
  rssi: number | null;
  /** Herstellerdaten je Hersteller-ID (ohne die ID selbst) */
  manufacturerData: Map<number, Buffer>;
}

/** Quelle für Werbepakete: BlueZ auf dem Host oder Simulation/Test */
export interface BleScanner {
  readonly label: string;
  /** Suche starten; `onLost` meldet einen späteren Abbruch (z. B. bluetoothd neu gestartet) */
  start(onAdvertisement: (a: BleAdvertisement) => void, onLost: (err: Error) => void): Promise<void>;
  stop(): Promise<void>;
}

const BLUEZ = 'org.bluez';
const PROPS = 'org.freedesktop.DBus.Properties';

/** Verständliche Meldungen für typische Fehler */
function explain(err: unknown, adapter: string): Error {
  if (err instanceof DbusError) {
    if (err.name === 'org.freedesktop.DBus.Error.ServiceUnknown') return new Error('BlueZ (bluetoothd) läuft auf dem Server nicht');
    if (err.name === 'org.freedesktop.DBus.Error.UnknownObject' || err.name === 'org.freedesktop.DBus.Error.UnknownMethod') return new Error(`Bluetooth-Adapter ${adapter} nicht gefunden`);
    if (err.name === 'org.freedesktop.DBus.Error.AccessDenied') return new Error('Kein Zugriff auf BlueZ – D-Bus-Freigabe für den ELVIS-Benutzer fehlt (siehe README)');
    if (err.name === 'org.bluez.Error.NotReady') return new Error(`Bluetooth-Adapter ${adapter} ist nicht bereit (ausgeschaltet oder blockiert, „rfkill list“)`);
    return new Error(`BlueZ: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Bluetooth-LE-Suche über BlueZ (bluetoothd des Hosts) per D-Bus. ELVIS braucht dafür nur den System-Bus-Socket,
 * keine besonderen Rechte und kein Host-Netzwerk. Gesucht wird passiv mitlesend: Die Geräte senden ihre Werte in
 * Werbepaketen, BlueZ meldet jede Änderung der Herstellerdaten als PropertiesChanged.
 */
export class BluezScanner implements BleScanner {
  private conn: DbusConnection | null = null;
  /** Bekannte Geräte je D-Bus-Pfad (Adresse, Name, Signalstärke) */
  private readonly known = new Map<string, { address: string; name: string | null; rssi: number | null }>();
  private stopping = false;

  constructor(
    private readonly adapter = 'hci0',
    private readonly busPath = systemBusPath(),
  ) {}

  get label(): string {
    return this.adapter;
  }

  private get adapterPath(): string {
    return `/org/bluez/${this.adapter}`;
  }

  async start(onAdvertisement: (a: BleAdvertisement) => void, onLost: (err: Error) => void): Promise<void> {
    this.stopping = false;
    this.known.clear();
    const conn = await DbusConnection.connect(this.busPath);
    this.conn = conn;
    try {
      const call = (iface: string, member: string, signature?: string, body?: unknown[], path = this.adapterPath) =>
        conn.call({ destination: BLUEZ, path, interface: iface, member, signature, body });

      const powered = (await call(PROPS, 'Get', 'ss', ['org.bluez.Adapter1', 'Powered']))[0];
      if (!powered) await call(PROPS, 'Set', 'ssv', ['org.bluez.Adapter1', 'Powered', new Variant('b', true)]);

      conn.on('signal', (m) => this.onSignal(m, onAdvertisement, () => void this.discover().catch((err) => onLost(explain(err, this.adapter)))));
      conn.on('close', (err) => {
        if (!this.stopping) onLost(new Error(`Verbindung zu BlueZ getrennt${err ? `: ${err.message}` : ''}`));
      });
      await conn.addMatch(`type='signal',sender='${BLUEZ}'`);

      // Schon bekannte Geräte übernehmen, damit Pfad → Adresse für spätere Änderungen bekannt ist
      const objects = (await call('org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', undefined, undefined, '/'))[0] as Record<string, Record<string, Record<string, unknown>>>;
      for (const [path, ifaces] of Object.entries(objects)) {
        const dev = ifaces['org.bluez.Device1'];
        if (dev && path.startsWith(`${this.adapterPath}/`)) this.remember(path, dev, onAdvertisement);
      }
      await this.discover();
    } catch (err) {
      this.stopping = true;
      conn.close();
      this.conn = null;
      throw explain(err, this.adapter);
    }
  }

  /** Nur LE, und jedes Paket melden – auch wenn sich die Daten nicht geändert haben */
  private async discover(): Promise<void> {
    const conn = this.conn;
    if (!conn || this.stopping) return;
    const call = (member: string, signature?: string, body?: unknown[]) => conn.call({ destination: BLUEZ, path: this.adapterPath, interface: 'org.bluez.Adapter1', member, signature, body });
    await call('SetDiscoveryFilter', 'a{sv}', [{ Transport: new Variant('s', 'le'), DuplicateData: new Variant('b', true) }]);
    try {
      await call('StartDiscovery');
    } catch (err) {
      // Läuft schon (z. B. von bluetoothctl) – genügt
      if (!(err instanceof DbusError && err.name === 'org.bluez.Error.InProgress')) throw err;
    }
  }

  private remember(path: string, props: Record<string, unknown>, emit: (a: BleAdvertisement) => void): void {
    const before = this.known.get(path);
    const entry = {
      address: typeof props.Address === 'string' ? props.Address.toUpperCase() : (before?.address ?? ''),
      // Alias nicht nehmen: ohne Namen ist das nur die Adresse
      name: typeof props.Name === 'string' ? props.Name : (before?.name ?? null),
      rssi: typeof props.RSSI === 'number' ? props.RSSI : (before?.rssi ?? null),
    };
    if (!entry.address) return;
    this.known.set(path, entry);
    const md = props.ManufacturerData as Record<string, unknown> | undefined;
    if (!md) return;
    const manufacturerData = new Map<number, Buffer>();
    for (const [id, data] of Object.entries(md)) if (Buffer.isBuffer(data)) manufacturerData.set(Number(id), data);
    if (manufacturerData.size) emit({ ...entry, manufacturerData });
  }

  private onSignal(m: DbusMessage, emit: (a: BleAdvertisement) => void, rediscover: () => void): void {
    if (m.member === 'InterfacesAdded') {
      const [path, ifaces] = m.body as [string, Record<string, Record<string, unknown>>];
      const dev = ifaces['org.bluez.Device1'];
      if (dev && path.startsWith(`${this.adapterPath}/`)) this.remember(path, dev, emit);
    } else if (m.member === 'InterfacesRemoved') {
      this.known.delete(m.body[0] as string);
    } else if (m.member === 'PropertiesChanged' && m.path) {
      const [iface, changed] = m.body as [string, Record<string, unknown>];
      if (iface === 'org.bluez.Device1' && m.path.startsWith(`${this.adapterPath}/`)) this.remember(m.path, changed, emit);
      // Suche von außen beendet (z. B. Adapter neu gestartet): wieder aufnehmen
      else if (iface === 'org.bluez.Adapter1' && m.path === this.adapterPath && (changed.Discovering === false || changed.Powered === true)) rediscover();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    await conn.call({ destination: BLUEZ, path: this.adapterPath, interface: 'org.bluez.Adapter1', member: 'StopDiscovery', timeoutMs: 2_000 }).catch(() => undefined);
    conn.close();
  }
}
