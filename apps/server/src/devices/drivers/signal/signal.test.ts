import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLocationLink } from '@elvis/shared';
import { MessengerBus, type ChatReceipt, type IncomingChat } from '../../messaging/bus.js';
import { SignalCliAdapter } from './adapter.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** signal-cli-Daemon zum Testen: JSON-RPC und Ereignisstrom */
class FakeSignalCli {
  server: Server;
  accounts: { number: string | null; aci?: string }[] = [{ number: '+491700000000', aci: 'aci-elw' }];
  calls: { method: string; params: Record<string, unknown> }[] = [];
  streams: ServerResponse[] = [];
  linked: (() => void) | null = null;
  failProfile = false;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    for (const s of this.streams) s.end();
    return new Promise((r) => this.server.close(() => r()));
  }

  private seq = 0;

  /** Wie signal-cli 0.14 (SseEventBuffer): id, event:receive und {account, envelope} – keine JSON-RPC-Hülle */
  emit(params: unknown): void {
    for (const s of this.streams) s.write(`id:1700-${++this.seq}\nevent:receive\ndata:${JSON.stringify(params)}\n\n`);
  }

  /** JSON-RPC-Form (z. B. über --tcp/--socket) */
  emitRpc(params: unknown): void {
    for (const s of this.streams) s.write(`event:receive\ndata:${JSON.stringify({ jsonrpc: '2.0', method: 'receive', params })}\n\n`);
  }

  private result(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'listAccounts':
        return this.accounts;
      case 'send': {
        const to = (params.recipient as string[])[0]!;
        return { timestamp: 1700000000123, results: [{ recipientAddress: { number: to }, type: to === '+491609999999' ? 'UNREGISTERED_FAILURE' : 'SUCCESS' }] };
      }
      case 'getUserStatus':
        return (params.recipient as string[]).map((n) => ({ recipient: n, number: n, uuid: 'u', isRegistered: n.endsWith('7') }));
      case 'getAttachment':
        return { data: Buffer.from('PNGDATA').toString('base64') };
      case 'startLink':
        return { deviceLinkUri: 'sgnl://linkdevice?uuid=abc&pub_key=xyz' };
      case 'finishLink':
        return new Promise((r) => (this.linked = () => (this.accounts.push({ number: '+491711111111' }), r({ number: '+491711111111' }))));
      case 'updateProfile':
        if (this.failProfile) throw new Error('Profil kaputt');
        return {};
      case 'register':
      case 'verify':
        if (method === 'verify') this.accounts.push({ number: params.account as string });
        return {};
      default:
        throw new Error(`unbekannt: ${method}`);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url?.startsWith('/api/v1/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(':\n\n');
      this.streams.push(res);
      return;
    }
    let body = '';
    for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
    this.calls.push({ method, params });
    try {
      const result = await this.result(method, params);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: (e as Error).message } }));
    }
  }
}

let fake: FakeSignalCli;
let adapter: SignalCliAdapter;

afterEach(async () => {
  await adapter?.stop();
  await fake?.close();
});

async function start(account: string | null = null) {
  fake = new FakeSignalCli();
  const url = await fake.listen();
  const bus = new MessengerBus();
  const messages: IncomingChat[] = [];
  const receipts: ChatReceipt[] = [];
  bus.onMessage((m) => messages.push(m));
  bus.onReceipt((r) => receipts.push(r));
  adapter = new SignalCliAdapter({ endpoint: () => ({ url, token: 'geheim' }), account, deviceName: 'ELVIS', reconnectMs: 100 }, bus);
  await adapter.start({ log, getState: () => undefined });
  return { bus, messages, receipts };
}

describe('Signal (signal-cli)', () => {
  it('verbindet, empfängt Nachrichten mit Bild und Standort und Empfangsbestätigungen', async () => {
    const { messages, receipts } = await start();
    await until(() => adapter.getState().status === 'connected' && fake.streams.length > 0);
    expect(adapter.getState()).toMatchObject({ account: '+491700000000', capabilities: { images: true, location: false, reachability: true } });

    fake.emit({
      account: '+491700000000',
      envelope: {
        sourceNumber: '+491701234567',
        sourceUuid: 'uuid-1',
        sourceName: 'Max',
        timestamp: 1700000000000,
        dataMessage: { message: 'Hier: https://maps.google.com/maps?q=52.6087%2C8.3712', attachments: [{ contentType: 'image/png', filename: 'lage.png', id: 'att1' }] },
      },
    });
    // Gruppen und Bestätigungen fremder Konten zählen nicht
    fake.emit({ account: '+491700000000', envelope: { sourceNumber: '+491701234567', timestamp: 2, dataMessage: { message: 'Gruppe', groupInfo: { groupId: 'g' } } } });
    fake.emit({ account: '+499999', envelope: { sourceNumber: '+491701234567', timestamp: 3, dataMessage: { message: 'fremd' } } });
    fake.emit({ account: '+491700000000', envelope: { sourceNumber: '+491701234567', timestamp: 4, receiptMessage: { isDelivery: true, timestamps: [1700000000123] } } });
    // JSON-RPC-Form mit Abonnement (params.result), Konto als ACI
    fake.emitRpc({ subscription: 0, result: { account: 'aci-elw', envelope: { sourceNumber: '+491609876543', sourceUuid: 'uuid-2', timestamp: 5, dataMessage: { message: 'Über ACI' } } } });
    await until(() => messages.length === 2 && receipts.length === 1);
    expect(messages[1]).toMatchObject({ peer: 'uuid-2', number: '+491609876543', text: 'Über ACI', externalId: 'uuid-2:5' });
    expect(fake.calls.find((c) => c.method === 'getAttachment')?.params).toEqual({ account: '+491700000000', id: 'att1', recipient: 'uuid-1' });
    expect(messages[0]).toMatchObject({
      channel: 'signal',
      peer: 'uuid-1',
      number: '+491701234567',
      peerName: 'Max',
      location: { lat: 52.6087, lon: 8.3712 },
      externalId: 'uuid-1:1700000000000',
      attachment: { name: 'lage.png', mimeType: 'image/png' },
    });
    expect(messages[0]!.attachment!.data.toString()).toBe('PNGDATA');
    expect(receipts).toEqual([{ channel: 'signal', externalId: '1700000000123', status: 'delivered' }]);

    // Rufnummer verborgen: nur die UUID kommt an
    fake.emit({ account: '+491700000000', envelope: { sourceUuid: 'uuid-3', timestamp: 6, dataMessage: { message: 'Ohne Nummer' } } });
    await until(() => messages.length === 3);
    expect(messages[2]).toMatchObject({ peer: 'uuid-3', number: null, text: 'Ohne Nummer' });
  });

  it('sendet mit Bild als Daten-URL, prüft Erreichbarkeit und meldet Fehler', async () => {
    await start();
    await until(() => adapter.getState().status === 'connected');
    const dir = mkdtempSync(join(tmpdir(), 'elvis-signal-'));
    try {
      writeFileSync(join(dir, 'f'), 'BILD');
      const r = await adapter.sendMessage({ peer: '+491701234567', number: '+491701234567', text: 'Hallo', attachment: { name: 'a.png', mimeType: 'image/png', path: join(dir, 'f') }, location: null });
      expect(r.externalId).toBe('1700000000123');
      const send = fake.calls.find((c) => c.method === 'send')!.params;
      expect(send).toMatchObject({ account: '+491700000000', recipient: ['+491701234567'], message: 'Hallo', attachments: [`data:image/png;filename=a.png;base64,${Buffer.from('BILD').toString('base64')}`] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(adapter.sendMessage({ peer: '+491609999999', number: '+491609999999', text: 'x', attachment: null, location: null })).rejects.toThrow(/nutzt kein Signal/);
    const reach = await adapter.checkReachable(['+491701234567', '+491609999998']);
    expect([...reach]).toEqual([
      ['+491701234567', { reachable: true, peer: 'u' }],
      ['+491609999998', { reachable: false, peer: null }],
    ]);
  });

  it('richtet ohne Konto als verknüpftes Gerät oder per Registrierung ein', async () => {
    fake = new FakeSignalCli();
    fake.accounts = [];
    const url = await fake.listen();
    adapter = new SignalCliAdapter({ endpoint: () => ({ url, token: 'geheim' }), account: null, deviceName: 'ELW 2', reconnectMs: 100 }, new MessengerBus());
    await adapter.start({ log, getState: () => undefined });
    await until(() => adapter.getState().status === 'setup');
    expect(adapter.getState().setup).toMatchObject({ step: 'start' });

    await adapter.setup({ action: 'link' });
    expect(adapter.getState().setup?.step).toBe('qr');
    expect(adapter.setupDetails().qr).toBe('sgnl://linkdevice?uuid=abc&pub_key=xyz');
    // Der QR-Inhalt steht nicht im öffentlichen Zustand
    expect(JSON.stringify(adapter.getState())).not.toContain('sgnl://');
    await until(() => !!fake.linked);
    expect(fake.calls.find((c) => c.method === 'finishLink')?.params).toMatchObject({ deviceName: 'ELW 2' });
    fake.linked!();
    await until(() => adapter.getState().status === 'connected');
    expect(adapter.getState()).toMatchObject({ account: '+491711111111', setup: null });
    expect(adapter.setupDetails().qr).toBeNull();

    // Registrierung mit eigener Nummer
    fake.accounts = [];
    await adapter.connect();
    await adapter.setup({ action: 'register', number: '0170 5555555', captcha: 'signalcaptcha://signal-hcaptcha.abc' });
    expect(fake.calls.find((c) => c.method === 'register')?.params).toEqual({ account: '+491705555555', captcha: 'signal-hcaptcha.abc' });
    expect(adapter.getState().setup?.step).toBe('code');
    await adapter.setup({ action: 'code', code: '123-456' });
    expect(fake.calls.find((c) => c.method === 'verify')?.params).toEqual({ account: '+491705555555', verificationCode: '123456' });
    expect(adapter.getState()).toMatchObject({ status: 'connected', account: '+491705555555' });
  });

  it('meldet einen nicht erreichbaren Daemon', async () => {
    fake = new FakeSignalCli();
    const url = await fake.listen();
    await fake.close();
    adapter = new SignalCliAdapter({ endpoint: () => ({ url, token: null }), account: null, deviceName: 'ELVIS', reconnectMs: 60_000 }, new MessengerBus());
    await adapter.start({ log, getState: () => undefined });
    await until(() => adapter.getState().status === 'error');
    expect(adapter.isOnline()).toBe(false);
    expect(adapter.getState().link?.error).toMatch(/nicht erreichbar/);
    fake = new FakeSignalCli();
  });

  it('setzt den Profilnamen aus den Einstellungen, ohne Namen nicht', async () => {
    await start();
    await until(() => adapter.getState().status === 'connected');
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.some((c) => c.method === 'updateProfile')).toBe(false);
    await adapter.stop();
    await fake.close();

    fake = new FakeSignalCli();
    const url = await fake.listen();
    adapter = new SignalCliAdapter({ endpoint: () => ({ url, token: null }), account: null, deviceName: 'ELVIS', profileName: 'ELW 1', profileAbout: 'Feuerwehr', reconnectMs: 100 }, new MessengerBus());
    await adapter.start({ log, getState: () => undefined });
    await until(() => fake.calls.some((c) => c.method === 'updateProfile'));
    expect(fake.calls.find((c) => c.method === 'updateProfile')?.params).toEqual({ account: '+491700000000', givenName: 'ELW 1', familyName: '', about: 'Feuerwehr' });
    // Wiederverbinden schreibt das Profil nicht erneut
    await adapter.connect();
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.filter((c) => c.method === 'updateProfile')).toHaveLength(1);
  });

  it('bleibt verbunden, wenn das Profil nicht gesetzt werden kann', async () => {
    fake = new FakeSignalCli();
    fake.failProfile = true;
    const url = await fake.listen();
    adapter = new SignalCliAdapter({ endpoint: () => ({ url, token: null }), account: null, deviceName: 'ELVIS', profileName: 'ELW 1', reconnectMs: 100 }, new MessengerBus());
    await adapter.start({ log, getState: () => undefined });
    await until(() => fake.calls.some((c) => c.method === 'updateProfile'));
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.getState().status).toBe('connected');
  });
});

describe('Standort aus Kartenlinks', () => {
  it('erkennt Google Maps, OpenStreetMap und geo:', () => {
    expect(parseLocationLink('https://maps.google.com/maps?q=52.6087%2C8.3712')).toEqual({ lat: 52.6087, lon: 8.3712 });
    expect(parseLocationLink('Treffpunkt https://www.google.com/maps/search/?api=1&query=x https://www.google.com/maps/@52.5,8.4,15z')).toEqual({ lat: 52.5, lon: 8.4 });
    expect(parseLocationLink('https://www.openstreetmap.org/?mlat=52.608700&mlon=8.371200#map=17/52.608700/8.371200')).toEqual({ lat: 52.6087, lon: 8.3712 });
    expect(parseLocationLink('geo:52.1,8.2?z=10')).toEqual({ lat: 52.1, lon: 8.2 });
    expect(parseLocationLink('Kein Link 52.1, 8.2')).toBeNull();
  });
});
