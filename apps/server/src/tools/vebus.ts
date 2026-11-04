/**
 * Fernwartung: Victron MultiPlus/Quattro über ein MK3-USB am VE.Bus abfragen und schalten – ohne ELVIS,
 * z. B. per VPN vom Laptop auf den Router, an dem das MK3 steckt („Serial over IP“).
 *
 *   Entwicklung:  npm run vebus -w @elvis/server -- <Ziel> [Befehl]
 *   Container:    docker exec -it elvis node apps/server/dist/tools/vebus.js <Ziel> [Befehl]
 *
 *   Ziel     host:port (Router, TCP)  oder  /dev/ttyUSB0 (MK3 am Rechner)
 *   Befehl   status (Standard) | scan | on | off | charger-only | inverter-only | limit <Ampere>
 *            --once  Betriebsart nur einmal senden statt sie vom MK3 dauerhaft halten zu lassen
 *
 * Der Router lässt nur einen Client gleichzeitig zu: Läuft ELVIS mit dem Treiber „Victron VE.Bus“, hält es die
 * Verbindung – dann über die Weboberfläche schalten oder den Treiber kurz deaktivieren.
 */
import { INVERTER_MODE_LABELS, INVERTER_STATE_LABELS, inverterAlarms, type InverterMode, type InverterState } from '@elvis/shared';
import { VictronVebusAdapter, serialOpener, tcpOpener } from '../devices/drivers/victron-vebus/adapter.js';

const USAGE = 'Aufruf: vebus <host:port | /dev/ttyUSB0> [status | scan | on | off | charger-only | inverter-only | limit <A>] [--once]';
const MODES: Record<string, InverterMode> = { on: 'on', off: 'off', 'charger-only': 'charger-only', 'inverter-only': 'inverter-only' };

const args = process.argv.slice(2);
const once = args.includes('--once');
const [target, cmd = 'status', value] = args.filter((a) => a !== '--once');
if (!target || target === '-h' || target === '--help') {
  console.log(USAGE);
  process.exit(target ? 0 : 1);
}
if (!['status', 'scan', 'limit', ...Object.keys(MODES)].includes(cmd) || (cmd === 'limit' && !(Number(value) > 0))) {
  console.error(USAGE);
  process.exit(1);
}

const serial = target.startsWith('/') || /^COM\d+$/i.test(target);
const [host, port] = serial ? ['', 0] : [target.slice(0, target.lastIndexOf(':')) || target, Number(target.split(':').pop()) || 4001];
const adapter = new VictronVebusAdapter({
  driver: 'cli',
  target: serial ? target : `${host}:${port}`,
  open: serial ? serialOpener(target) : tcpOpener(host, port),
  pollMs: 1000,
  reconnectMs: 60_000,
  repeatPanelState: !once,
});

const quiet = { info: () => {}, warn: () => {}, error: (m: string) => console.error(m) };
const fmt = (v: number | null, unit: string, d = 1) => (v === null ? '–' : `${v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })} ${unit}`);

function print(s: InverterState): void {
  console.log(`MK3 ${s.link.interfaceVersion ?? '?'} an ${s.link.target}`);
  console.log(`Geräte am VE.Bus: ${s.devices.length ? s.devices.map((d) => `${d.address} (${d.role}, Firmware ${d.firmware ?? '?'})`).join(', ') : 'keine'}`);
  if (!s.devices.length) return;
  console.log(`Betriebsart:      ${s.mode ? INVERTER_MODE_LABELS[s.mode] : '–'}`);
  console.log(`Zustand:          ${s.opState ? INVERTER_STATE_LABELS[s.opState] : '–'}`);
  console.log(`Landstrom-Grenze: ${fmt(s.shoreLimitA, 'A')} (${fmt(s.shoreLimitMinA, 'A')} … ${fmt(s.shoreLimitMaxA, 'A')})`);
  for (const p of s.phases) {
    console.log(`${p.phase} Eingang:       ${fmt(p.acIn.v, 'V')}  ${fmt(p.acIn.a, 'A')}  ${fmt(p.acIn.hz, 'Hz')}`);
    console.log(`${p.phase} Ausgang:       ${fmt(p.acOut.v, 'V')}  ${fmt(p.acOut.a, 'A')}  ${fmt(s.acOutHz, 'Hz')}${s.outputW !== null ? `  ${fmt(s.outputW, 'W', 0)}` : ''}`);
  }
  console.log(`Batterie:         ${fmt(s.dc.v, 'V', 2)}  ${fmt(s.dc.a, 'A')}`);
  for (const a of inverterAlarms(s.leds)) console.log(`${a.severity === 'alarm' ? 'ALARM' : 'Warnung'}:          ${a.title}`);
  if (s.remotePanel) console.log('Hinweis:          Fernbedienung (DMC) am VE.Bus erkannt – ihr Schalter hat Vorrang.');
}

/** Warten, bis Scan und eine vollständige Abfrage durch sind */
async function ready(timeoutMs = 30_000): Promise<InverterState> {
  const until = Date.now() + timeoutMs;
  let polls = 0;
  let last = adapter.getState().link.lastFrameAt;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    const s = adapter.getState();
    if (s.link.lastFrameAt !== last && s.lastScanAt) {
      last = s.link.lastFrameAt;
      if (++polls >= 1 && (s.mode !== null || !s.devices.length)) return s;
    }
    if (!s.link.connected && s.link.error) throw new Error(s.link.error);
  }
  throw new Error(adapter.getState().link.error ?? 'Zeitüberschreitung');
}

try {
  await adapter.start({ log: quiet, getState: () => undefined });
  let s = await ready();
  if (cmd === 'limit') console.log(await adapter.execute('shore.limit', { amps: Number(value) }));
  else if (MODES[cmd]) console.log(await adapter.execute('mode.set', { mode: MODES[cmd] }));
  if (cmd !== 'status' && cmd !== 'scan') {
    await new Promise((r) => setTimeout(r, 2500));
    s = adapter.getState();
  }
  print(s);
  await adapter.stop();
  process.exit(0);
} catch (err) {
  console.error(`Fehler: ${(err as Error).message}`);
  await adapter.stop();
  process.exit(2);
}
