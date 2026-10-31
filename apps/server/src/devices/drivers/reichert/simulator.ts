import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { DEFAULT_PORT, LineSplitter, PING, statusToCode, type ZbeStyle } from './protocol.js';

export interface ZbeSimulatorOptions {
  /** Anschlüsse (1–20), auf denen Ereignisse eintreffen */
  ports?: number[];
  /** Zufällige Ereignisse erzeugen (für Vorführung); in Tests aus und per Methoden gesteuert */
  auto?: boolean;
  /** Mittlerer Abstand der zufälligen Ereignisse */
  intervalMs?: number;
  /** Zugangsdaten; ohne Angabe wird jede Anmeldung angenommen */
  username?: string;
  password?: string;
  /** Schreibweise der Ereignisse */
  style?: ZbeStyle;
}

const tsi = (issi: string) => `2621001${issi.padStart(8, '0')}`;
const PEERS = ['6122101', '6122102', '6122203', '6125001', '6125002', '6123411', '6123412'];
const TALKGROUPS = ['1001', '1002', '2307'];
const TEXTS = ['Lage unverändert', 'Benötigen weitere Atemschutzgeräteträger', 'Wasserversorgung steht', 'Personal vollzählig', 'Bitte Rückruf Einsatzleiter'];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

/**
 * Nachbildung einer Reichert ZBE als TCP-Server – zum Entwickeln und Testen ohne Anlage.
 * Erzeugt Telegramme im selben Format, das ELVIS (und andere Clients) von der echten Anlage erwarten.
 * Anschlüsse heißen wie an der ZBE (1–20); im Telegramm stehen sie ab 0 gezählt.
 */
export class ZbeSimulator {
  private server: Server | null = null;
  private readonly clients = new Set<Socket & { loggedIn?: boolean }>();
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private ref = 0;
  /** Von Clients empfangene Zeilen (für Tests) */
  readonly received: string[] = [];
  private readonly opts: Required<Omit<ZbeSimulatorOptions, 'username' | 'password'>> & Pick<ZbeSimulatorOptions, 'username' | 'password'>;

  constructor(opts: ZbeSimulatorOptions = {}) {
    this.opts = { ports: [1, 2, 3], auto: true, intervalMs: 2500, style: 'comma', ...opts };
  }

  async listen(port = DEFAULT_PORT, host = '0.0.0.0'): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    if (this.opts.auto) {
      this.schedule();
      // Lebenszeichen der Anlage – ein Client muss sie ignorieren
      this.watchdog = setInterval(() => this.emit('main.event.WATCHDOG.-1,1'), 15_000);
    }
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = this.watchdog = null;
    for (const c of this.clients) c.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Zeile an alle angemeldeten Clients senden */
  emit(line: string): void {
    for (const c of this.clients) if (c.loggedIn) c.write(`${line}\r\n`);
  }

  /** Ereigniszeile in der gewählten Schreibweise; Anschluss ab 1 → Suffix ab 0 */
  private event(name: string, port: number, fields: string[]): void {
    const sep = this.opts.style === 'comma' ? ',' : ' ';
    this.emit(`RADIO.EVENT.${name}.${port - 1}${sep}${fields.join(sep)}`);
  }

  sds(port: number, from: string, text: string, flash = false): void {
    this.event('SM_RECEIVED', port, [String(++this.ref), `"${tsi(from)}"`, '""', `"${flash ? 'FLASH' : 'TEXT'}|${text}"`]);
  }

  status(port: number, from: string, status: number): void {
    this.event('SM_RECEIVED', port, [String(++this.ref), `"${tsi(from)}"`, '""', `"STATUS|${statusToCode(status)}"`]);
  }

  gps(port: number, from: string, lat: number, lon: number): void {
    this.event('GPS_DATA', port, [`"${tsi(from)}"`, '1', lat.toFixed(6), lon.toFixed(6)]);
  }

  /** Funkspruch: Aufzeichnungsinfo mit Sprecher, dann „es spricht“ */
  speak(port: number, from: string | null, talkgroup = '1001'): void {
    if (from) this.event('DOKU_REC_INFO', port, [String(++this.ref), '1', `"${tsi(talkgroup)}-${tsi(from)}"`]);
    this.event('SPEAK', port, []);
  }

  private accept(socket: Socket): void {
    const s = socket as Socket & { loggedIn?: boolean };
    this.clients.add(s);
    socket.setEncoding('utf8');
    const lines = new LineSplitter();
    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        this.received.push(line);
        if (line === PING) continue;
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
    const port = pick(this.opts.ports);
    const r = Math.random();
    if (r < 0.45) this.speak(port, Math.random() < 0.9 ? pick(PEERS) : null, pick(TALKGROUPS));
    else if (r < 0.7) this.status(port, pick(PEERS), pick([1, 2, 3, 4, 6, 7, 8]));
    else if (r < 0.88) this.sds(port, pick(PEERS), pick(TEXTS), Math.random() < 0.1);
    else this.gps(port, pick(PEERS), 52.6 + Math.random() * 0.1, 8.3 + Math.random() * 0.2);
  }
}
