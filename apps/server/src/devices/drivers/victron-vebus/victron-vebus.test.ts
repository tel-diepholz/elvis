import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateAlerts } from '../../../alerts.js';
import { CMD } from './protocol.js';
import { VictronVebusAdapter, tcpOpener } from './adapter.js';
import { VebusSimulator, type EmulatorOptions } from './emulator.js';

const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, getState: () => undefined };

let sim: VebusSimulator | null = null;
let adapter: VictronVebusAdapter | null = null;

async function setup(opts: EmulatorOptions = {}, repeatPanelState = true) {
  sim = new VebusSimulator({ latencyMs: 2, ...opts });
  const port = await sim.listen(0);
  adapter = new VictronVebusAdapter({
    driver: 'victron-vebus',
    target: `127.0.0.1:${port}`,
    open: tcpOpener('127.0.0.1', port),
    pollMs: 100,
    reconnectMs: 100,
    repeatPanelState,
    timeoutMs: 400,
  });
  await adapter.start(ctx);
  return { sim, adapter };
}

const ready = async (a: VictronVebusAdapter) =>
  vi.waitFor(
    () => {
      const s = a.getState();
      expect(s.link.connected).toBe(true);
      expect(s.devices.length).toBeGreaterThan(0);
      expect(s.dc.v).not.toBeNull();
      expect(s.mode).not.toBeNull();
    },
    { timeout: 5000 },
  );

afterEach(async () => {
  await adapter?.stop();
  await sim?.close();
  adapter = sim = null;
});

describe('Treiber VE.Bus gegen Simulator', () => {
  it('erkennt das MK3, scannt den Bus und liest Messwerte', async () => {
    const { adapter: a } = await setup({ shore: true });
    await ready(a);
    const s = a.getState();
    expect(a.isOnline()).toBe(true);
    expect(s.link.interfaceVersion).toBe('1170212');
    expect(s.devices).toEqual([{ address: 0, role: 'master', firmware: '2623497' }]);
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0]!.acIn.v).toBeGreaterThan(220);
    expect(s.phases[0]!.acIn.hz).toBeCloseTo(50, 0);
    expect(s.acOutHz).toBeCloseTo(50, 0);
    expect(s.dc.v).toBeGreaterThan(20);
    expect(s.mode).toBe('on');
    expect(s.shoreLimitA).toBe(16);
    expect(s.shoreLimitMinA).toBe(3);
    expect(s.shoreLimitMaxA).toBe(50);
    expect(s.remotePanel).toBe(false);
    expect(s.outputW).toBeGreaterThan(0);
    expect(s.leds?.mains).toBe('on');
    expect(s.opState).toBe('bulk');
  }, 10_000);

  it('findet Master und Slave', async () => {
    const { adapter: a } = await setup({ units: 2 });
    await ready(a);
    expect(a.getState().devices.map((d) => [d.address, d.role])).toEqual([
      [0, 'master'],
      [1, 'slave'],
    ]);
    // Bei mehreren Geräten keine Einzelleistung
    expect(a.getState().outputW).toBeNull();
  }, 10_000);

  it('schaltet den Wechselrichter aus und wieder ein', async () => {
    const { adapter: a, sim: s } = await setup({ shore: false });
    await ready(a);
    expect(a.getState().opState).toBe('invert');
    expect(await a.execute('mode.set', { mode: 'off' })).toBe('Wechselrichter: Aus');
    expect(s.emulator.mode).toBe('off');
    await vi.waitFor(() => expect(a.getState().opState).toBe('off'), { timeout: 3000 });
    await a.execute('mode.set', { mode: 'on' });
    expect(s.emulator.mode).toBe('on');
    await vi.waitFor(() => expect(a.getState().opState).toBe('invert'), { timeout: 3000 });
    expect(s.emulator.received).toContain(CMD.state);
  }, 10_000);

  it('setzt die Landstrom-Begrenzung und prüft den Bereich', async () => {
    const { adapter: a, sim: s } = await setup();
    await ready(a);
    await a.execute('shore.limit', { amps: 10.5 });
    expect(s.emulator.limitDeci).toBe(105);
    expect(s.emulator.mode).toBe('on');
    await expect(a.execute('shore.limit', { amps: 60 })).rejects.toThrow('Höchstens 50 A');
    await expect(a.execute('shore.limit', { amps: 1 })).rejects.toThrow('Mindestens 3 A');
  }, 10_000);

  it('meldet eine Fernbedienung am Bus', async () => {
    const { adapter: a } = await setup({ remotePanel: true });
    await ready(a);
    expect(a.getState().remotePanel).toBe(true);
    expect(await a.execute('mode.set', { mode: 'off' })).toContain('Fernbedienung');
  }, 10_000);

  it('meldet LED-Alarme, die Fernbedienung und den Ausfall des Routers', async () => {
    const { adapter: a, sim: s } = await setup({ shore: false, remotePanel: true });
    await ready(a);
    s.emulator.batteryV = 23.6;
    s.emulator.loadW = 2100;
    await vi.waitFor(() => expect(a.getState().leds?.lowBattery).toBe('blink'), { timeout: 3000 });
    const alerts = (offline: 'inverter'[]) => evaluateAlerts((id) => (id === 'inverter' ? a.getState() : undefined) as never, offline, { stormWarnMs: 17 });
    expect(alerts([]).map((x) => [x.id, x.severity, x.title])).toEqual(
      expect.arrayContaining([
        ['inverter:lowBattery', 'warn', 'Wechselrichter: Batteriespannung niedrig (Vorwarnung)'],
        ['inverter:panel', 'info', 'Wechselrichter: Fernbedienung am VE.Bus'],
      ]),
    );
    expect(alerts(['inverter']).map((x) => x.id)).toEqual(['offline:inverter']);
  }, 10_000);

  it('scannt auf Befehl neu', async () => {
    const { adapter: a } = await setup();
    await ready(a);
    expect(await a.execute('bus.scan', {})).toBe('1 Gerät am VE.Bus gefunden');
  }, 10_000);

  it('verbindet sich nach Abbruch neu', async () => {
    const { adapter: a, sim: s } = await setup();
    await ready(a);
    s.dropClients();
    await vi.waitFor(() => expect(a.getState().link.connected).toBe(false), { timeout: 2000 });
    await expect(a.execute('mode.set', { mode: 'off' })).rejects.toThrow('Keine Verbindung');
    await ready(a);
    expect(a.isOnline()).toBe(true);
  }, 10_000);

  it('meldet einen nicht erreichbaren Router', async () => {
    const a = new VictronVebusAdapter({ driver: 'victron-vebus', target: '127.0.0.1:1', open: tcpOpener('127.0.0.1', 1), pollMs: 100, reconnectMs: 60_000, repeatPanelState: true });
    adapter = a;
    await a.start(ctx);
    await vi.waitFor(() => expect(a.getState().link.error).toMatch(/fehlgeschlagen/), { timeout: 3000 });
    expect(a.isOnline()).toBe(false);
  });
});
