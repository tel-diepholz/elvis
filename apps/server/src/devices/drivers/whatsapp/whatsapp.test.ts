import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookKind, RelayHookEvent } from '@elvis/shared';
import { MessengerBus, type ChatReceipt, type HookSource, type IncomingChat } from '../../messaging/bus.js';
import { WhatsAppCloudAdapter, validSignature } from './cloud.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };
const SECRET = 'appsecret';
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

/** Graph API zum Testen */
function fakeGraph() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.keys()].map((k) => [k, true])) : init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/123456?fields=display_phone_number,verified_name')) return ok({ display_phone_number: '+49 170 0000000', verified_name: 'ELW 2' });
    if (url.endsWith('/123456/media')) return ok({ id: 'media-1' });
    if (url.endsWith('/123456/messages')) {
      if ((body as { to: string }).to === '491609999999') return new Response(JSON.stringify({ error: { code: 131026, message: 'x' } }), { status: 400 });
      return ok({ messages: [{ id: `wamid.${calls.length}` }] });
    }
    if (url === 'https://lookaside.test/img-1') return new Response('JPEG', { status: 200 });
    if (url.endsWith('/img-1')) return ok({ url: 'https://lookaside.test/img-1', mime_type: 'image/jpeg' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function fakeHooks(): HookSource & { fns: Map<HookKind, (e: RelayHookEvent) => Promise<void>> } {
  const fns = new Map<HookKind, (e: RelayHookEvent) => Promise<void>>();
  return {
    enabled: true,
    fns,
    register: async (kind) => ({ kind, url: `https://relay.test/h/${kind}`, verifyToken: 'vt' }),
    subscribe: (kind, fn) => (fns.set(kind, fn), () => fns.delete(kind)),
  };
}

let adapter: WhatsAppCloudAdapter;
afterEach(async () => adapter?.stop());

async function start(template = '') {
  const graph = fakeGraph();
  const hooks = fakeHooks();
  const bus = new MessengerBus();
  const messages: IncomingChat[] = [];
  const receipts: ChatReceipt[] = [];
  bus.onMessage((m) => messages.push(m));
  bus.onReceipt((r) => receipts.push(r));
  adapter = new WhatsAppCloudAdapter(
    { phoneNumberId: '123456', accessToken: 'tok', appSecret: SECRET, templateName: template, templateLanguage: 'de', templateHasText: true, graphUrl: 'https://graph.test/v21.0' },
    bus,
    hooks,
    graph.fetchFn,
  );
  await adapter.start({ log, getState: () => undefined });
  return { graph, hooks, messages, receipts };
}

const event = (body: unknown, signature?: string): RelayHookEvent => {
  const raw = JSON.stringify(body);
  return { seq: 1, kind: 'whatsapp', contentType: 'application/json', signature: signature ?? sign(raw), body: raw, receivedAt: '' };
};

describe('WhatsApp Cloud API', () => {
  it('verbindet, legt den Webhook an und nimmt Nachrichten mit gültiger Signatur an', async () => {
    const { hooks, messages, receipts } = await start();
    expect(adapter.getState()).toMatchObject({ status: 'connected', account: '+491700000000', setup: null, capabilities: { reachability: false } });
    expect(adapter.setupDetails().webhook).toEqual({ kind: 'whatsapp', url: 'https://relay.test/h/whatsapp', verifyToken: 'vt' });
    const value = {
      metadata: { phone_number_id: '123456' },
      contacts: [{ wa_id: '491701234567', profile: { name: 'Max' } }],
      messages: [
        { from: '491701234567', id: 'wamid.in1', timestamp: '1700000000', type: 'text', text: { body: 'Hallo' } },
        { from: '491701234567', id: 'wamid.in2', timestamp: '1700000001', type: 'location', location: { latitude: 52.6, longitude: 8.37, name: 'Marktplatz' } },
        { from: '491701234567', id: 'wamid.in3', timestamp: '1700000002', type: 'image', image: { id: 'img-1', mime_type: 'image/jpeg', caption: 'Lage' } },
      ],
      statuses: [{ id: 'wamid.out1', status: 'read' }, { id: 'wamid.out2', status: 'failed', errors: [{ code: 131047 }] }],
    };
    await hooks.fns.get('whatsapp')!(event({ entry: [{ changes: [{ field: 'messages', value }] }] }));
    expect(messages.map((m) => [m.peer, m.peerName, m.text, m.location?.label ?? null, m.attachment?.data.toString() ?? null])).toEqual([
      ['+491701234567', 'Max', 'Hallo', null, null],
      ['+491701234567', 'Max', '', 'Marktplatz', null],
      ['+491701234567', 'Max', 'Lage', null, 'JPEG'],
    ]);
    expect(messages[0]!.receivedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(receipts).toEqual([
      { channel: 'whatsapp', externalId: 'wamid.out1', status: 'read', error: null },
      { channel: 'whatsapp', externalId: 'wamid.out2', status: 'failed', error: expect.stringMatching(/24 h/) },
    ]);
    // Falsche Signatur oder fremde Nummer: verworfen
    await hooks.fns.get('whatsapp')!(event({ entry: [{ changes: [{ value }] }] }, 'sha256=00'));
    await hooks.fns.get('whatsapp')!(event({ entry: [{ changes: [{ value: { ...value, metadata: { phone_number_id: '999' } } }] }] }));
    expect(messages).toHaveLength(3);
    expect(validSignature(SECRET, 'x', null)).toBe(false);
  });

  it('sendet Text, Bild und Standort im Fenster, außerhalb nur mit Vorlage', async () => {
    const { graph } = await start();
    const dir = mkdtempSync(join(tmpdir(), 'elvis-wa-'));
    try {
      writeFileSync(join(dir, 'f'), 'BILD');
      const r = await adapter.sendMessage({ windowOpen: true, peer: '+491701234567', number: '+491701234567', text: 'Lagebild', attachment: { name: 'a.png', mimeType: 'image/png', path: join(dir, 'f') }, location: { lat: 52.1, lon: 8.2, label: 'Treffpunkt' } });
      expect(r.externalId).toMatch(/^wamid\./);
      await adapter.sendMessage({ windowOpen: true, peer: '+491701234567', number: '+491701234567', text: '', attachment: { name: 'Plan.pdf', mimeType: 'application/pdf', path: join(dir, 'f') }, location: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const posts = graph.calls.filter((c) => c.url.endsWith('/messages')).map((c) => c.body as Record<string, unknown>);
    expect(posts).toEqual([
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: '491701234567', type: 'image', image: { id: 'media-1', caption: 'Lagebild' } },
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: '491701234567', type: 'location', location: { latitude: 52.1, longitude: 8.2, name: 'Treffpunkt' } },
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: '491701234567', type: 'document', document: { id: 'media-1', filename: 'Plan.pdf' } },
    ]);
    await expect(adapter.sendMessage({ windowOpen: true, peer: '+491609999999', number: '+491609999999', text: 'x', attachment: null, location: null })).rejects.toThrow(/nutzt kein WhatsApp/);
    await expect(adapter.sendMessage({ windowOpen: false, peer: '+491701234567', number: '+491701234567', text: 'x', attachment: null, location: null })).rejects.toThrow(/Vorlage/);
  });

  it('sendet außerhalb des Fensters die Vorlage mit dem Text', async () => {
    const { graph } = await start('elvis_nachricht');
    const r = await adapter.sendMessage({ windowOpen: false, peer: '+491701234567', number: '+491701234567', text: 'Bitte\nRückruf', attachment: null, location: null });
    expect(r.info).toMatch(/Vorlage/);
    expect(graph.calls.at(-1)!.body).toMatchObject({ type: 'template', template: { name: 'elvis_nachricht', language: { code: 'de' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Bitte · Rückruf' }] }] } });
  });

  it('meldet fehlende Einstellungen', async () => {
    adapter = new WhatsAppCloudAdapter({ phoneNumberId: '', accessToken: '', appSecret: '', templateName: '', templateLanguage: 'de', templateHasText: true, graphUrl: 'x' }, new MessengerBus(), fakeHooks());
    await adapter.start({ log, getState: () => undefined });
    expect(adapter.getState()).toMatchObject({ status: 'setup', setup: { step: 'info' } });
  });
});
