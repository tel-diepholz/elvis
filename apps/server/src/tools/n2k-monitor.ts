/**
 * Diagnose: NMEA-2000-Nachrichten eines Actisense-Gateways (NGT-1/NGX-1) live anzeigen.
 *
 *   Entwicklung:  npm run n2k:monitor -w @elvis/server -- /dev/ttyUSB0 [115200]
 *   Container:    docker exec -it elvis node apps/server/dist/tools/n2k-monitor.js /dev/ttyUSB0
 */
import { ActisenseDecoder, SET_RX_ALL_FRAME } from '../devices/n2k/actisense.js';
import { SUPPORTED_PGNS, decodePgn } from '../devices/n2k/pgns.js';
import { openSerialPort } from '../devices/drivers/airmar.js';

const [path = '/dev/ttyUSB0', baud = '115200'] = process.argv.slice(2);
const counts = new Map<string, number>();
let total = 0;

const decoder = new ActisenseDecoder((m) => {
  total++;
  const key = `${m.pgn}@${m.source}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if ((SUPPORTED_PGNS as readonly number[]).includes(m.pgn)) {
    const v = decodePgn(m.pgn, m.data);
    console.log(`${new Date().toISOString().slice(11, 23)}  PGN ${m.pgn}  Quelle ${m.source}  ${JSON.stringify(v)}`);
  }
});

const link = await openSerialPort(path, Number(baud)).catch((e: Error) => {
  console.error(`Schnittstelle ${path} nicht verfügbar: ${e.message}`);
  console.error('Tipp: ls -l /dev/serial/by-id/  zeigt angeschlossene USB-Seriell-Adapter (Actisense meldet sich als FTDI-Gerät).');
  process.exit(1);
});
link.on('data', (chunk) => decoder.push(chunk));
link.on('error', (e) => {
  console.error(`Fehler: ${e?.message}`);
  process.exit(1);
});
link.write(SET_RX_ALL_FRAME);
console.log(`Lausche auf ${path} (${baud} Baud) – Strg+C beendet. Ausgewertete PGNs werden dekodiert angezeigt.`);

setInterval(() => {
  const list = [...counts.entries()].sort().map(([k, n]) => `${k}×${n}`).join('  ');
  console.log(`--- ${total} Nachrichten in 10 s, verworfen: ${decoder.rejected}  |  PGN@Quelle: ${list || '(keine)'}`);
  counts.clear();
  total = 0;
}, 10_000);
