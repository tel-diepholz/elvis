import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RadioState } from '@elvis/shared';
import { evaluateAlerts } from '../../../alerts.js';
import { ReichertZbeAdapter, isRadioLine } from './adapter.js';
import { LineSplitter, gpsRequestLine, loginLines, normalizeIssi, parseLine, sdsLine, stripCaller, tokenize } from './protocol.js';
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

  it('liest Sprache, Sprechtaste und Funkrufname der Anlage 7.0 (echter Mitschnitt)', () => {
    expect(parseLine('RADIO.EVENT.PEAK.2,1,203')).toEqual({ type: 'peak', port: 2, active: true });
    expect(parseLine('RADIO.EVENT.PEAK.2,0,203')).toEqual({ type: 'peak', port: 2, active: false });
    expect(parseLine('RADIO.EVENT.SPEAK.5,1,2')).toEqual({ type: 'speak', port: 5, active: true });
    expect(parseLine('RADIO.EVENT.SPEAK.2,0,-1')).toEqual({ type: 'speak', port: 2, active: false });
    expect(parseLine('RADIO.EVENT.REC_OPTA.2,1,24,"NIFW DH 83-12ELW2     21"')).toEqual({ type: 'rec', port: 2, name: 'NIFW DH 83-12ELW2     21' });
    expect(parseLine('RADIO.EVENT.REC_OPTA.2,0,0,""')).toEqual({ type: 'rec', port: 2, name: '' });
  });

  it('liest die Konfiguration der Anlage', () => {
    expect(parseLine('RADIO.EVENT.CONFIG.-1,1')).toEqual({ type: 'config', active: true });
    expect(parseLine('RADIO.EVENT.CONFIG.-1,0')).toEqual({ type: 'config', active: false });
    expect(parseLine('RADIO.EVENT.CONFIG_LINE.1,1,1,0,"DF 2","TETRA/MOTOROLA-PEI",NULL,"","DF",1,125953871,-1,""')).toEqual({
      type: 'line',
      port: 1,
      name: 'DF 2',
      kind: 'TETRA/MOTOROLA-PEI',
      short: 'DF',
    });
    expect(parseLine('RADIO.EVENT.CONFIG_LINE.8,1,8,0,"Intercom-Fahrer","ANALOG/BOSCH",NULL,"","IC",8,6291595,-1,""')).toMatchObject({ kind: 'ANALOG/BOSCH', short: 'IC' });
    expect(isRadioLine('TETRA/MOTOROLA-PEI', 'DF')).toBe(true);
    expect(isRadioLine('ANALOG/BOSCH', 'IC')).toBe(false);
    expect(isRadioLine('ELA', 'ELA')).toBe(false);
    expect(isRadioLine('DAB', 'DAB')).toBe(false);
  });

  it('liest die SDS der Anlage 7.0 (echter Mitschnitt) und schneidet den Funkrufnamen ab', () => {
    const ev = parseLine('RADIO.EVENT.SM_RECEIVED.2,"bc10eed2-da3f-11f1-809b-000000000000","4221526","4228237","NIFW DH 83-12ELW2     21Hi",9,5,""');
    expect(ev).toEqual({ type: 'sds', port: 2, from: '4221526', to: '4228237', flash: false, text: 'NIFW DH 83-12ELW2     21Hi' });
    expect(stripCaller('NIFW DH 83-12ELW2     21Hi', ['KLS Diepholz', 'NIFW DH 83-12ELW2     21'])).toBe('Hi');
    expect(stripCaller('Hi', ['KLS Diepholz'])).toBe('Hi');
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
      reconnectMs: 100,
    });
    await adapter.start({ log, getState: () => undefined });
    return adapter;
  }

  const state = () => adapter!.getState() as RadioState;

  it.each(['comma', 'space'] as const)('meldet sich an und ordnet Ereignisse den Anschlüssen zu (%s)', async (style) => {
    sim = new ZbeSimulator({ auto: false, ports: [1, 2], username: 'api', password: 'api', style });
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

    // Funkgeräte kommen aus der Konfiguration der Anlage, ELA/DAB/Intercom fehlen
    await vi.waitFor(() => expect(state().devices.map((d) => d.name)).toEqual(['DF 1', 'DF 2']));

    sim.sds(2, '4221526', 'Lage unverändert', 'NIFW DH 83-12ELW2     21');
    sim.status(1, '6125001', 3);
    sim.gps(1, '6122102', 52.61, 8.37);
    sim.emit('main.event.WATCHDOG.-1,1');
    sim.emit(`RADIO.EVENT.CALL_SETUP.6${style === 'comma' ? ',' : ' '}"6122101"`);
    await vi.waitFor(() => expect(state().activity).toHaveLength(4));

    const [sds, status, gps, ev] = state().activity;
    expect(sds).toMatchObject({ deviceId: 'anschluss-2', kind: 'sds', peer: '4221526' });
    expect(sds!.text).toMatch(/Lage unverändert$/);
    expect(status).toMatchObject({ deviceId: 'anschluss-1', kind: 'status', peer: '6125001', text: 'Status 3' });
    expect(gps).toMatchObject({ deviceId: 'anschluss-1', kind: 'gps', text: '52.61000, 8.37000' });
    // Anschluss ohne Konfiguration (Suffix 6 = Anschluss 7) wird als Gerät ergänzt
    expect(ev).toMatchObject({ deviceId: 'anschluss-7', kind: 'event', text: 'CALL_SETUP' });
  });

  it('ignoriert Ereignisse von ELA, DAB und Intercom', async () => {
    sim = new ZbeSimulator({ auto: false, ports: [1, 2] });
    const port = await sim.listen(0, '127.0.0.1');
    await connect(port);
    await vi.waitFor(() => expect(state().devices).toHaveLength(2));
    sim.emit('RADIO.EVENT.PEAK.1,1,203'); // DF 2
    sim.emit('RADIO.EVENT.PEAK.2,1,203'); // ELA
    sim.emit('RADIO.EVENT.PEAK.4,1,203'); // Intercom
    await vi.waitFor(() => expect(state().activity).toHaveLength(1));
    expect(state().devices.map((d) => d.name)).toEqual(['DF 1', 'DF 2']);
  });

  it('zeigt Sprache als Zeitspanne mit Funkrufname, eigenes Senden über die Sprechtaste', async () => {
    sim = new ZbeSimulator({ auto: false, ports: [1, 2] });
    const port = await sim.listen(0, '127.0.0.1');
    await connect(port);
    await vi.waitFor(() => expect(state().devices).toHaveLength(2));

    sim.speakStart(2, 'NIFW DH 83-12ELW2     21');
    await vi.waitFor(() => expect(state().activity[0]?.text).toBe('NIFW DH 83-12ELW2     21'));
    expect(state().activity[0]).toMatchObject({ deviceId: 'anschluss-2', kind: 'rx', end: null });
    expect(state().devices[1]).toMatchObject({ receiving: true, transmitting: false });
    sim.speakEnd(2);
    await vi.waitFor(() => expect(state().activity[0]?.end).not.toBeNull());
    expect(state().devices[1]).toMatchObject({ receiving: false });

    // Eine SDS lehrt die ISSI zum Funkrufnamen; spätere Sprache trägt sie als Gegenstelle
    sim.sds(2, '4221526', 'Hallo', 'NIFW DH 83-12ELW2     21');
    await vi.waitFor(() => expect(state().activity.some((a) => a.kind === 'sds')).toBe(true));
    sim.speakStart(2, 'NIFW DH 83-12ELW2     21');
    await vi.waitFor(() => expect(state().activity.find((a) => a.kind === 'rx' && a.end === null)?.peer).toBe('4221526'));
    sim.speakEnd(2);
    await vi.waitFor(() => expect(state().activity.every((a) => a.end !== null)).toBe(true));

    // Sprechtaste gedrückt: eigenes Senden
    sim.speakStart(1, null, true);
    await vi.waitFor(() => expect(state().activity.some((a) => a.kind === 'tx')).toBe(true));
    expect(state().activity.find((a) => a.kind === 'tx')).toMatchObject({ deviceId: 'anschluss-1', end: null });
    expect(state().devices[0]).toMatchObject({ transmitting: true });
    sim.speakEnd(1, true);
    await vi.waitFor(() => expect(state().activity.find((a) => a.kind === 'tx')?.end).not.toBeNull());
  });

  it('sendet eine SDS über ein Funkgerät und prüft die Eingaben', async () => {
    sim = new ZbeSimulator({ auto: false, ports: [1, 2, 3] });
    const port = await sim.listen(0, '127.0.0.1');
    await connect(port);
    await vi.waitFor(() => expect(state().devices).toHaveLength(3));
    expect(state().capabilities.sdsSend).toBe(true);

    await adapter!.execute('sds.send', { deviceId: 'anschluss-3', issi: '4221526', text: 'Test "ELVIS"' });
    await vi.waitFor(() => expect(sim!.received).toContain('RADIO.ACTION.SM_SEND.2,"4221526","TEXT|Test  ELVIS "'));

    await expect(adapter!.execute('sds.send', { deviceId: 'anschluss-3', issi: '42x', text: 'a' })).rejects.toThrow(/ISSI/);
    await expect(adapter!.execute('sds.send', { deviceId: 'anschluss-3', issi: '4221526', text: ' ' })).rejects.toThrow(/Text/);
    await expect(adapter!.execute('sds.send', { deviceId: 'anschluss-9', issi: '4221526', text: 'a' })).rejects.toThrow(/Unbekannt/);
  });

  it('meldet eine gestörte Verbindung und verbindet sich neu', async () => {
    sim = new ZbeSimulator({ auto: false, ports: [1, 2] });
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

    sim = new ZbeSimulator({ auto: false, ports: [1, 2] });
    await sim.listen(port, '127.0.0.1');
    await vi.waitFor(() => expect(state().link?.connected).toBe(true), { timeout: 3000 });
  });
});
