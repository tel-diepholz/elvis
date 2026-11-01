import { afterEach, describe, expect, it } from 'vitest';
import { MessengerBus, memoryVault, type ChatReceipt, type IncomingChat } from '../../messaging/bus.js';
import { TelegramAdapter, telegramError } from './adapter.js';
import type { TelegramApi, TgIncoming, TgLogin, TgPeer } from './api.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Telegram zum Testen: Anmeldung mit Code 12345 und Passwort „geheim“, Nutzer +491701234567 = ID 777 */
class FakeTelegram implements TelegramApi {
  authorized = false;
  twoFactor = true;
  sent: { kind: string; peer: TgPeer; value: unknown }[] = [];
  imports: string[][] = [];
  messageFn: ((m: TgIncoming) => void) | null = null;
  readFn: ((peerId: string, maxId: number) => void) | null = null;
  nextId = 100;

  constructor(readonly sessionIn: string) {
    this.authorized = sessionIn === 'gespeichert';
  }
  async connect() {}
  async isAuthorized() {
    return this.authorized;
  }
  async login(_phone: string, cb: TgLogin) {
    for (;;) {
      const code = await cb.code();
      if (code === '12345') break;
      if (cb.onError(new Error('PHONE_CODE_INVALID'))) throw new Error('abgebrochen');
    }
    if (this.twoFactor) {
      for (;;) {
        const pw = await cb.password('Hund');
        if (pw === 'geheim') break;
        if (cb.onError(new Error('PASSWORD_HASH_INVALID'))) throw new Error('abgebrochen');
      }
    }
    this.authorized = true;
  }
  async me() {
    return { id: '1', phone: '+491700000000', name: 'ELW 2' };
  }
  session() {
    return 'gespeichert';
  }
  onMessage(fn: (m: TgIncoming) => void) {
    this.messageFn = fn;
  }
  onReadOutbox(fn: (peerId: string, maxId: number) => void) {
    this.readFn = fn;
  }
  async sendText(peer: TgPeer, text: string) {
    this.sent.push({ kind: 'text', peer, value: text });
    return this.nextId++;
  }
  async sendPhoto(peer: TgPeer, path: string, caption: string) {
    this.sent.push({ kind: 'photo', peer, value: [path, caption] });
    return this.nextId++;
  }
  async sendLocation(peer: TgPeer, lat: number, lon: number) {
    this.sent.push({ kind: 'location', peer, value: [lat, lon] });
    return this.nextId++;
  }
  async importContacts(numbers: string[]) {
    this.imports.push(numbers);
    return new Map(numbers.filter((n) => n === '+491701234567').map((n) => [n, { id: '777', accessHash: 'h777' }]));
  }
  async resolveUsername(name: string) {
    if (name !== 'max') throw new Error('USERNAME_NOT_OCCUPIED');
    return { id: '888', accessHash: 'h888' };
  }
  async disconnect() {}
}

let adapter: TelegramAdapter;
afterEach(async () => adapter?.stop());

function make(session: string | null = null) {
  const vault = memoryVault();
  if (session) vault.set('telegram:session', session);
  const bus = new MessengerBus();
  const messages: IncomingChat[] = [];
  const receipts: ChatReceipt[] = [];
  bus.onMessage((m) => messages.push(m));
  bus.onReceipt((r) => receipts.push(r));
  let api: FakeTelegram | null = null;
  adapter = new TelegramAdapter({ apiId: 1, apiHash: 'x', phone: '+491700000000' }, bus, vault, (s) => (api = new FakeTelegram(s)));
  return { vault, messages, receipts, api: () => api! };
}

describe('Telegram', () => {
  it('meldet fehlende Moduleinstellungen', async () => {
    adapter = new TelegramAdapter({ apiId: 0, apiHash: '', phone: '' }, new MessengerBus(), memoryVault());
    await adapter.start({ log, getState: () => undefined });
    expect(adapter.getState()).toMatchObject({ status: 'setup', setup: { step: 'info' } });
  });

  it('meldet sich mit Code und Passwort an und sichert die Sitzung', async () => {
    const t = make();
    await adapter.start({ log, getState: () => undefined });
    await until(() => adapter.getState().status === 'setup');
    expect(adapter.getState().setup?.step).toBe('start');
    await adapter.setup({ action: 'login' });
    await until(() => adapter.getState().setup?.step === 'code');
    await adapter.setup({ action: 'code', code: '99999' });
    await until(() => adapter.getState().setup?.error === 'Code falsch');
    await expect(adapter.setup({ action: 'password', password: 'x' })).rejects.toThrow(/wartet nicht/);
    await adapter.setup({ action: 'code', code: '12 345' });
    await until(() => adapter.getState().setup?.step === 'password');
    expect(adapter.getState().setup?.hint).toMatch(/Hinweis: Hund/);
    await adapter.setup({ action: 'password', password: 'geheim' });
    await until(() => adapter.getState().status === 'connected');
    expect(adapter.getState()).toMatchObject({ account: '+491700000000', setup: null });
    expect(t.vault.get('telegram:session')).toBe('gespeichert');
  });

  it('empfängt, sendet über Kontaktimport und meldet Lesebestätigungen', async () => {
    const t = make('gespeichert');
    await adapter.start({ log, getState: () => undefined });
    await until(() => adapter.getState().status === 'connected');
    const api = t.api();

    api.messageFn!({ id: 5, peer: { id: '999', accessHash: 'h999' }, phone: null, name: null, username: 'erika', text: '', photo: async () => Buffer.from('JPG'), geo: { lat: 52.6, lon: 8.37, label: 'Marktplatz' }, date: 1700000000 });
    await until(() => t.messages.length === 1);
    expect(t.messages[0]).toMatchObject({ channel: 'telegram', peer: '999', number: null, peerName: '@erika', externalId: '999:5', location: { label: 'Marktplatz' }, attachment: { mimeType: 'image/jpeg' } });

    // Antwort an die bekannte ID ohne Kontaktimport
    await adapter.sendMessage({ peer: '999', number: null, text: 'Danke', attachment: null, location: null });
    expect(api.sent.at(-1)).toMatchObject({ kind: 'text', peer: { id: '999', accessHash: 'h999' } });
    expect(api.imports).toEqual([]);

    // Rufnummer: Kontaktimport, dann Text und Standort
    const r = await adapter.sendMessage({ peer: '+491701234567', number: '+491701234567', text: 'Treffpunkt', attachment: null, location: { lat: 52.1, lon: 8.2, label: '' } });
    expect(api.sent.slice(-2).map((s) => s.kind)).toEqual(['text', 'location']);
    expect(r.externalId).toBe('777:101');
    await expect(adapter.sendMessage({ peer: '+491609999999', number: '+491609999999', text: 'x', attachment: null, location: null })).rejects.toThrow(/nutzt kein Telegram/);
    await adapter.sendMessage({ peer: 'max', number: null, text: 'Hallo', attachment: { name: 'a.jpg', mimeType: 'image/jpeg', path: '/tmp/a.jpg' }, location: null });
    expect(api.sent.at(-1)).toMatchObject({ kind: 'photo', peer: { id: '888' }, value: ['/tmp/a.jpg', 'Hallo'] });

    api.readFn!('777', 101);
    expect(t.receipts).toEqual([{ channel: 'telegram', externalId: '777:101', status: 'read' }]);

    const reach = await adapter.checkReachable(['+491701234567', '+491609999998']);
    expect([...reach]).toEqual([
      ['+491701234567', { reachable: true, peer: '777' }],
      ['+491609999998', { reachable: false, peer: null }],
    ]);
  });

  it('übersetzt Fehler', () => {
    expect(telegramError(new Error('A wait of 600 seconds is required'))).toMatch(/in 10 min/);
    expect(telegramError(new Error('API_ID_INVALID'))).toMatch(/API-ID/);
  });
});
