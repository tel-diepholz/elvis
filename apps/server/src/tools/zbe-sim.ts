/**
 * Simulierte Reichert ZBE als TCP-Server, um den Treiber „Reichert ZBE“ ohne Anlage zu testen.
 *
 *   Entwicklung:  npm run zbe:sim -w @elvis/server -- [Port] [FuG-Nummern]     z. B. 1234 1,2,3
 *   Container:    docker exec -it elvis node apps/server/dist/tools/zbe-sim.js 1234 1,2,3
 *
 * In ELVIS dann unter Einstellungen → Fahrzeugmodule → Funk den Treiber „Reichert ZBE“ mit Adresse 127.0.0.1 wählen.
 */
import { ZbeSimulator } from '../devices/drivers/reichert/simulator.js';

const [portArg = '1234', fugArg = '1,2,3'] = process.argv.slice(2);
const fugs = fugArg
  .split(',')
  .map(Number)
  .filter((n) => Number.isInteger(n) && n >= 0);
const sim = new ZbeSimulator({ fugs, auto: true });
const port = await sim.listen(Number(portArg));
console.log(`ZBE-Simulator lauscht auf Port ${port}, Ereignisse auf FuG ${fugs.join(', ')} (Strg+C beendet)`);
setInterval(() => process.stdout.write(`\r${sim.clientCount} Client(s), ${sim.received.length} Zeilen empfangen   `), 2000);
process.on('SIGINT', () => void sim.close().then(() => process.exit(0)));
