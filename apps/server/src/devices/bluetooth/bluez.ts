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
  /**
   * Suche starten; `onLost` meldet einen späteren Abbruch (z. B. bluetoothd neu gestartet). Liefert optional, wie
   * gesucht wird (für das Log).
   */
  start(onAdvertisement: (a: BleAdvertisement) => void, onLost: (err: Error) => void): Promise<string | void>;
  stop(): Promise<void>;
}

const BLUEZ = 'org.bluez';
const PROPS = 'org.freedesktop.DBus.Properties';
const MONITOR_IFACE = 'org.bluez.AdvertisementMonitor1';
/** Eigene D-Bus-Objekte für den Advertisement Monitor */
const APP_PATH = '/de/elvis/bluetooth';
const MONITOR_PATH = `${APP_PATH}/victron`;
/** Herstellerdaten (AD-Typ 0xFF), die mit Victrons Hersteller-ID 0x02E1 (little endian) beginnen */
const VICTRON_PATTERN: [number, number, Buffer] = [0, 0xff, Buffer.from([0xe1, 0x02])];

/** Verständliche Meldungen für typische Fehler */
function explain(err: unknown, adapter: string): Error {
  if (err instanceof DbusError) {
    if (err.name === 'org.freedesktop.DBus.Error.ServiceUnknown') return new Error('BlueZ (bluetoothd) läuft auf dem Server nicht');
    if (err.name === 'org.freedesktop.DBus.Error.UnknownObject' || err.name === 'org.freedesktop.DBus.Error.UnknownMethod') return new Error(`Bluetooth-Adapter ${adapter} nicht gefunden`);
    if (err.name === 'org.freedesktop.DBus.Error.AccessDenied') return new Error('Kein Zugriff auf BlueZ – D-Bus-Freigabe für den ELVIS-Benutzer fehlt (siehe README)');
    if (err.name === 'org.bluez.Error.NotReady') return new Error(`Bluetooth-Adapter ${adapter} ist nicht bereit (ausgeschaltet oder blockiert, „rfkill list“)`);
    // Meist hängt der Controller (dmesg: „tx timeout“) – das behebt nur Ab- und Anstecken
    if (err.name === 'org.bluez.Error.Failed') return new Error(`Bluetooth-Adapter ${adapter} antwortet nicht (${err.message}) – auf dem Server „dmesg“ prüfen, Dongle neu einstecken`);
    return new Error(`BlueZ: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Bluetooth-LE-Empfang über BlueZ (bluetoothd des Hosts) per D-Bus. ELVIS braucht dafür nur den System-Bus-Socket,
 * keine besonderen Rechte und kein Host-Netzwerk. Die Geräte senden ihre Werte in Werbepaketen, BlueZ meldet jede
 * Änderung der Herstellerdaten als PropertiesChanged.
 *
 * Bevorzugt wird passiv mitgelesen (Advertisement Monitor auf Victrons Hersteller-ID): Der Controller scannt dann
 * durchgehend, ohne die aktive Suche, die bluetoothd alle ~10 s neu startet. Bei jedem Neustart setzt der Kernel eine
 * neue Zufallsadresse – daran hängen sich manche Realtek-Dongles (RTL8761BU) nach einer Weile auf. Kann BlueZ keinen
 * Advertisement Monitor (ältere Version, D-Bus-Freigabe fehlt), sucht ELVIS wie bisher aktiv.
 *
 * Ein Wächter prüft regelmäßig, ob die Suche noch läuft, und meldet über `onLost`, wenn bluetoothd neu startet oder
 * der Adapter nicht mehr antwortet.
 */
export class BluezScanner implements BleScanner {
  private conn: DbusConnection | null = null;
  /** Bekannte Geräte je D-Bus-Pfad (Adresse, Name, Signalstärke) */
  private readonly known = new Map<string, { address: string; name: string | null; rssi: number | null }>();
  private stopping = false;
  private mode: 'monitor' | 'discovery' = 'discovery';
  private watch: NodeJS.Timeout | null = null;
  /** Wartet auf Activate von bluetoothd nach RegisterMonitor */
  private activated: (() => void) | null = null;

  constructor(
    private readonly adapter = 'hci0',
    private readonly busPath = systemBusPath(),
    private readonly opts: { watchMs?: number; activateMs?: number; passive?: boolean } = {},
  ) {}

  get label(): string {
    return this.adapter;
  }

  private get adapterPath(): string {
    return `/org/bluez/${this.adapter}`;
  }

  async start(onAdvertisement: (a: BleAdvertisement) => void, onLost: (err: Error) => void): Promise<string> {
    this.stopping = false;
    this.known.clear();
    const conn = await DbusConnection.connect(this.busPath);
    this.conn = conn;
    let lost = false;
    const lose = (err: Error) => {
      if (this.stopping || lost) return;
      lost = true;
      onLost(err);
    };
    try {
      const call = (iface: string, member: string, signature?: string, body?: unknown[], path = this.adapterPath) =>
        conn.call({ destination: BLUEZ, path, interface: iface, member, signature, body });

      const powered = (await call(PROPS, 'Get', 'ss', ['org.bluez.Adapter1', 'Powered']))[0];
      if (!powered) await call(PROPS, 'Set', 'ssv', ['org.bluez.Adapter1', 'Powered', new Variant('b', true)]);

      conn.on('signal', (m) => {
        // bluetoothd neu gestartet: Suche bzw. Monitor sind dort vergessen – neu anmelden
        if (m.member === 'NameOwnerChanged' && m.body[0] === BLUEZ) return lose(new Error('BlueZ (bluetoothd) wurde neu gestartet'));
        this.onSignal(m, onAdvertisement, () => void this.discover().catch((err) => lose(explain(err, this.adapter))));
      });
      conn.on('call', (m) => this.onCall(m, () => lose(new Error('BlueZ hat das passive Mitlesen beendet'))));
      conn.on('close', (err) => lose(new Error(`Verbindung zu BlueZ getrennt${err ? `: ${err.message}` : ''}`)));
      await conn.addMatch(`type='signal',sender='${BLUEZ}'`);
      await conn.addMatch(`type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${BLUEZ}'`);

      // Schon bekannte Geräte übernehmen, damit Pfad → Adresse für spätere Änderungen bekannt ist
      const objects = (await call('org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', undefined, undefined, '/'))[0] as Record<string, Record<string, Record<string, unknown>>>;
      for (const [path, ifaces] of Object.entries(objects)) {
        const dev = ifaces['org.bluez.Device1'];
        if (dev && path.startsWith(`${this.adapterPath}/`)) this.remember(path, dev, onAdvertisement);
      }

      const why = this.opts.passive === false ? 'abgeschaltet' : await this.monitor();
      this.mode = why === null ? 'monitor' : 'discovery';
      if (this.mode === 'discovery') await this.discover();

      this.watch = setInterval(() => void this.check().catch((err) => lose(explain(err, this.adapter))), this.opts.watchMs ?? 30_000);
      this.watch.unref();
      return this.mode === 'monitor' ? 'passiv mitlesend (Advertisement Monitor)' : `aktive Suche – passives Mitlesen ${why}`;
    } catch (err) {
      this.stopping = true;
      conn.close();
      this.conn = null;
      throw explain(err, this.adapter);
    }
  }

  /** Advertisement Monitor anmelden; null, wenn BlueZ ihn aktiviert hat, sonst der Grund */
  private async monitor(): Promise<string | null> {
    const conn = this.conn!;
    try {
      const types = (await conn.call({ destination: BLUEZ, path: this.adapterPath, interface: PROPS, member: 'Get', signature: 'ss', body: ['org.bluez.AdvertisementMonitorManager1', 'SupportedMonitorTypes'] }))[0];
      if (!Array.isArray(types) || !types.includes('or_patterns')) return 'nicht unterstützt';
    } catch {
      return 'nicht verfügbar (BlueZ zu alt oder ohne --experimental)';
    }
    // BlueZ liest die Monitore über GetManagedObjects und ruft danach Activate auf
    const activated = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.opts.activateMs ?? 5_000);
      this.activated = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    try {
      await conn.call({ destination: BLUEZ, path: this.adapterPath, interface: 'org.bluez.AdvertisementMonitorManager1', member: 'RegisterMonitor', signature: 'o', body: [APP_PATH] });
    } catch (err) {
      this.activated = null;
      return `abgelehnt (${err instanceof Error ? err.message : String(err)})`;
    }
    if (await activated) return null;
    await this.unregister();
    return 'nicht aktiviert (D-Bus-Freigabe für bluetoothd prüfen)';
  }

  /** Aufrufe von bluetoothd an den eigenen Advertisement Monitor */
  private onCall(m: DbusMessage, released: () => void): void {
    const conn = this.conn;
    if (!conn) return;
    const props = { Type: new Variant('s', 'or_patterns'), Patterns: new Variant('a(yyay)', [VICTRON_PATTERN]) };
    if (m.path === APP_PATH && m.interface === 'org.freedesktop.DBus.ObjectManager' && m.member === 'GetManagedObjects') {
      return conn.reply(m, 'a{oa{sa{sv}}}', [{ [MONITOR_PATH]: { [MONITOR_IFACE]: props } }]);
    }
    if (m.path === MONITOR_PATH && m.interface === PROPS && m.member === 'GetAll') return conn.reply(m, 'a{sv}', [m.body[0] === MONITOR_IFACE ? props : {}]);
    if (m.path === MONITOR_PATH && m.interface === MONITOR_IFACE) {
      conn.reply(m);
      if (m.member === 'Activate') {
        this.activated?.();
        this.activated = null;
      } else if (m.member === 'Release' && !this.stopping) released();
      // DeviceFound/DeviceLost: Werte kommen ohnehin als PropertiesChanged der Geräte
      return;
    }
    conn.replyError(m, 'org.freedesktop.DBus.Error.UnknownMethod', `${m.interface}.${m.member} gibt es hier nicht`);
  }

  private async unregister(): Promise<void> {
    await this.conn
      ?.call({ destination: BLUEZ, path: this.adapterPath, interface: 'org.bluez.AdvertisementMonitorManager1', member: 'UnregisterMonitor', signature: 'o', body: [APP_PATH], timeoutMs: 2_000 })
      .catch(() => undefined);
  }

  /** Nur LE, und jedes Paket melden – auch wenn sich die Daten nicht geändert haben */
  private async discover(): Promise<void> {
    const conn = this.conn;
    if (!conn || this.stopping || this.mode !== 'discovery') return;
    const call = (member: string, signature?: string, body?: unknown[]) => conn.call({ destination: BLUEZ, path: this.adapterPath, interface: 'org.bluez.Adapter1', member, signature, body });
    await call('SetDiscoveryFilter', 'a{sv}', [{ Transport: new Variant('s', 'le'), DuplicateData: new Variant('b', true) }]);
    try {
      await call('StartDiscovery');
    } catch (err) {
      // Läuft schon (z. B. von bluetoothctl) – genügt
      if (!(err instanceof DbusError && err.name === 'org.bluez.Error.InProgress')) throw err;
    }
  }

  /** Wächter: Adapter noch da und eingeschaltet, aktive Suche noch an (sonst neu starten) */
  private async check(): Promise<void> {
    const conn = this.conn;
    if (!conn || this.stopping) return;
    const get = async (name: string) => (await conn.call({ destination: BLUEZ, path: this.adapterPath, interface: PROPS, member: 'Get', signature: 'ss', body: ['org.bluez.Adapter1', name] }))[0];
    if (!(await get('Powered'))) throw new Error(`Bluetooth-Adapter ${this.adapter} ist ausgeschaltet`);
    if (this.mode === 'discovery' && !(await get('Discovering'))) await this.discover();
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
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    const conn = this.conn;
    if (!conn) return;
    if (this.mode === 'monitor') await this.unregister();
    else await conn.call({ destination: BLUEZ, path: this.adapterPath, interface: 'org.bluez.Adapter1', member: 'StopDiscovery', timeoutMs: 2_000 }).catch(() => undefined);
    this.conn = null;
    conn.close();
  }
}
