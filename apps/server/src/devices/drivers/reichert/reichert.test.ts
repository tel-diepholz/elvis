import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RadioState } from '@elvis/shared';
import { evaluateAlerts } from '../../../alerts.js';
import { ReichertZbeAdapter, parseRadios, RADIOS_PATTERN } from './adapter.js';
import { LineSplitter, gpsRequestLine, loginLines, normalizeIssi, parseLine, sdsLine } from './protocol.js';
import { ZbeSimulator } from './simulator.js';

describe('Reichert ZBE: Protokoll', () => {
  it('meldet sich mit Benutzer, Clientnummer und Login-Aktion an', () => {
    expect(loginLines('demo', 'geheim', 3)).toEqual(['login demo geheim', 'context client 3', 'main.action.login 0']);
  });

  it('formatiert SDS und Positionsabfrage', () => {
    expect(sdsLine(2, '6123401', 'Hallo "Welt"')).toBe('RADIO.ACTION.SM_SEND.2 "6123401" "TEXT|Hallo  Welt "');
    expect(sdsLine(2, '6123401', 'Alarm', true)).toBe('RADIO.ACTION.SM_SEND.2 "6123401" "FLASH|Alarm"');
    expect(gpsRequestLine(1, '6123401')).toBe('RADIO.ACTION.GPS_REQUEST.1 0 "6123401"');
  });

  it('kürzt deutsche BOS-TSI auf die ISSI', () => {
    expect(normalizeIssi('262100106123401')).toBe('6123401');
    expect(normalizeIssi('6123401')).toBe('6123401');
  });

  it('liest Text-SDS mit Absender, Ziel und FuG-Nummer', () => {
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.2 "262100106122101" "6123401" "TEXT|Lage unverändert" "x"')).toEqual({
      type: 'sds',
      fug: 2,
      from: '6122101',
      to: '6123401',
      flash: false,
      text: 'Lage unverändert',
    });
    expect(parseLine('RADIO.EVENT.SM_RECEIVED "6122101" "" "FLASH|Achtung" ""')).toMatchObject({
      type: 'sds',
      fug: null,
      flash: true,
      text: 'Achtung',
      to: null,
    });
  });

  it('liest TETRA-Status dezimal und hexadezimal', () => {
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.1 "6122101" "" "STATUS|32771" ""')).toMatchObject({ type: 'status', code: 0x8003, status: 1 });
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.1 "6122101" "" "STATUS|$8006" ""')).toMatchObject({ type: 'status', status: 4 });
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.1 "6122101" "" "STATUS|800A" ""')).toMatchObject({ type: 'status', status: 8 });
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.1 "6122101" "" "STATUS|0" ""')).toMatchObject({ type: 'status', code: 0, status: null });
  });

  it('liest Positionsmeldungen auch mit vorangestelltem Kennzeichen', () => {
    expect(parseLine('RADIO.EVENT.GPS_DATA.3 "262100106122101" 1 52.612345 8.371234 0')).toEqual({
      type: 'gps',
      fug: 3,
      from: '6122101',
      lat: 52.612345,
      lon: 8.371234,
    });
    expect(parseLine('RADIO.EVENT.GPS_DATA "6122101" "52.6 8.3"')).toMatchObject({ type: 'gps', lat: 52.6, lon: 8.3 });
  });

  it('meldet Unbekanntes als Ereignis und ignoriert Zeilen ohne RADIO.EVENT', () => {
    expect(parseLine('RADIO.EVENT.CALL_SETUP.1 "6122101" "x"')).toMatchObject({
      type: 'event',
      name: 'CALL_SETUP',
      fug: 1,
      from: '6122101',
    });
    expect(parseLine('RADIO.EVENT.REC_OPTA.1 "262100106122101" "FL DH 1/44-1"')).toMatchObject({ type: 'event', name: 'REC_OPTA', from: '6122101' });
    expect(parseLine('main.event.login_ok')).toBeNull();
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.1 "6122101" "" "TEXT|" ""')).toBeNull();
  });

  it('setzt Zeilen aus TCP-Bruchstücken zusammen', () => {
    const s = new LineSplitter();
    expect(s.push('RADIO.EVENT.A\r\nRADIO.EV')).toEqual(['RADIO.EVENT.A']);
    expect(s.push('ENT.B\r\n\r\n')).toEqual(['RADIO.EVENT.B']);
  });

  it('liest die Geräteliste aus den Einstellungen', () => {
    expect(parseRadios('1:MRT:MRT Fahrzeug:6123401; 2 : FRT : Funkplatz 1;')).toEqual([
      { fug: 1, type: 'MRT', name: 'MRT Fahrzeug', issi: '6123401' },
      { fug: 2, type: 'FRT', name: 'Funkplatz 1', issi: '' },
    ]);
    expect(parseRadios('')).toEqual([]);
    expect(() => parseRadios('1:MRT:A;1:FRT:B')).toThrow(/doppelt/);
    const re = new RegExp(RADIOS_PATTERN);
    expect(re.test('1:MRT:MRT Fahrzeug:6123401; 2:FRT:Funkplatz 1')).toBe(true);
    expect(re.test('')).toBe(true);
    expect(re.test('1:XYZ:Falsch')).toBe(false);
    expect(re.test('Funkplatz 1')).toBe(false);
  });
});

describe('Reichert ZBE: Treiber gegen Simulator', () => {
  let sim: ZbeSimulator | null = null;
  let adapter: ReichertZbeAdapter | null = null;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  afterEach(async () => {
    await adapter?.stop();
    await sim?.close();
    adapter = sim = null;
  });

  async function connect(port: number, reconnectMs = 100) {
    adapter = new ReichertZbeAdapter({
      host: '127.0.0.1',
      port,
      username: 'demo',
      password: 'demo',
      clientNumber: 2,
      radios: parseRadios('1:MRT:MRT Fahrzeug:6123401; 2:FRT:Funkplatz 1'),
      reconnectMs,
    });
    await adapter.start({ log, getState: () => undefined });
    return adapter;
  }

  const state = () => adapter!.getState() as RadioState;

  it('meldet sich an, ordnet Ereignisse den Funkgeräten zu und füllt die Timeline', async () => {
    sim = new ZbeSimulator({ auto: false, username: 'demo', password: 'demo' });
    const port = await sim.listen(0, '127.0.0.1');
    await connect(port);
    await vi.waitFor(() => expect(state().link?.connected).toBe(true));
    await vi.waitFor(() => expect(sim!.received).toEqual(['login demo demo', 'context client 2', 'main.action.login 0']));
    expect(state().devices.every((d) => d.online)).toBe(true);
    expect(adapter!.isOnline()).toBe(true);

    sim.sds(2, '6122101', 'Lage unverändert');
    sim.status(1, '6125001', 3);
    sim.gps(1, '6122102', 52.61, 8.37);
    sim.emit('RADIO.EVENT.CALL_SETUP.7 "6122101"');
    await vi.waitFor(() => expect(state().activity).toHaveLength(4));

    const [sds, status, gps, ev] = state().activity;
    expect(sds).toMatchObject({
      deviceId: 'fug-2',
      kind: 'sds',
      peer: '6122101',
      text: 'Lage unverändert',
    });
    expect(sds!.end).toBe(sds!.start);
    expect(status).toMatchObject({
      deviceId: 'fug-1',
      kind: 'status',
      peer: '6125001',
      text: 'Status 3',
    });
    expect(gps).toMatchObject({
      deviceId: 'fug-1',
      kind: 'gps',
      text: '52.61000, 8.37000',
    });
    // unbekannte FuG-Nummer wird als Gerät ergänzt
    expect(ev).toMatchObject({
      deviceId: 'fug-7',
      kind: 'event',
      text: 'CALL_SETUP',
    });
    expect(state().devices.map((d) => d.name)).toEqual(['MRT Fahrzeug', 'Funkplatz 1', 'FuG 7']);
    expect(state().devices[1]!.lastActivity).not.toBeNull();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('CALL_SETUP'));
  });

  it('meldet eine gestörte Verbindung und verbindet sich neu', async () => {
    sim = new ZbeSimulator({ auto: false });
    const port = await sim.listen(0, '127.0.0.1');
    await connect(port);
    await vi.waitFor(() => expect(state().link?.connected).toBe(true));

    await sim.close();
    await vi.waitFor(() => expect(state().link?.connected).toBe(false));
    expect(state().devices.every((d) => !d.online)).toBe(true);
    expect(adapter!.isOnline()).toBe(false);
    expect(state().link?.error).toBeTruthy();
    // „Funk nicht erreichbar“ (Modul offline) statt einer Meldung je Funkgerät
    const alerts = evaluateAlerts((id) => (id === 'radio' ? state() : undefined) as never, ['radio'], { stormWarnMs: 17 }).map((a) => a.id);
    expect(alerts).toEqual(['offline:radio']);

    sim = new ZbeSimulator({ auto: false });
    await sim.listen(port, '127.0.0.1');
    await vi.waitFor(() => expect(state().link?.connected).toBe(true), {
      timeout: 3000,
    });
  });
});
