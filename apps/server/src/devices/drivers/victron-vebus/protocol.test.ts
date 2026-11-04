import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RAM_INFO,
  MkDecoder,
  RAM,
  infoRequest,
  ledRequest,
  parseAddress,
  parseInfo,
  parseLeds,
  parseMasterMultiLed,
  parseVersion,
  parseWinmon,
  periodToHz,
  ramScale,
  ramValue,
  setAddress,
  setState,
  winmon,
  type AcInfo,
  type DcInfo,
} from './protocol.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
/** Frame aus Victrons Mitschnitt (ohne Prüfsumme) vervollständigen */
const withChecksum = (s: string) => {
  const b = hex(s);
  let sum = 0;
  for (const x of b) sum += x;
  return Buffer.concat([b, Buffer.from([(256 - (sum & 0xff)) & 0xff])]);
};
const decode = (b: Buffer) => {
  const frames = new MkDecoder().push(b);
  expect(frames).toHaveLength(1);
  return frames[0]!;
};

describe('VE.Bus MK2-Protokoll', () => {
  it('baut Befehle wie in Anhang 1 des Victron-Dokuments', () => {
    expect(setAddress(0)).toEqual(hex('04 FF 41 01 00 BB'));
    expect(winmon(0x05)).toEqual(hex('05 FF 57 05 00 00 A0'));
    expect(winmon(0x06)).toEqual(hex('05 FF 57 06 00 00 9F'));
    expect(winmon(0x36, 4, 0)).toEqual(hex('05 FF 57 36 04 00 6B'));
    expect(winmon(0x30, 0x0d, 0)).toEqual(hex('05 FF 57 30 0D 00 68'));
    expect(infoRequest(0)).toEqual(hex('03 FF 46 00 B8'));
    expect(ledRequest()).toEqual(hex('02 FF 4C B3'));
    // Einschalten, Landstrom 31,5 A (Variante 2), einmalig
    expect(setState('on', 315, false)).toEqual(hex('07 FF 53 03 3B 01 01 80 E7'));
  });

  it('kodiert die Schalterstellung, das Wiederholen und „Begrenzung nicht vorgeben“', () => {
    const f = decode(setState('charger-only', null, true));
    expect([...f.data]).toEqual([0x53, 1, 0x00, 0x80, 0x01, 0x81]);
    expect(decode(setState('off', 160, false)).data[1]).toBe(4);
  });

  it('liest Version und Adresse aus den Antworten', () => {
    expect(parseVersion(decode(withChecksum('07 FF 56 93 3E 11 00 00')))).toEqual({ version: 1130131, address: 0, mode9bit: false });
    expect(parseVersion(decode(withChecksum('07 FF 56 93 3E 11 00 42')))?.address).toBeNull();
    expect(parseVersion(decode(withChecksum('07 FF 56 93 3E 11 00 57')))?.mode9bit).toBe(true);
    expect(parseAddress(decode(withChecksum('05 FF 41 01 00 00')))).toBe(0);
    expect(parseAddress(decode(withChecksum('04 FF 41 01 03')))).toBe(3);
  });

  it('wertet die RAM-Skalierung wie in Anhang 2 aus', () => {
    const [scale, offset] = parseWinmon(decode(withChecksum('08 FF 57 8E 9C 7F 8F 00 00')))!;
    expect(scale).toMatchObject({ code: 0x8e, value: 32668 });
    expect(offset).toMatchObject({ code: 0x8f, value: 0 });
    expect(ramScale({ sc: 32668, offset: 0 })).toBeCloseTo(0.01, 6);
    expect(ramScale({ sc: -32668, offset: 0 })).toBeCloseTo(0.01, 6);
    expect(ramScale({ sc: 30807, offset: 256 })).toBeCloseTo(0.00051, 5);
    expect(ramScale({ sc: 31791, offset: 0 })).toBeCloseTo(0.001024, 6);
    // Vorzeichen: Sc < 0 → Wert ist signed
    expect(ramValue(0xfff6, { sc: -32668, offset: 0 })).toBeCloseTo(-0.1, 6);
    expect(ramValue(0xfff6, { sc: 32668, offset: 0 })).toBeCloseTo(655.26, 2);
  });

  it('liest den DC-Info-Frame aus Anhang 2 (26,4 V, 0 A, 50 Hz)', () => {
    const info = parseInfo(decode(withChecksum('0F 20 7F 9A 81 79 0C 51 0A 00 00 00 00 00 00 88'))) as DcInfo;
    expect(info.kind).toBe('dc');
    expect(ramValue(info.voltage, DEFAULT_RAM_INFO[RAM.uBat]!)).toBeCloseTo(26.41, 2);
    expect(info.inverterCurrent).toBe(0);
    expect(info.chargerCurrent).toBe(0);
    expect(periodToHz(info.inverterPeriod, DEFAULT_RAM_INFO[RAM.inverterPeriod]!)).toBeCloseTo(50.0, 1);
  });

  it('liest den AC-Info-Frame aus Anhang 2 (213 V, 0,7 A, 50,1 Hz)', () => {
    const info = parseInfo(decode(withChecksum('0F 20 01 01 81 79 08 37 53 49 00 37 53 27 00 C3'))) as AcInfo;
    expect(info).toMatchObject({ kind: 'ac', phase: 1, phases: 1, bfFactor: 1, inverterFactor: 1 });
    expect(ramValue(info.mainsVoltage, DEFAULT_RAM_INFO[RAM.uMains]!)).toBeCloseTo(213.0, 1);
    expect(ramValue(info.mainsCurrent, DEFAULT_RAM_INFO[RAM.iMains]!)).toBeCloseTo(0.73, 2);
    expect(ramValue(info.inverterCurrent, DEFAULT_RAM_INFO[RAM.iInverter]!)).toBeCloseTo(0.39, 2);
    expect(periodToHz(info.mainsPeriod, DEFAULT_RAM_INFO[RAM.mainsPeriod]!)).toBeCloseTo(50.1, 1);
  });

  it('ordnet die Phasen-Info zu', () => {
    const ac = (phaseInfo: number) => parseInfo(decode(withChecksum(`0F 20 01 01 00 04 ${phaseInfo.toString(16).padStart(2, '0')} 00 00 00 00 00 00 00 00 00`))) as AcInfo;
    expect(ac(0x0a)).toMatchObject({ phase: 1, phases: 3 });
    expect(ac(0x07)).toMatchObject({ phase: 2, phases: null });
    expect(ac(0x06)).toMatchObject({ phase: 3 });
  });

  it('liest Landstrom-Grenzen aus dem MasterMultiLED-Frame (Anhang 2) und das Schalterregister', () => {
    const old = parseMasterMultiLed(decode(withChecksum('0C 41 10 09 00 00 00 3E 00 E8 03 F4 01')))!;
    expect(old).toMatchObject({ minLimit: 62, maxLimit: 1000, actualLimit: 500, remotePanel: false, mode: null });
    const withSwitch = parseMasterMultiLed(decode(withChecksum('0D 41 00 00 00 00 80 3E 00 E8 03 F4 01 10')))!;
    expect(withSwitch).toMatchObject({ remotePanel: true, mode: 'charger-only' });
    expect(parseMasterMultiLed(decode(withChecksum('0D 41 00 00 00 00 00 3E 00 E8 03 F4 01 30')))!.mode).toBe('on');
    expect(parseMasterMultiLed(decode(withChecksum('0D 41 00 00 00 00 00 3E 00 E8 03 F4 01 00')))!.mode).toBe('off');
  });

  it('liest die LEDs (an, blinkt, unbekannt)', () => {
    const leds = parseLeds(decode(withChecksum('04 FF 4C 05 20')))!;
    expect(leds).toMatchObject({ mains: 'on', bulk: 'on', absorption: 'off', overload: 'blink', inverter: 'off' });
    expect(parseLeds(decode(withChecksum('05 FF 4C 1F 1F 00')))).toBeNull();
  });

  it('findet Frames auch bruchstückweise, nach Datenmüll und mit falscher Prüfsumme', () => {
    const good = withChecksum('07 FF 56 93 3E 11 00 00');
    const bad = Buffer.from(good);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    const stream = Buffer.concat([hex('00 13 37'), bad, good, withChecksum('02 FF 53')]);
    const dec = new MkDecoder();
    const frames = [...stream].flatMap((b) => dec.push(Buffer.from([b])));
    expect(frames.map((f) => String.fromCharCode(f.data[0]!))).toEqual(['V', 'S']);
    expect(parseVersion(frames[0]!)?.version).toBe(1130131);
  });
});
