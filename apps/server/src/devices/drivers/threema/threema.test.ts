import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookKind, RelayHookEvent } from '@elvis/shared';
import { MessengerBus, type ChatReceipt, type HookSource, type IncomingChat } from '../../messaging/bus.js';
import { ThreemaGatewayAdapter, callbackMac, pad, phoneHash, unpad } from './gateway.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const SECRET = 'apisecret';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const FILE_NONCE = new Uint8Array([...new Array(23).fill(0), 1]);

const me = nacl.box.keyPair();
const max = nacl.box.keyPair();
const MAX_ID = 'MAXMUST1';
const MAX_PHONE = '+491701234567';

/** msgapi.threema.ch zum Testen: Max kann entschlüsseln, was ELVIS ihm schickt */
function fakeGateway() {
  const sent: { to: string; type: number; payload: Uint8Array }[] = [];
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = (s: string, status = 200) => new Response(s, { status });
    if (url.searchParams.get('secret') && url.searchParams.get('secret') !== SECRET) return text('', 401);
    if (url.pathname === '/credits') return text('1234');
    if (url.pathname === `/lookup/phone_hash/${phoneHash(MAX_PHONE)}`) return text(MAX_ID);
    if (url.pathname.startsWith('/lookup/phone_hash/')) return text('', 404);
    if (url.pathname === `/pubkeys/${MAX_ID}`) return text(hex(max.publicKey));
    if (url.pathname === '/upload_blob') {
      const blob = (init!.body as FormData).get('blob') as Blob;
      const id = `b${++n}`.padEnd(32, '0');
      blobs.set(id, new Uint8Array(await blob.arrayBuffer()));
      return text(id);
    }
    if (url.pathname.startsWith('/blobs/')) return new Response(Buffer.from(blobs.get(url.pathname.slice(7))!));
    if (url.pathname === '/send_e2e') {
      const p = init!.body as URLSearchParams;
      if (p.get('secret') !== SECRET) return text('', 401);
      const plain = nacl.box.open(Buffer.from(p.get('box')!, 'hex'), Buffer.from(p.get('nonce')!, 'hex'), me.publicKey, max.secretKey)!;
      const { type, payload } = unpad(plain);
      sent.push({ to: p.get('to')!, type, payload });
      return text(`00000000000000${String(sent.length).padStart(2, '0')}`);
    }
    return text('', 404);
  }) as typeof fetch;
  return { sent, blobs, fetchFn };
}

function fakeHooks(): HookSource & { fns: Map<HookKind, (e: RelayHookEvent) => Promise<void>> } {
  const fns = new Map<HookKind, (e: RelayHookEvent) => Promise<void>>();
  return { enabled: true, fns, register: async (kind) => ({ kind, url: `https://relay.test/h/${kind}`, verifyToken: 'vt' }), subscribe: (kind, fn) => (fns.set(kind, fn), () => fns.delete(kind)) };
}

/** Rückruf, wie Threema ihn an das Relay schickt: Max schreibt an ELVIS */
function callback(type: number, payload: Uint8Array, opts: { mac?: string; messageId?: string } = {}): RelayHookEvent {
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(pad(type, payload), nonce, me.publicKey, max.secretKey);
  const p = new URLSearchParams({ from: MAX_ID, to: '*ELVIS01', messageId: opts.messageId ?? '1122334455667788', date: '1700000000', nonce: hex(nonce), box: hex(box), nickname: 'Max' });
  p.set('mac', opts.mac ?? callbackMac(SECRET, p));
  return { seq: 1, kind: 'threema', contentType: 'application/x-www-form-urlencoded', signature: null, body: p.toString(), receivedAt: '' };
}

let adapter: ThreemaGatewayAdapter;
afterEach(async () => adapter?.stop());

async function start() {
  const gw = fakeGateway();
  const hooks = fakeHooks();
  const bus = new MessengerBus();
  const messages: IncomingChat[] = [];
  const receipts: ChatReceipt[] = [];
  bus.onMessage((m) => messages.push(m));
  bus.onReceipt((r) => receipts.push(r));
  adapter = new ThreemaGatewayAdapter({ gatewayId: '*ELVIS01', secret: SECRET, privateKey: `private:${hex(me.secretKey)}`, apiUrl: 'https://msgapi.test' }, bus, hooks, gw.fetchFn);
  await adapter.start({ log, getState: () => undefined });
  return { gw, hooks, messages, receipts };
}

describe('Threema Gateway (E2E)', () => {
  it('füllt auf und entfernt die Auffüllung wieder', () => {
    for (let i = 0; i < 50; i++) {
      const data = pad(1, new Uint8Array([65]));
      expect(data.length).toBeGreaterThanOrEqual(32);
      expect(unpad(data)).toEqual({ type: 1, payload: new Uint8Array([65]) });
    }
  });

  it('verbindet, sendet verschlüsselt (Text, Bild, Standort) und prüft Erreichbarkeit', async () => {
    const { gw } = await start();
    expect(adapter.getState()).toMatchObject({ status: 'connected', account: '*ELVIS01', link: { target: 'Threema Gateway · 1234 Credits' } });
    expect(adapter.setupDetails().webhook).toEqual({ url: 'https://relay.test/h/threema', verifyToken: null });

    const r = await adapter.sendMessage({ peer: MAX_PHONE, number: MAX_PHONE, text: 'Hallo Max', attachment: null, location: { lat: 52.6, lon: 8.37, label: 'Marktplatz' } });
    expect(r.externalId).toBe('0000000000000001');
    expect(gw.sent.map((s) => [s.to, s.type, new TextDecoder().decode(s.payload)])).toEqual([
      [MAX_ID, 0x01, 'Hallo Max'],
      [MAX_ID, 0x10, '52.600000,8.370000\nMarktplatz'],
    ]);

    const dir = mkdtempSync(join(tmpdir(), 'elvis-threema-'));
    try {
      writeFileSync(join(dir, 'f'), 'BILD');
      await adapter.sendMessage({ peer: MAX_ID, number: null, text: 'Lage', attachment: { name: 'a.png', mimeType: 'image/png', path: join(dir, 'f') }, location: null });
      // Dateien als Datei (j = 0), Bilder als Medium (j = 1)
      await adapter.sendMessage({ peer: MAX_ID, number: null, text: '', attachment: { name: 'Plan.pdf', mimeType: 'application/pdf', path: join(dir, 'f') }, location: null });
      expect(JSON.parse(new TextDecoder().decode(gw.sent.at(-1)!.payload))).toMatchObject({ m: 'application/pdf', n: 'Plan.pdf', j: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const file = JSON.parse(new TextDecoder().decode(gw.sent.at(-2)!.payload)) as { b: string; k: string; m: string; d: string; s: number };
    expect(file).toMatchObject({ m: 'image/png', n: 'a.png', d: 'Lage', s: 4, j: 1 });
    expect(Buffer.from(nacl.secretbox.open(gw.blobs.get(file.b)!, FILE_NONCE, Buffer.from(file.k, 'hex'))!).toString()).toBe('BILD');

    await expect(adapter.sendMessage({ peer: '+491609999999', number: '+491609999999', text: 'x', attachment: null, location: null })).rejects.toThrow(/keiner Threema-ID/);
    expect([...(await adapter.checkReachable([MAX_PHONE, '+491609999999']))]).toEqual([
      [MAX_PHONE, { reachable: true, peer: MAX_ID }],
      ['+491609999999', { reachable: false, peer: null }],
    ]);
  });

  it('empfängt Text, Standort, Bild und Empfangsbestätigungen, verwirft falsche MACs', async () => {
    const { hooks, gw, messages, receipts } = await start();
    const hook = hooks.fns.get('threema')!;
    await hook(callback(0x01, new TextEncoder().encode('Bin da')));
    await hook(callback(0x10, new TextEncoder().encode('52.6,8.37,10\nMarktplatz\nLange Straße 1'), { messageId: 'aa' }));
    // Bild: Max lädt einen verschlüsselten Blob hoch
    const key = nacl.randomBytes(32);
    gw.blobs.set('c'.repeat(32), nacl.secretbox(new TextEncoder().encode('JPEG'), FILE_NONCE, key));
    await hook(callback(0x17, new TextEncoder().encode(JSON.stringify({ b: 'c'.repeat(32), k: hex(key), m: 'image/jpeg', n: 'foto.jpg', s: 4, i: 0, j: 1 })), { messageId: 'bb' }));
    await hook(callback(0x80, new Uint8Array([2, ...Buffer.from('0000000000000001', 'hex'), ...Buffer.from('0000000000000002', 'hex')])));
    await hook(callback(0x01, new TextEncoder().encode('gefälscht'), { mac: '00'.repeat(32), messageId: 'cc' }));

    expect(messages.map((m) => [m.peer, m.number, m.peerName, m.text, m.location?.label ?? null, m.attachment?.data.toString() ?? null, m.externalId])).toEqual([
      [MAX_ID, null, 'Max', 'Bin da', null, null, '1122334455667788'],
      [MAX_ID, null, 'Max', '', 'Marktplatz, Lange Straße 1', null, 'aa'],
      [MAX_ID, null, 'Max', '', null, 'JPEG', 'bb'],
    ]);
    expect(receipts).toEqual([
      { channel: 'threema', externalId: '0000000000000001', status: 'read' },
      { channel: 'threema', externalId: '0000000000000002', status: 'read' },
    ]);
  });

  it('meldet fehlende oder falsche Zugangsdaten', async () => {
    adapter = new ThreemaGatewayAdapter({ gatewayId: 'ELVIS', secret: '', privateKey: '', apiUrl: 'x' }, new MessengerBus(), fakeHooks());
    await adapter.start({ log, getState: () => undefined });
    expect(adapter.getState()).toMatchObject({ status: 'setup', setup: { step: 'info' } });
    await adapter.stop();
    const gw = fakeGateway();
    adapter = new ThreemaGatewayAdapter({ gatewayId: '*ELVIS01', secret: 'falsch', privateKey: hex(me.secretKey), apiUrl: 'https://msgapi.test' }, new MessengerBus(), fakeHooks(), gw.fetchFn);
    await adapter.start({ log, getState: () => undefined });
    expect(adapter.getState()).toMatchObject({ status: 'error', link: { error: expect.stringMatching(/Secret falsch/) } });
  });
});
