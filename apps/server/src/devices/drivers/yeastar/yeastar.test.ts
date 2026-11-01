import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { TelephonyState } from '@elvis/shared';
import { evaluateAlerts } from '../../../alerts.js';
import { TelephonyBus, type EndedCall, type IncomingSms } from '../../telephony/bus.js';
import { YeastarTgAdapter, parseTrunks } from './adapter.js';
import { AmiParser, action, channelSpan, parseReceivedSms, parseSpanDetail, parseSpans, sendSmsCommand, trunkStatus } from './protocol.js';

/** Antworten eines TG200 (Firmware 2024), mitgeschnitten am Gerät */
const SPANS = 'Response: Follows\r\nPrivilege: SMSCommand\r\nGSM span 2: Power on, Up, Active, Standard\r\nGSM span 3: Power on, Up, Active, Standard\r\n--END COMMAND--\r\n\r\n';
const SPAN_2 =
  'Response: Follows\r\nPrivilege: SMSCommand\r\nD-channel: 2\r\nStatus: Power on, Up, Active, Standard\r\nType: CPE\r\nManufacturer: Quectel\r\nModel Name: EC21\r\n' +
  'Model IMEI: 864450048982757\r\nRevision: EC21EUXGAR08A07M1G_20.200.20.200\r\nNetwork Name: Telekom.de Telekom.de\r\nNetwork Status: Registered (Home network)\r\n' +
  'Signal Quality (0,31): 31\r\nBER value (0,7): 7\r\nSIM IMSI: 262010051945883\r\nSIM SMS Center Number: +491710760000\r\nPDD: 0\r\nASR: 0\r\nACD: 0\r\n' +
  'Last event: D-Channel Up\r\nState: READY\r\nLast send AT: AT+CSQ\\r\\n--END COMMAND--\r\n\r\n';
const SPAN_3 = SPAN_2.replace('Signal Quality (0,31): 31', 'Signal Quality (0,31): 18').replace('D-channel: 2', 'D-channel: 4');

describe('Yeastar TG: Protokoll', () => {
  it('zerlegt Antworten, auch „Follows“ mit angeklebter Endmarke und Ereignisse', () => {
    const p = new AmiParser();
    const msgs = p.push(`Asterisk Call Manager/1.1\r\nResponse: Success\r\nMessage: Authentication accepted\r\n\r\n${SPANS}${SPAN_2.slice(0, 50)}`);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.fields).toEqual({ response: 'Success', message: 'Authentication accepted' });
    expect(parseSpans(msgs[1]!.output)).toEqual([
      { span: 2, statusText: 'Power on, Up, Active, Standard' },
      { span: 3, statusText: 'Power on, Up, Active, Standard' },
    ]);
    const rest = p.push(`${SPAN_2.slice(50)}Event: ReceivedSMS\r\nGsmSpan: 2\r\nSender: +491701234567\r\nContent: Hallo%20Welt%21\r\n\r\n`);
    expect(rest).toHaveLength(2);
    expect(rest[0]!.output.at(-1)).toBe('Last send AT: AT+CSQ');
    expect(rest[1]!.fields.event).toBe('ReceivedSMS');
  });

  it('liest den Zustand eines Ports', () => {
    const msg = new AmiParser().push(SPAN_2)[0]!;
    expect(parseSpanDetail(msg.output)).toEqual({
      statusText: 'Power on, Up, Active, Standard',
      model: 'Quectel EC21',
      imei: '864450048982757',
      operator: 'Telekom.de',
      registration: 'Registered (Home network)',
      csq: 31,
      ber: 7,
      smsc: '+491710760000',
      state: 'READY',
    });
  });

  it('bewertet den Trunk', () => {
    expect(trunkStatus('Power on, Up, Active, Standard', 'Registered (Home network)')).toBe('up');
    expect(trunkStatus('Power on, Up, Active, Standard', 'Registered (Roaming)')).toBe('up');
    expect(trunkStatus('Power on, Up, Active, Standard', 'Searching')).toBe('searching');
    expect(trunkStatus('Power on, Down', null)).toBe('down');
    expect(trunkStatus('Power on, Undetected SIM Card', null)).toBe('no-sim');
    expect(trunkStatus(null, null)).toBe('unknown');
  });

  it('baut Aktionen und den Sendebefehl', () => {
    expect(action('SMSCommand', { Command: 'gsm show spans' })).toBe('Action: SMSCommand\r\nCommand: gsm show spans\r\n\r\n');
    expect(sendSmsCommand(2, '+49 171 123', 'Sag "Hallo"\nZeile 2', 'x1')).toBe('gsm send sms 2 +49171123 "Sag \\"Hallo\\"\\nZeile 2" x1');
  });

  it('dekodiert empfangene SMS und erkennt GSM-Kanäle', () => {
    expect(parseReceivedSms({ id: '1', gsmspan: '3', sender: '+491701234567', index: '1', total: '1', content: 'Gr%C3%BC%C3%9Fe+aus+Diepholz' })).toEqual({
      id: '1',
      span: 3,
      sender: '+491701234567',
      index: 1,
      total: 1,
      text: 'Grüße aus Diepholz',
    });
    // Latin-1 (z. B. von Werbe-Absendern) und Byte-Order-Mark
    expect(parseReceivedSms({ gsmspan: '2', sender: '+49151', content: '%0AROUTER%0ASorgen+Sie+f%FCr+zuverl%E4ssige%2C+sichere' })!.text).toBe('\nROUTER\nSorgen Sie für zuverlässige, sichere');
    expect(parseReceivedSms({ gsmspan: '2', sender: '+49151', content: '%EF%BB%BFIch+bin+ein+Test' })!.text).toBe('Ich bin ein Test');
    expect(parseReceivedSms({ gsmspan: '2', sender: '+49151', content: 'Gr\u00fc\u00dfe 100%' })!.text).toBe('Grüße 100%');
    expect(channelSpan('extra/2-1')).toBe(2);
    expect(channelSpan('GSM/3')).toBe(3);
    expect(channelSpan('SIP/trunk-0001')).toBeNull();
  });

  it('liest die Trunk-Namen', () => {
    expect([...parseTrunks('1:Telekom D1; 2 : Vodafone;')]).toEqual([
      [1, 'Telekom D1'],
      [2, 'Vodafone'],
    ]);
    expect(() => parseTrunks('1:A; 1:B')).toThrow(/doppelt/);
  });
});

/** Nachgebautes Gateway: beantwortet Login, Abfragen und SMS-Befehle */
class FakeTg {
  readonly server: Server;
  readonly commands: string[] = [];
  client: Socket | null = null;
  password = 'apipass';

  constructor() {
    this.server = createServer((s) => {
      this.client = s;
      s.setEncoding('utf8');
      s.write('Asterisk Call Manager/1.1\r\n');
      let buf = '';
      s.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
          this.handle(s, buf.slice(0, i));
          buf = buf.slice(i + 4);
        }
      });
    });
  }

  private handle(s: Socket, block: string): void {
    const f = Object.fromEntries(block.split('\r\n').map((l) => [l.split(':')[0]!.toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
    if (f.action === 'Login') {
      s.write(f.secret === this.password ? 'Response: Success\r\nMessage: Authentication accepted\r\n\r\n' : 'Response: Error\r\nMessage: Authentication failed\r\n\r\n');
      return;
    }
    const cmd = f.command ?? '';
    this.commands.push(cmd);
    if (cmd === 'gsm show spans') s.write(SPANS);
    else if (cmd === 'gsm show span 2') s.write(SPAN_2);
    else if (cmd === 'gsm show span 3') s.write(SPAN_3);
    else if (cmd.startsWith('gsm send sms')) {
      const id = cmd.split(' ').pop()!;
      s.write('Response: Follows\r\nPrivilege: SMSCommand\r\n--END COMMAND--\r\n\r\n');
      setTimeout(() => s.write(`Event: UpdateSMS\r\nPrivilege: all,smscommand\r\nID: ${id}\r\nSmsstatus: ${cmd.includes('fehler') ? 0 : 1}\r\n\r\n`), 20);
    } else s.write('Response: Error\r\nMessage: Command isn\'t supported\r\n\r\n');
  }

  event(fields: Record<string, string>): void {
    this.client!.write(`${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
  }

  listen(): Promise<number> {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r((this.server.address() as AddressInfo).port)));
  }
}

const log = { info: () => {}, warn: () => {}, error: () => {} };
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('Yeastar TG: Treiber', () => {
  let tg: FakeTg;
  let adapter: YeastarTgAdapter;
  afterEach(async () => {
    await adapter?.stop();
    await new Promise((r) => tg.server.close(r));
  });

  async function start(password = 'apipass') {
    tg = new FakeTg();
    const port = await tg.listen();
    const bus = new TelephonyBus();
    const sms: IncomingSms[] = [];
    const calls: EndedCall[] = [];
    bus.onSms((s) => sms.push(s));
    bus.onCall((c) => calls.push(c));
    adapter = new YeastarTgAdapter(
      { host: '127.0.0.1', port, username: 'apiuser', password, trunks: parseTrunks('1:Telekom 1; 2:Telekom 2'), smsPort: 1, sipPort: null, pollMs: 60_000, reconnectMs: 60_000, responseMs: 1000, smsConfirmMs: 1000 },
      bus,
    );
    await adapter.start({ log, getState: () => undefined });
    return { sms, calls, state: () => adapter.getState() as TelephonyState };
  }

  it('meldet sich an und liest beide Trunks', async () => {
    const { state } = await start();
    await until(() => state().trunks.every((t) => t.status === 'up'));
    expect(adapter.isOnline()).toBe(true);
    expect(state().trunks.map((t) => [t.port, t.name, t.operator, t.csq, t.signalPercent])).toEqual([
      [1, 'Telekom 1', 'Telekom.de', 31, 100],
      [2, 'Telekom 2', 'Telekom.de', 18, 58],
    ]);
    expect(state().link).toMatchObject({ connected: true, error: null });
  });

  it('meldet eine abgelehnte Anmeldung und geht nicht online', async () => {
    const { state } = await start('falsch');
    await until(() => !!state().link?.error);
    expect(state().link?.error).toMatch(/Anmeldung abgelehnt/);
    expect(adapter.isOnline()).toBe(false);
    const alerts = evaluateAlerts((id) => (id === 'telephony' ? (state() as never) : undefined), ['telephony'], { batteryWarnPercent: 30, batteryAlarmPercent: 15 } as never);
    expect(alerts.some((a) => a.id.startsWith('telephony:'))).toBe(false);
  });

  it('sendet SMS mit Bestätigung und meldet Fehler', async () => {
    const { state } = await start();
    await until(() => state().trunks[0]!.status === 'up');
    await expect(adapter.execute('sendSms', { number: '0171 1234567', text: 'Hallo' })).resolves.toMatch(/SMS an \+49 171 1234567 über Telekom 1 gesendet/);
    expect(tg.commands.find((c) => c.startsWith('gsm send sms'))).toMatch(/^gsm send sms 2 01711234567 "Hallo" elvis/);
    await expect(adapter.execute('sendSms', { number: '0171 1234567', text: 'fehler', port: 2 })).rejects.toThrow(/nicht bestätigt/);
    expect(tg.commands.at(-1)).toMatch(/^gsm send sms 3 /);
  });

  it('gibt empfangene SMS weiter, mehrteilige zusammengesetzt', async () => {
    const { sms } = await start();
    await until(() => adapter.isOnline());
    tg.event({ Event: 'ReceivedSMS', ID: '7', GsmSpan: '3', Sender: '01701234567', Index: '1', Total: '1', Content: 'Lage%20ruhig' });
    tg.event({ Event: 'ReceivedSMS', ID: '8', GsmSpan: '2', Sender: '+491609876543', Index: '2', Total: '2', Content: 'Teil%202' });
    tg.event({ Event: 'ReceivedSMS', ID: '8', GsmSpan: '2', Sender: '+491609876543', Index: '1', Total: '2', Content: 'Teil%201%20' });
    await until(() => sms.length === 2);
    expect(sms.map((s) => [s.port, s.number, s.text])).toEqual([
      [2, '+491701234567', 'Lage ruhig'],
      [1, '+491609876543', 'Teil 1 Teil 2'],
    ]);
  });

  it('erkennt Gespräche aus den Kanal-Ereignissen', async () => {
    const { calls, state } = await start();
    await until(() => adapter.isOnline());
    tg.event({ Event: 'Newchannel', Channel: 'extra/2-1', ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '01701234567', Exten: 's', Uniqueid: '100.1' });
    await until(() => state().calls.length === 1);
    expect(state().calls[0]).toMatchObject({ direction: 'in', port: 1, number: '+491701234567', answeredAt: null });
    expect(state().trunks[0]!.busy).toBe(true);
    tg.event({ Event: 'Newstate', Channel: 'extra/2-1', ChannelState: '6', ChannelStateDesc: 'Up', Uniqueid: '100.1' });
    tg.event({ Event: 'Newchannel', Channel: 'extra/3-1', ChannelState: '0', ChannelStateDesc: 'Down', CallerIDNum: '200', Exten: '', Uniqueid: '101.1' });
    tg.event({ Event: 'Dial', SubEvent: 'Begin', Channel: 'SIP/pbx-1', Destination: 'extra/3-1', UniqueID: '99.1', DestUniqueID: '101.1', Dialstring: '3/0541123456' });
    tg.event({ Event: 'Hangup', Channel: 'extra/3-1', Uniqueid: '101.1', Cause: '16' });
    tg.event({ Event: 'Hangup', Channel: 'extra/2-1', Uniqueid: '100.1', Cause: '16' });
    tg.event({ Event: 'Hangup', Channel: 'SIP/pbx-1', Uniqueid: '99.1', Cause: '16' });
    await until(() => calls.length === 2);
    expect(calls[0]).toMatchObject({ direction: 'out', port: 2, number: '+49541123456', answeredAt: null });
    expect(calls[1]).toMatchObject({ direction: 'in', port: 1, number: '+491701234567' });
    expect(calls[1]!.answeredAt).not.toBeNull();
    expect(state().calls).toEqual([]);
  });
});
