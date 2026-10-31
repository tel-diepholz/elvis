import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { LineSplitter, statusToCode } from './protocol.js';

export interface ZbeSimulatorOptions {
  /** FuG-Nummern, auf denen Ereignisse eintreffen */
  fugs?: number[];
  /** Zufällige Ereignisse erzeugen (für Vorführung); in Tests aus und per emit() gesteuert */
  auto?: boolean;
  /** Mittlerer Abstand der zufälligen Ereignisse */
  intervalMs?: number;
  /** Zugangsdaten; ohne Angabe wird jede Anmeldung angenommen */
  username?: string;
  password?: string;
}

const tsi = (issi: string) => `2621001${issi.padStart(8, '0')}`;
const PEERS = ['6122101', '6122102', '6122203', '6125001', '6125002', '6123411', '6123412'];
const TEXTS = ['Lage unverändert', 'Benötigen weitere Atemschutzgeräteträger', 'Wasserversorgung steht', 'Personal vollzählig', 'Bitte Rückruf Einsatzleiter'];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

/**
 * Nachbildung einer Reichert ZBE als TCP-Server – zum Entwickeln und Testen ohne Anlage.
 * Erzeugt Telegramme im selben Format, das ELVIS (und andere Clients) von der echten Anlage erwarten.
 */
export class ZbeSimulator {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private timer: NodeJS.Timeout | null = null;
  /** Von Clients empfangene Zeilen (für Tests) */
  readonly received: string[] = [];
  private readonly opts: Required<Omit<ZbeSimulatorOptions, 'username' | 'password'>> & Pick<ZbeSimulatorOptions, 'username' | 'password'>;

  constructor(opts: ZbeSimulatorOptions = {}) {
    this.opts = { fugs: [1, 2, 3], auto: true, intervalMs: 2500, ...opts };
  }

  async listen(port = 1234, host = '0.0.0.0'): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    if (this.opts.auto) this.schedule();
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const c of this.clients) c.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Zeile an alle angemeldeten Clients senden */
  emit(line: string): void {
    for (const c of this.clients) if ((c as Socket & { loggedIn?: boolean }).loggedIn) c.write(`${line}\r\n`);
  }

  sds(fug: number, from: string, text: string, flash = false): void {
    this.emit(`RADIO.EVENT.SM_RECEIVED.${fug} "${tsi(from)}" "" "${flash ? 'FLASH' : 'TEXT'}|${text}" "${new Date().toISOString()}"`);
  }

  status(fug: number, from: string, status: number): void {
    this.emit(`RADIO.EVENT.SM_RECEIVED.${fug} "${tsi(from)}" "" "STATUS|${statusToCode(status)}" "${new Date().toISOString()}"`);
  }

  gps(fug: number, from: string, lat: number, lon: number): void {
    this.emit(`RADIO.EVENT.GPS_DATA.${fug} "${tsi(from)}" 1 ${lat.toFixed(6)} ${lon.toFixed(6)} 0`);
  }

  private accept(socket: Socket): void {
    const s = socket as Socket & { loggedIn?: boolean };
    this.clients.add(s);
    socket.setEncoding('utf8');
    const lines = new LineSplitter();
    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        this.received.push(line);
        const login = /^login (\S+) (\S+)$/.exec(line);
        if (login) {
          const ok = (!this.opts.username || login[1] === this.opts.username) && (!this.opts.password || login[2] === this.opts.password);
          if (!ok) {
            socket.end('main.event.login_failed\r\n');
            return;
          }
          s.loggedIn = true;
          socket.write('main.event.login_ok\r\n');
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.clients.delete(s));
  }

  private schedule(): void {
    const delay = this.opts.intervalMs * (0.3 + Math.random() * 1.4);
    this.timer = setTimeout(() => {
      this.randomEvent();
      this.schedule();
    }, delay);
  }

  private randomEvent(): void {
    const fug = pick(this.opts.fugs);
    const r = Math.random();
    if (r < 0.45) this.status(fug, pick(PEERS), pick([1, 2, 3, 4, 6, 7, 8]));
    else if (r < 0.75) this.sds(fug, pick(PEERS), pick(TEXTS), Math.random() < 0.1);
    else this.gps(fug, pick(PEERS), 52.6 + Math.random() * 0.1, 8.3 + Math.random() * 0.2);
  }
}
