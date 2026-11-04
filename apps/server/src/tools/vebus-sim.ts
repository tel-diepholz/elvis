/**
 * Simuliertes MK3 mit MultiPlus als TCP-Server – wie ein Router mit „Serial over IP“. Zum Testen des Treibers
 * „Victron VE.Bus“ und des Werkzeugs „vebus“ ohne Gerät.
 *
 *   Entwicklung:  npm run vebus:sim -w @elvis/server -- [Port] [Geräte] [--dmc]     z. B. 4001 2
 *   Container:    docker exec -it elvis node apps/server/dist/tools/vebus-sim.js 4001
 *
 * In ELVIS dann unter Einstellungen → Fahrzeugmodule → Wechselrichter den Treiber „Victron VE.Bus über MK3-USB“
 * mit Adresse 127.0.0.1 und diesem Port wählen.
 */
import { VebusSimulator } from '../devices/drivers/victron-vebus/emulator.js';

const args = process.argv.slice(2);
const [portArg = '4001', unitsArg = '1'] = args.filter((a) => !a.startsWith('--'));
const sim = new VebusSimulator({ units: Number(unitsArg) || 1, remotePanel: args.includes('--dmc'), shoreCycle: [300, 180] });
const port = await sim.listen(Number(portArg), '0.0.0.0');
console.log(`VE.Bus-Simulator lauscht auf Port ${port} (${unitsArg} Gerät(e)${args.includes('--dmc') ? ', mit DMC' : ''}; Landstrom 5 min an, 3 min aus; Strg+C beendet)`);
setInterval(() => {
  const e = sim.emulator;
  process.stdout.write(`\r${e.mode.padEnd(13)} Landstrom ${e.shore ? 'ja ' : 'nein'}  Grenze ${(e.limitDeci / 10).toFixed(1)} A  Batterie ${e.batteryV.toFixed(2)} V ${e.batteryA.toFixed(1)} A   `);
}, 1000);
process.on('SIGINT', () => void sim.close().then(() => process.exit(0)));
