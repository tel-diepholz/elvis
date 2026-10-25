import { describe, expect, it } from 'vitest';
import { VictronKeyError, victronEncode, victronPacket, victronParse, victronRead } from './victron.js';

// Pakete und Schlüssel aus den Tests von github.com/keshavdv/victron-ble
const hex = (s: string) => Buffer.from(s, 'hex');

describe('Victron Instant Readout', () => {
  it('liest einen Batteriemonitor (SmartShunt)', () => {
    expect(victronPacket(hex('100289a302b040af925d09a4d89aa0128bdef48c6298a9'))).toMatchObject({ productId: 0xa389, readoutType: 2 });
    expect(victronRead(hex('100289a302b040af925d09a4d89aa0128bdef48c6298a9'), 'aff4d0995b7d1e176c0c33ecb9e70dcd')).toEqual({
      type: 'battery-monitor',
      remainingMin: null,
      voltageV: 12.53,
      currentA: 0,
      consumedAh: -50,
      socPct: 50,
      temperatureC: null,
      starterVoltageV: null,
      midpointVoltageV: null,
      alarms: [],
    });
  });

  it('liest den Hilfseingang des Batteriemonitors', () => {
    expect(victronParse(2, hex('ffffe6040000feff000000000080feac'))).toMatchObject({ starterVoltageV: -0.02, temperatureC: null });
    // 0xFFFF im Hilfseingang heißt „kein Temperaturfühler“
    expect(victronParse(2, hex('ffffe6040000ffff020000000080fede'))).toMatchObject({ temperatureC: null, starterVoltageV: null });
    expect(victronParse(2, hex('ffffe60400008372020000000080fede'))).toMatchObject({ temperatureC: 20 });
  });

  it('liest eine Lithium-Batterie (Lithium Battery Smart)', () => {
    expect(victronParse(5, hex('000000060000c7e3f1f8ffffff2c35b5fab478010fd249d2ae5f6956e1f8a965'))).toEqual({
      type: 'lithium',
      bmsFlags: 100663296,
      errorFlags: 0,
      cells: [3.31, 3.31, 3.31, 3.31],
      voltageV: 13.24,
      balancer: 'imbalance',
      temperatureC: 13,
    });
    expect(victronParse(5, hex('000000060000c7e3f1f8ffffff2c15b6849aea20977d8ca2b6f932de828a88f9'))).toMatchObject({ balancer: 'balanced', temperatureC: 14 });
  });

  it('liest Solarladeregler, DC/DC-Lader und Ladegerät', () => {
    expect(victronRead(hex('100242a0016207adceb37b605d7e0ee21b24df5c'), 'adeccb947395801a4dd45a2eaa44bf17')).toEqual({
      type: 'solar',
      state: 4,
      error: 0,
      voltageV: 13.88,
      currentA: 1.4,
      yieldTodayWh: 30,
      pvPowerW: 19,
      loadCurrentA: 0,
    });
    expect(victronRead(hex('1000c0a304121d64ca8d442b90bbdf6a8cba'), '64ba49f1a8562e45197a8e1fe50d7658')).toEqual({
      type: 'dcdc',
      state: 0,
      error: 0,
      inputVoltageV: 13.15,
      outputVoltageV: null,
      offReason: 0x80,
    });
    expect(victronRead(hex('100030a308f926c1b5170a0d2280335bf12d5ed083'), 'c129cf8f75c3fe5a1655b481e205fb7d')).toEqual({
      type: 'ac-charger',
      state: 6,
      error: 0,
      outputs: [{ voltageV: 13.49, currentA: 0.4 }],
      temperatureC: 21,
      acCurrentA: null,
    });
  });

  it('erkennt einen falschen Schlüssel und fremde Pakete', () => {
    expect(() => victronRead(hex('100289a302b040af925d09a4d89aa0128bdef48c6298a9'), '00f4d0995b7d1e176c0c33ecb9e70dcd')).toThrow(VictronKeyError);
    expect(victronRead(hex('0102030405060708090a'), 'aff4d0995b7d1e176c0c33ecb9e70dcd')).toBeNull();
    expect(victronParse(0x0c, Buffer.alloc(16))).toEqual({ type: 'unsupported', readoutType: 0x0c });
  });

  it('verpackt Messwerte so, dass sie sich wieder lesen lassen', () => {
    const key = '0123456789abcdef0123456789abcdef';
    const lithium = { type: 'lithium' as const, bmsFlags: 0, errorFlags: 0, cells: [3.3, 3.31, 'high' as const, 3.29], voltageV: 13.21, balancer: 'balancing' as const, temperatureC: -5 };
    expect(victronRead(victronEncode(lithium, key, { iv: 0x1234 }), key)).toEqual(lithium);
    const shunt = { type: 'battery-monitor' as const, remainingMin: 600, voltageV: 12.9, currentA: -4.25, consumedAh: -12.3, socPct: 87.5, temperatureC: null, starterVoltageV: null, midpointVoltageV: null, alarms: [] };
    expect(victronRead(victronEncode(shunt, key, { iv: 65535 }), key)).toEqual(shunt);
  });
});
