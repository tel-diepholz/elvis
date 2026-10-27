import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BluezScanner, type BleAdvertisement } from './bluez.js';
import { Variant, decodeMessage, encodeMessage, messageLength, type DbusMessage } from './dbus.js';

/**
 * BlueZ im Speicher: ein Adapter hci0 mit einem bekannten Victron-Gerät. `monitor`: Advertisement Monitor
 * vorhanden; „activate“ meldet ihn danach auch aktiv, „silent“ nicht.
 */
function fakeBluez(path: string, opts: { powered?: boolean; startError?: string; monitor?: 'activate' | 'silent' } = {}) {
  const calls: DbusMessage[] = [];
  let client: Socket | null = null;
  let serial = 100;
  let discovering = false;
  /** Antworten von ELVIS auf Aufrufe von „bluetoothd“ */
  const replies = new Map<number, (m: DbusMessage) => void>();
  const send = (m: Parameters<typeof encodeMessage>[0]) => client!.write(encodeMessage(m));
  /** „bluetoothd“ ruft ein Objekt von ELVIS auf */
  const callClient = (path: string, iface: string, member: string, signature = '', body: unknown[] = []) =>
    new Promise<DbusMessage>((resolve) => {
      const s = serial++;
      replies.set(s, resolve);
      send({ type: 'call', serial: s, path, interface: iface, member, signature, body, sender: ':1.1', destination: ':1.9' });
    });
  const signal = (path: string, iface: string, member: string, signature: string, body: unknown[]) => send({ type: 'signal', serial: serial++, path, interface: iface, member, signature, body, sender: ':1.1' });
  const server: Server = createServer((socket) => {
    client = socket;
    let authed = false;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (!authed) {
        if (chunk.includes('AUTH')) socket.write('OK 0123\r\n');
        if (!chunk.includes('BEGIN\r\n')) return;
        authed = true;
        chunk = chunk.subarray(chunk.indexOf('BEGIN\r\n') + 7);
      }
      buf = Buffer.concat([buf, chunk]);
      for (let len = messageLength(buf); len !== null; len = messageLength(buf)) {
        const m = decodeMessage(buf.subarray(0, len));
        buf = buf.subarray(len);
        if (m.type !== 'call') {
          replies.get(m.replySerial!)?.(m);
          continue;
        }
        calls.push(m);
        const ok = (signature = '', body: unknown[] = []) => send({ type: 'return', serial: serial++, replySerial: m.serial, signature, body });
        const fail = (name: string) => send({ type: 'error', serial: serial++, replySerial: m.serial, errorName: name, signature: 's', body: [name] });
        if (m.member === 'Hello') ok('s', [':1.9']);
        else if (m.member === 'AddMatch') ok();
        else if (m.member === 'Get' && m.body[1] === 'Powered') ok('v', [new Variant('b', opts.powered ?? true)]);
        else if (m.member === 'Get' && m.body[1] === 'Discovering') ok('v', [new Variant('b', discovering)]);
        else if (m.member === 'Get' && m.body[1] === 'SupportedMonitorTypes' && opts.monitor) ok('v', [new Variant('as', ['or_patterns'])]);
        else if (m.member === 'Get') fail('org.freedesktop.DBus.Error.InvalidArgs');
        else if (m.member === 'RegisterMonitor') {
          // Wie bluetoothd: Monitore der Anwendung lesen, antworten, dann aktivieren
          void callClient(m.body[0] as string, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects').then((r) => {
            monitors.push(r.body[0] as Record<string, Record<string, Record<string, unknown>>>);
            ok();
            if (opts.monitor === 'activate') void callClient(Object.keys(r.body[0] as object)[0]!, 'org.bluez.AdvertisementMonitor1', 'Activate');
          });
        } else if (m.member === 'UnregisterMonitor') ok();
        else if (m.member === 'Set') ok();
        else if (m.member === 'GetManagedObjects')
          ok('a{oa{sa{sv}}}', [
            {
              '/org/bluez/hci0': { 'org.bluez.Adapter1': { Powered: new Variant('b', true) } },
              '/org/bluez/hci0/dev_C8_2E_47_00_00_01': {
                'org.bluez.Device1': { Address: new Variant('s', 'c8:2e:47:00:00:01'), Name: new Variant('s', 'Lithium Battery Smart'), RSSI: new Variant('n', -70) },
              },
            },
          ]);
        else if (m.member === 'SetDiscoveryFilter') ok();
        else if (m.member === 'StartDiscovery') {
          if (opts.startError) fail(opts.startError);
          else {
            discovering = true;
            ok();
          }
        } else if (m.member === 'StopDiscovery') ok();
        else fail('org.freedesktop.DBus.Error.UnknownMethod');
      }
    });
  });
  const monitors: Record<string, Record<string, Record<string, unknown>>>[] = [];
  return new Promise<{
    server: Server;
    calls: DbusMessage[];
    monitors: typeof monitors;
    signal: typeof signal;
    callClient: typeof callClient;
    /** Suche endet von selbst (z. B. Controller hängt) – ohne Signal */
    stopDiscovering: () => void;
    drop: () => void;
  }>((resolve) =>
    server.listen(path, () => resolve({ server, calls, monitors, signal, callClient, stopDiscovering: () => (discovering = false), drop: () => client?.destroy() })),
  );
}

describe('BlueZ-Suche', () => {
  let dir: string;
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sucht nur LE, ordnet Herstellerdaten der Adresse zu und meldet Abbrüche', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elvis-bluez-'));
    const bus = await fakeBluez(join(dir, 'bus'), { powered: false });
    server = bus.server;
    const ads: BleAdvertisement[] = [];
    const lost: Error[] = [];
    const scanner = new BluezScanner('hci0', join(dir, 'bus'));
    const how = await scanner.start(
      (a) => ads.push(a),
      (e) => lost.push(e),
    );
    const members = bus.calls.map((c) => c.member);
    expect(members).toEqual(['Hello', 'Get', 'Set', 'AddMatch', 'AddMatch', 'GetManagedObjects', 'Get', 'SetDiscoveryFilter', 'StartDiscovery']);
    // Ausgeschalteter Adapter wird eingeschaltet; ohne Advertisement Monitor aktiv suchen, Filter: nur LE, jedes Paket
    expect(bus.calls[2]!.body).toEqual(['org.bluez.Adapter1', 'Powered', true]);
    expect(how).toMatch(/^aktive Suche – passives Mitlesen nicht verfügbar/);
    expect(bus.calls[7]!.body).toEqual([{ Transport: 'le', DuplicateData: true }]);

    // Bekanntes Gerät sendet neue Herstellerdaten
    bus.signal('/org/bluez/hci0/dev_C8_2E_47_00_00_01', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', 'sa{sv}as', [
      'org.bluez.Device1',
      { RSSI: new Variant('n', -64), ManufacturerData: new Variant('a{qv}', new Map([[0x02e1, new Variant('ay', Buffer.from([0x10, 0, 0xe5, 0xa3, 5]))]])) },
      [],
    ]);
    // Neues Gerät taucht auf
    bus.signal('/', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', 'oa{sa{sv}}', [
      '/org/bluez/hci0/dev_C8_2E_47_00_00_02',
      { 'org.bluez.Device1': { Address: new Variant('s', 'C8:2E:47:00:00:02'), RSSI: new Variant('n', -80), ManufacturerData: new Variant('a{qv}', new Map([[0x02e1, new Variant('ay', Buffer.from([0x10]))]])) } },
    ]);
    // Anderer Adapter wird ignoriert
    bus.signal('/org/bluez/hci1/dev_X', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', 'sa{sv}as', ['org.bluez.Device1', { Address: new Variant('s', 'X'), ManufacturerData: new Variant('a{qv}', new Map([[1, new Variant('ay', Buffer.from([1]))]])) }, []]);
    await new Promise((r) => setTimeout(r, 30));

    expect(ads).toEqual([
      { address: 'C8:2E:47:00:00:01', name: 'Lithium Battery Smart', rssi: -64, manufacturerData: new Map([[0x02e1, Buffer.from([0x10, 0, 0xe5, 0xa3, 5])]]) },
      { address: 'C8:2E:47:00:00:02', name: null, rssi: -80, manufacturerData: new Map([[0x02e1, Buffer.from([0x10])]]) },
    ]);

    // Suche von außen beendet → wieder starten
    bus.signal('/org/bluez/hci0', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', 'sa{sv}as', ['org.bluez.Adapter1', { Discovering: new Variant('b', false) }, []]);
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.calls.filter((c) => c.member === 'StartDiscovery')).toHaveLength(2);

    bus.drop();
    await new Promise((r) => setTimeout(r, 30));
    expect(lost.map((e) => e.message)).toEqual(['Verbindung zu BlueZ getrennt']);
    await scanner.stop();
  });

  it('liest mit Advertisement Monitor passiv mit, ohne aktive Suche', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elvis-bluez-'));
    const bus = await fakeBluez(join(dir, 'bus'), { monitor: 'activate' });
    server = bus.server;
    const ads: BleAdvertisement[] = [];
    const lost: Error[] = [];
    const scanner = new BluezScanner('hci0', join(dir, 'bus'));
    expect(
      await scanner.start(
        (a) => ads.push(a),
        (e) => lost.push(e),
      ),
    ).toBe('passiv mitlesend (Advertisement Monitor)');
    const members = bus.calls.map((c) => c.member);
    expect(members).toContain('RegisterMonitor');
    expect(members).not.toContain('StartDiscovery');
    // Ein Monitor auf Victrons Herstellerdaten (AD-Typ 0xFF, beginnt mit 0x02E1 little endian)
    expect(bus.monitors[0]).toEqual({ '/de/elvis/bluetooth/victron': { 'org.bluez.AdvertisementMonitor1': { Type: 'or_patterns', Patterns: [[0, 0xff, Buffer.from([0xe1, 0x02])]] } } });

    // Werte kommen weiter als PropertiesChanged der Geräte
    bus.signal('/org/bluez/hci0/dev_C8_2E_47_00_00_01', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', 'sa{sv}as', [
      'org.bluez.Device1',
      { ManufacturerData: new Variant('a{qv}', new Map([[0x02e1, new Variant('ay', Buffer.from([0x10, 1]))]])) },
      [],
    ]);
    // DeviceFound wird bestätigt, unbekannte Aufrufe abgelehnt
    expect((await bus.callClient('/de/elvis/bluetooth/victron', 'org.bluez.AdvertisementMonitor1', 'DeviceFound', 'o', ['/org/bluez/hci0/dev_C8_2E_47_00_00_01'])).type).toBe('return');
    expect((await bus.callClient('/de/elvis/bluetooth', 'org.example', 'Quatsch')).errorName).toBe('org.freedesktop.DBus.Error.UnknownMethod');
    expect(ads.map((a) => a.address)).toEqual(['C8:2E:47:00:00:01']);

    // Gibt bluetoothd den Monitor frei, muss neu angemeldet werden
    await bus.callClient('/de/elvis/bluetooth/victron', 'org.bluez.AdvertisementMonitor1', 'Release');
    expect(lost.map((e) => e.message)).toEqual(['BlueZ hat das passive Mitlesen beendet']);
    await scanner.stop();
    expect(bus.calls.at(-1)!.member).toBe('UnregisterMonitor');
  });

  it('sucht aktiv, wenn der Monitor nicht aktiviert wird oder abgeschaltet ist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elvis-bluez-'));
    const bus = await fakeBluez(join(dir, 'bus'), { monitor: 'silent' });
    server = bus.server;
    const scanner = new BluezScanner('hci0', join(dir, 'bus'), { activateMs: 50 });
    expect(await scanner.start(() => {}, () => {})).toMatch(/nicht aktiviert/);
    const members = bus.calls.map((c) => c.member);
    expect(members.slice(members.indexOf('RegisterMonitor'))).toEqual(['RegisterMonitor', 'UnregisterMonitor', 'SetDiscoveryFilter', 'StartDiscovery']);
    await scanner.stop();

    const off = new BluezScanner('hci0', join(dir, 'bus'), { passive: false });
    expect(await off.start(() => {}, () => {})).toBe('aktive Suche – passives Mitlesen abgeschaltet');
    await off.stop();
  });

  it('Wächter: startet eine beendete Suche neu und meldet einen Neustart von bluetoothd', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elvis-bluez-'));
    const bus = await fakeBluez(join(dir, 'bus'));
    server = bus.server;
    const lost: Error[] = [];
    const scanner = new BluezScanner('hci0', join(dir, 'bus'), { watchMs: 20 });
    await scanner.start(
      () => {},
      (e) => lost.push(e),
    );
    // Suche endet still (kein PropertiesChanged) – der Wächter merkt es
    bus.stopDiscovering();
    await new Promise((r) => setTimeout(r, 80));
    expect(bus.calls.filter((c) => c.member === 'StartDiscovery')).toHaveLength(2);

    bus.signal('/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', 'sss', ['org.bluez', ':1.1', ':1.7']);
    await new Promise((r) => setTimeout(r, 30));
    expect(lost.map((e) => e.message)).toEqual(['BlueZ (bluetoothd) wurde neu gestartet']);
    await scanner.stop();
  });

  it('übersetzt BlueZ-Fehler in verständliche Meldungen', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elvis-bluez-'));
    const bus = await fakeBluez(join(dir, 'bus'), { startError: 'org.bluez.Error.NotReady' });
    server = bus.server;
    await expect(new BluezScanner('hci0', join(dir, 'bus')).start(() => {}, () => {})).rejects.toThrow(/hci0 ist nicht bereit/);
    // Läuft die Suche schon (z. B. bluetoothctl), ist das in Ordnung
    server.close();
    const again = await fakeBluez(join(dir, 'bus2'), { startError: 'org.bluez.Error.InProgress' });
    server = again.server;
    const scanner = new BluezScanner('hci0', join(dir, 'bus2'));
    await expect(scanner.start(() => {}, () => {})).resolves.toMatch(/^aktive Suche/);
    await scanner.stop();
    await expect(new BluezScanner('hci0', join(dir, 'fehlt')).start(() => {}, () => {})).rejects.toThrow(/Socket .* fehlt/);
  });
});
