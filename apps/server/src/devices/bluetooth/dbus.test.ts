import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbusConnection, DbusError, Variant, decodeMessage, encodeMessage, messageLength, splitSignature, systemBusPath, type DbusMessage } from './dbus.js';

describe('D-Bus-Nachrichten', () => {
  it('zerlegt Signaturen in Einzeltypen', () => {
    expect(splitSignature('sa{sv}as')).toEqual(['s', 'a{sv}', 'as']);
    expect(splitSignature('oa{sa{sv}}')).toEqual(['o', 'a{sa{sv}}']);
    expect(splitSignature('a(yv)ub')).toEqual(['a(yv)', 'u', 'b']);
    expect(() => splitSignature('a{sv')).toThrow();
  });

  it('kodiert und liest verschachtelte Werte wieder', () => {
    const props = { Address: new Variant('s', 'C8:2E:47:12:34:56'), RSSI: new Variant('n', -71), ManufacturerData: new Variant('a{qv}', new Map([[0x02e1, new Variant('ay', Buffer.from([0x10, 0, 1, 2]))]])) };
    const msg = encodeMessage({ type: 'signal', serial: 7, path: '/org/bluez/hci0', interface: 'org.freedesktop.DBus.ObjectManager', member: 'InterfacesAdded', signature: 'oa{sa{sv}}', body: ['/org/bluez/hci0/dev_C8', { 'org.bluez.Device1': props }] });
    expect(msg.length % 8 === 0 || messageLength(msg) === msg.length).toBe(true);
    expect(messageLength(msg.subarray(0, msg.length - 1))).toBeNull();
    const m = decodeMessage(msg);
    expect(m).toMatchObject({ type: 'signal', serial: 7, path: '/org/bluez/hci0', member: 'InterfacesAdded', signature: 'oa{sa{sv}}' });
    expect(m.body[0]).toBe('/org/bluez/hci0/dev_C8');
    const device = (m.body[1] as Record<string, Record<string, unknown>>)['org.bluez.Device1']!;
    expect(device.Address).toBe('C8:2E:47:12:34:56');
    expect(device.RSSI).toBe(-71);
    expect((device.ManufacturerData as Record<string, Buffer>)['737']).toEqual(Buffer.from([0x10, 0, 1, 2]));
  });

  it('kodiert Zahlen, Wahrheitswerte und Strukturen', () => {
    const m = decodeMessage(encodeMessage({ type: 'return', serial: 2, replySerial: 1, signature: 'ybnqiuxtd(sb)ao', body: [255, true, -2, 65535, -5, 4e9, -(2n ** 40n), 2n ** 63n, 1.5, ['x', false], ['/a', '/b']] }));
    expect(m.body).toEqual([255, true, -2, 65535, -5, 4e9, -(2n ** 40n), 2n ** 63n, 1.5, ['x', false], ['/a', '/b']]);
  });

  it('liest die Bus-Adresse aus der Umgebung', () => {
    expect(systemBusPath({ DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/host/run/dbus/system_bus_socket' })).toBe('/host/run/dbus/system_bus_socket');
    expect(systemBusPath({})).toBe('/run/dbus/system_bus_socket');
  });
});

/** Minimaler Bus: nimmt jede Anmeldung an, beantwortet Hello und Echo, meldet Fehler für alles andere */
function fakeBus(path: string, onCall?: (m: DbusMessage, reply: (msg: Buffer) => void) => void): Promise<{ server: Server; clients: Socket[] }> {
  const clients: Socket[] = [];
  const server = createServer((socket) => {
    clients.push(socket);
    let authed = false;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (!authed) {
        const text = chunk.toString('latin1');
        if (text.includes('AUTH EXTERNAL')) socket.write('OK 1234deadbeef\r\n');
        if (!text.includes('BEGIN\r\n')) return;
        authed = true;
        chunk = chunk.subarray(chunk.indexOf('BEGIN\r\n') + 7);
      }
      buf = Buffer.concat([buf, chunk]);
      for (let len = messageLength(buf); len !== null; len = messageLength(buf)) {
        const m = decodeMessage(buf.subarray(0, len));
        buf = buf.subarray(len);
        const reply = (msg: Buffer) => socket.write(msg);
        if (m.member === 'Hello') reply(encodeMessage({ type: 'return', serial: 1, replySerial: m.serial, signature: 's', body: [':1.42'] }));
        else if (onCall) onCall(m, reply);
        else reply(encodeMessage({ type: 'error', serial: 2, replySerial: m.serial, errorName: 'org.bluez.Error.NotReady', signature: 's', body: ['Resource Not Ready'] }));
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ server, clients })));
}

describe('D-Bus-Verbindung', () => {
  let dir: string;
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('meldet sich an, ruft Methoden auf und empfängt Signale', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elvis-dbus-'));
    const path = join(dir, 'bus');
    const bus = await fakeBus(path, (m, reply) => {
      if (m.member === 'Echo') {
        // Variants kommen ausgepackt an – als a{ss} zurückschicken
        reply(encodeMessage({ type: 'return', serial: 3, replySerial: m.serial, signature: 'a{ss}', body: m.body }));
        reply(encodeMessage({ type: 'signal', serial: 4, path: '/x', interface: 'org.test', member: 'Ping', signature: 'u', body: [5] }));
      } else reply(encodeMessage({ type: 'error', serial: 2, replySerial: m.serial, errorName: 'org.bluez.Error.NotReady', signature: 's', body: ['Resource Not Ready'] }));
    });
    server = bus.server;
    const conn = await DbusConnection.connect(path);
    const signal = new Promise<DbusMessage>((resolve) => conn.once('signal', resolve));
    expect(await conn.call({ destination: 'org.test', path: '/', interface: 'org.test', member: 'Echo', signature: 'a{sv}', body: [{ Transport: new Variant('s', 'le') }] })).toEqual([{ Transport: 'le' }]);
    expect((await signal).body).toEqual([5]);
    await expect(conn.call({ destination: 'org.bluez', path: '/org/bluez/hci0', interface: 'org.bluez.Adapter1', member: 'StartDiscovery' })).rejects.toThrow(DbusError);
    const closed = new Promise((resolve) => conn.once('close', resolve));
    bus.clients.forEach((c) => c.destroy());
    await closed;
    await expect(conn.call({ destination: 'a', path: '/', interface: 'a', member: 'b' })).rejects.toThrow(/getrennt/);
  });

  it('meldet einen fehlenden Socket verständlich', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elvis-dbus-'));
    await expect(DbusConnection.connect(join(dir, 'fehlt'))).rejects.toThrow(/fehlt/);
  });
});
