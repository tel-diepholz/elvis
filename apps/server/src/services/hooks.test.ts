import { describe, expect, it } from 'vitest';
import type { RelayHookEvent } from '@elvis/shared';
import { openDb } from '../db/index.js';
import { HookService } from './hooks.js';
import { RelayClient, type RelayFetch } from './relay.js';

const log = { info: () => {}, warn: () => {}, error: () => {} };

describe('Webhooks über das Relay', () => {
  it('holt Aufrufe ab, verteilt sie je Art und schreibt den Cursor fort', async () => {
    const db = openDb(':memory:');
    const pending: RelayHookEvent[] = [
      { seq: 3, kind: 'whatsapp', contentType: 'application/json', signature: 's', body: '{}', receivedAt: 't' },
      { seq: 4, kind: 'threema', contentType: 'x', signature: null, body: 'a=1', receivedAt: 't' },
    ];
    const requests: string[] = [];
    const relayFetch: RelayFetch = async (url, { method }) => {
      const path = new URL(url).pathname + new URL(url).search;
      requests.push(`${method} ${path}`);
      if (path === '/v1/elws') return { status: 201, body: { elwId: 'elw-1', token: 'tok' } };
      if (path === '/v1/elws/me/hooks') return { status: 200, body: { kind: 'whatsapp', url: 'https://relay.test/h/x', verifyToken: 'vt' } };
      const after = Number(new URL(url).searchParams.get('after'));
      const items = pending.filter((e) => e.seq > after);
      return { status: 200, body: { items, next: items.at(-1)?.seq ?? after } };
    };
    const hooks = new HookService(db, new RelayClient(db, 'https://relay.test', relayFetch), log, 60_000);
    expect(await hooks.register('whatsapp')).toMatchObject({ url: 'https://relay.test/h/x' });

    const wa: RelayHookEvent[] = [];
    const unsubscribe = hooks.subscribe('whatsapp', async (e) => void wa.push(e));
    // Ein fehlerhafter Treiber hält die anderen Aufrufe nicht auf
    hooks.subscribe('threema', async () => {
      throw new Error('kaputt');
    });
    await hooks.poll();
    expect(wa.map((e) => e.seq)).toEqual([3]);
    expect(requests).toContain('GET /v1/elws/me/hooks/events?after=0');
    await hooks.poll();
    expect(requests.at(-1)).toBe('GET /v1/elws/me/hooks/events?after=4');
    expect(wa).toHaveLength(1);
    unsubscribe();
    hooks.stop();
    db.close();
  });
});
