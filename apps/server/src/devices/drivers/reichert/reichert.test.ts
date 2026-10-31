import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RadioState } from '@elvis/shared';
import { evaluateAlerts } from '../../../alerts.js';
import { RADIOS_PATTERN, ReichertZbeAdapter, parseRadios } from './adapter.js';
import { LineSplitter, gpsRequestLine, loginLines, normalizeIssi, parseLine, sdsLine, tokenize } from './protocol.js';
import { ZbeSimulator } from './simulator.js';

describe('Reichert ZBE: Protokoll', () => {
  it('meldet sich an – Standardzugang „api“, Komma- oder Leerzeichen-Schreibweise', () => {
    expect(loginLines('', '', 1)).toEqual(['login api api', 'context client 1', 'main.action.login.-1,1']);
    expect(loginLines('demo', 'geheim', 3, 'space')).toEqual(['login demo geheim', 'context client 3', 'main.action.login 0']);
  });

  it('formatiert SDS und Positionsabfrage', () => {
    expect(sdsLine(0, '6123401', 'Hallo "Welt"')).toBe('RADIO.ACTION.SM_SEND.0,"6123401","TEXT|Hallo  Welt "');
    expect(sdsLine(1, '6123401', 'Alarm', true, 'space')).toBe('RADIO.ACTION.SM_SEND.1 "6123401" "FLASH|Alarm"');
    expect(gpsRequestLine(0, '6123401', 'space')).toBe('RADIO.ACTION.GPS_REQUEST.0 0 "6123401"');
  });

  it('zerlegt Felder mit Komma oder Leerzeichen, Anführungszeichen schützen Inhalt', () => {
    expect(tokenize(',12,"262100106122101","","TEXT|Hallo, Welt"')).toEqual(['12', '262100106122101', '', 'TEXT|Hallo, Welt']);
    expect(tokenize(' "6122101" "6123401" "TEXT|Lage unverändert" "x"')).toEqual(['6122101', '6123401', 'TEXT|Lage unverändert', 'x']);
    expect(tokenize('')).toEqual([]);
  });

  it('kürzt deutsche BOS-TSI auf die ISSI', () => {
    expect(normalizeIssi('262100106123401')).toBe('6123401');
    expect(normalizeIssi('6123401')).toBe('6123401');
  });

  it('liest Text-SDS in beiden Schreibweisen; der Anschluss im Telegramm zählt ab 0', () => {
    const sds = { type: 'sds', port: 1, from: '6122101', to: '6123401', flash: false, text: 'Lage unverändert' };
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.1,7,"262100106122101","6123401","TEXT|Lage unverändert"')).toEqual(sds);
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.1 "262100106122101" "6123401" "TEXT|Lage unverändert" "x"')).toEqual(sds);
    expect(parseLine('RADIO.EVENT.SM_RECEIVED "6122101" "" "FLASH|Achtung" ""')).toMatchObject({ type: 'sds', port: null, flash: true, to: null });
  });

  it('liest TETRA-Status dezimal und hexadezimal', () => {
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.0,1,"6122101","","STATUS|32771"')).toMatchObject({ type: 'status', port: 0, code: 0x8003, status: 1 });
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.0 "6122101" "" "STATUS|$8006" ""')).toMatchObject({ type: 'status', status: 4 });
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.0,1,"6122101","","STATUS|&H800A"')).toMatchObject({ type: 'status', status: 8 });
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.0,1,"6122101","","STATUS|0"')).toMatchObject({ type: 'status', code: 0, status: null });
  });

  it('liest Positionsmeldungen in beiden Schreibweisen', () => {
    const gps = { type: 'gps', port: 2, from: '6122101', lat: 52.612345, lon: 8.371234 };
    expect(parseLine('RADIO.EVENT.GPS_DATA.2,"262100106122101",1,52.612345,8.371234')).toEqual(gps);
    expect(parseLine('RADIO.EVENT.GPS_DATA.2 "262100106122101" 1 52.612345 8.371234 0')).toEqual(gps);
  });

  it('erkennt Sprache: Aufzeichnungsinfo mit Sprecher, dann SPEAK', () => {
    expect(parseLine('RADIO.EVENT.DOKU_REC_INFO.0,5,1,"262100100001001-262100106122101"')).toEqual({
      type: 'speaker',
      port: 0,
      speaker: '6122101',
      call: '1001',
    });
    expect(parseLine('RADIO.EVENT.DOKU_REC_INFO.0,5,1,""')).toEqual({ type: 'speaker', port: 0, speaker: null, call: null });
    expect(parseLine('RADIO.EVENT.SPEAK.0')).toEqual({ type: 'speak', port: 0 });
  });

  it('ignoriert Anlagenmeldungen und Kommentare, meldet Unbekanntes als Ereignis', () => {
    for (const l of ['main.event.WATCHDOG.-1,1', 'RADIO.EVENT.DISPLAY.0,"x"', 'RADIO.EVENT.VOLUME.2,5', '# Kommentar', 'main.event.login_ok'])
      expect(parseLine(l)).toBeNull();
    expect(parseLine('RADIO.EVENT.CALL_SETUP.1,"6122101"')).toMatchObject({ type: 'event', name: 'CALL_SETUP', port: 1, from: '6122101' });
    expect(parseLine('RADIO.EVENT.SM_RECEIVED.1,1,"6122101","","TEXT|"')).toBeNull();
  });

  it('setzt Zeilen aus TCP-Bruchstücken zusammen', () => {
    const s = new LineSplitter();
    expect(s.push('RADIO.EVENT.A\r\nRADIO.EV')).toEqual(['RADIO.EVENT.A']);
    expect(s.push('ENT.B\r\n\r\n')).toEqual(['RADIO.EVENT.B']);
  });

  it('liest die Geräteliste mit den Anschlüssen 1–20', () => {
    expect(parseRadios('1:MRT:MRT Fahrzeug:6123401; 2 : FRT : Funkplatz 1;')).toEqual([
      { port: 1, type: 'MRT', name: 'MRT Fahrzeug', issi: '6123401' },
      { port: 2, type: 'FRT', name: 'Funkplatz 1', issi: '' },
    ]);
    expect(parseRadios('')).toEqual([]);
    expect(() => parseRadios('1:MRT:A;1:FRT:B')).toThrow(/doppelt/);
    expect(() => parseRadios('21:MRT:A')).toThrow(/1 bis 20/);
    const re = new RegExp(RADIOS_PATTERN);
    expect(re.test('1:MRT:MRT Fahrzeug:6123401; 2:FRT:Funkplatz 1')).toBe(true);
    expect(re.test('1:XYZ:Falsch')).toBe(false);
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

  async function connect(port: number, style: 'comma' | 'space' = 'comma') {
    adapter = new ReichertZbeAdapter({
      host: '127.0.0.1',
      port,
      username: '',
      password: '',
      clientNumber: 2,
      style,
      radios: parseRadios('1:MRT:MRT Fahrzeug:6123401; 2:FRT:Funkplatz 1'),
      reconnectMs: 100,
    });
    await adapter.start({ log, getState: () => undefined });
    return adapter;
  }

  const state = () => adapter!.getState() as RadioState;

  it.each(['comma', 'space'] as const)('meldet sich an und ordnet Ereignisse den Anschlüssen zu (%s)', async (style) => {
    sim = new ZbeSimulator({ auto: false, username: 'api', password: 'api', style });
    const port = await sim.listen(0, '127.0.0.1');
    await connect(port, style);
    await vi.waitFor(() => expect(state().link?.connected).toBe(true));
    await vi.waitFor(() =>
      expect(sim!.received.slice(0, 4)).toEqual([
        'login api api',
        'context client 2',
        style === 'comma' ? 'main.action.login.-1,1' : 'main.action.login 0',
        'ping',
      ]),
    );
    expect(state().devices.every((d) => d.online)).toBe(true);

    sim.sds(2, '6122101', 'Lage unverändert');
    sim.status(1, '6125001', 3);
    sim.gps(1, '6122102', 52.61, 8.37);
    sim.emit('main.event.WATCHDOG.-1,1');
    sim.emit(`RADIO.EVENT.CALL_SETUP.6${style === 'comma' ? ',' : ' '}"6122101"`);
    await vi.waitFor(() => expect(state().activity).toHaveLength(4));

    const [sds, status, gps, ev] = state().activity;
    expect(sds).toMatchObject({ deviceId: 'anschluss-2', kind: 'sds', peer: '6122101', text: 'Lage unverändert' });
    expect(status).toMatchObject({ deviceId: 'anschluss-1', kind: 'status', peer: '6125001', text: 'Status 3' });
    expect(gps).toMatchObject({ deviceId: 'anschluss-1', kind: 'gps', text: '52.61000, 8.37000' });
    // nicht eingetragener Anschluss (Suffix 6 = Anschluss 7) wird ergänzt
    expect(ev).toMatchObject({ deviceId: 'anschluss-7', kind: 'event', text: 'CALL_SETUP' });
    expect(state().devices.map((d) => d.name)).toEqual(['MRT Fahrzeug', 'Funkplatz 1', 'Anschluss 7']);
  });

  it('zeigt Sprache mit Sprecher aus der Aufzeichnungsinfo, auch wenn sie erst nach SPEAK kommt', async () => {
    sim = new ZbeSimulator({ auto: false });
    const port = await sim.listen(0, '127.0.0.1');
    await connect(port);
    await vi.waitFor(() => expect(state().link?.connected).toBe(true));

    sim.speak(1, '6122101');
    await vi.waitFor(() => expect(state().activity).toHaveLength(1));
    expect(state().activity[0]).toMatchObject({ deviceId: 'anschluss-1', kind: 'rx', peer: '6122101' });

    // ohne Sprecher, dann nachgereicht
    sim.speak(2, null);
    await vi.waitFor(() => expect(state().activity).toHaveLength(2));
    expect(state().activity[1]).toMatchObject({ deviceId: 'anschluss-2', kind: 'rx', peer: null });
    sim.emit('RADIO.EVENT.DOKU_REC_INFO.1,9,1,"262100100001001-262100106125001"');
    await vi.waitFor(() => expect(state().activity[1]?.peer).toBe('6125001'));
    // der gemerkte Sprecher gilt nicht für einen späteren Funkspruch
    sim.speak(2, null);
    await vi.waitFor(() => expect(state().activity).toHaveLength(3));
    expect(state().activity[2]?.peer).toBeNull();
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
    // „Funk nicht erreichbar“ (Modul offline) statt einer Meldung je Funkgerät
    const alerts = evaluateAlerts((id) => (id === 'radio' ? state() : undefined) as never, ['radio'], { stormWarnMs: 17 }).map((a) => a.id);
    expect(alerts).toEqual(['offline:radio']);

    sim = new ZbeSimulator({ auto: false });
    await sim.listen(port, '127.0.0.1');
    await vi.waitFor(() => expect(state().link?.connected).toBe(true), { timeout: 3000 });
  });
});
