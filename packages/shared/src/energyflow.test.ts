import { describe, expect, it } from 'vitest';
import type { BluetoothDeviceLive, VictronReadout } from './bluetooth';
import { defaultEnergyFlow, energyReadings, type EnergyData, type EnergyFlowConfig } from './energyflow';
import type { InverterState } from './inverter';

const bt = (id: string, readout: VictronReadout): BluetoothDeviceLive => ({
  id,
  name: id,
  kind: 'victron',
  address: '',
  warnBelowV: null,
  seenAt: '2026-11-01T00:00:00Z',
  stale: false,
  rssi: null,
  advertisedName: null,
  readout,
  error: null,
});

const shunt = bt('shunt', { type: 'battery-monitor', voltageV: 26, currentA: 10, socPct: 88, consumedAh: null, remainingMin: null, temperatureC: null, starterVoltageV: null, midpointVoltageV: null, alarms: [] });
const solar = bt('mppt', { type: 'solar', state: 3, error: 0, voltageV: 26, currentA: 5, yieldTodayWh: 0, pvPowerW: 130, loadCurrentA: null });
const orion = bt('orion', { type: 'dcdc', state: 3, error: 0, inputVoltageV: 13.9, outputVoltageV: 27.1, offReason: 0 });

const inverter = {
  link: { connected: true, target: '', error: null, lastFrameAt: null, interfaceVersion: null },
  devices: [],
  scanning: false,
  lastScanAt: null,
  mode: 'on',
  opState: 'bulk',
  shoreLimitA: 16,
  shoreLimitMinA: null,
  shoreLimitMaxA: null,
  remotePanel: false,
  phases: [{ phase: 'L1', acIn: { v: 230, a: 4, hz: 50 }, acOut: { v: 230, a: 1 } }],
  acOutHz: 50,
  outputW: 220,
  dc: { v: 26.5, a: 20 },
  leds: null,
} satisfies InverterState;

const data: EnergyData = { inverter, inverterOnline: true, bluetooth: [shunt, solar, orion] };

describe('Energiefluss', () => {
  it('belegt automatisch: Wechselrichter, Shunt als Batterie, Solar oben, Orion als Lichtmaschine, Bilanz', () => {
    const c = defaultEnergyFlow({ inverter: true, bluetooth: data.bluetooth });
    expect(c.nodes.map((n) => [n.slot, n.kind, n.source.type === 'bluetooth' ? n.source.deviceId : n.source.type])).toEqual([
      ['left-1', 'shore', 'inverter'],
      ['right-1', 'ac-loads', 'inverter'],
      ['bottom', 'battery', 'shunt'],
      ['top', 'solar', 'mppt'],
      ['left-2', 'alternator', 'orion'],
      ['right-2', 'dc-loads', 'balance'],
    ]);
  });

  it('ohne Shunt: Batterie vom Wechselrichter, keine Bilanz', () => {
    const c = defaultEnergyFlow({ inverter: true, bluetooth: [] });
    expect(c.nodes.map((n) => n.kind)).toEqual(['shore', 'ac-loads', 'battery']);
  });

  it('rechnet Werte, ergänzt aus der Zusatzquelle und zieht die Bilanz', () => {
    const config: EnergyFlowConfig = {
      hubLabel: '',
      nodes: [
        { slot: 'left-1', kind: 'shore', label: '', source: { type: 'inverter', channel: 'ac-in' }, extra: null },
        { slot: 'top', kind: 'solar', label: '', source: { type: 'bluetooth', deviceId: 'mppt' }, extra: null },
        { slot: 'right-1', kind: 'ac-loads', label: '', source: { type: 'inverter', channel: 'ac-out' }, extra: null },
        { slot: 'bottom', kind: 'battery', label: '', source: { type: 'inverter', channel: 'dc' }, extra: { type: 'bluetooth', deviceId: 'shunt' } },
        { slot: 'right-2', kind: 'dc-loads', label: '', source: { type: 'balance' }, extra: null },
      ],
    };
    const r = energyReadings(config, data);
    expect(r.get('left-1')).toMatchObject({ w: 920, v: 230, a: 4, status: 'Laden (Konstantstrom)' });
    expect(r.get('top')).toMatchObject({ w: 130, status: 'Konstantstrom (Bulk)' });
    expect(r.get('right-1')?.w).toBe(220);
    // Strom vom Wechselrichter, Ladezustand vom Shunt
    expect(r.get('bottom')).toMatchObject({ v: 26.5, a: 20, w: 530, socPct: 88 });
    // 920 + 130 − 220 − 530 = 300 W bleiben für die DC-Verbraucher
    expect(r.get('right-2')).toMatchObject({ w: 300, status: 'berechnet' });
  });

  it('meldet fehlende und veraltete Quellen', () => {
    const config: EnergyFlowConfig = {
      hubLabel: '',
      nodes: [
        { slot: 'top', kind: 'solar', label: '', source: { type: 'bluetooth', deviceId: 'weg' }, extra: null },
        { slot: 'left-1', kind: 'shore', label: '', source: { type: 'inverter', channel: 'ac-in' }, extra: null },
      ],
    };
    const r = energyReadings(config, { inverter, inverterOnline: false, bluetooth: [] });
    expect(r.get('top')?.missing).toBe(true);
    expect(r.get('left-1')).toMatchObject({ missing: false, stale: true });
    expect(energyReadings(config, { inverter: null, inverterOnline: false, bluetooth: [] }).get('left-1')?.missing).toBe(true);
  });
});
