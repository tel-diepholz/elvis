import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compareVersions } from '@elvis/shared';
import { loadConfig } from '../config.js';
import { RepoService } from './repos.js';

const BUILTIN = fileURLToPath(new URL('../../../../addons', import.meta.url));
let server: Server | null = null;
afterEach(() => server?.close());

/** Online-Repo nachbilden: das eingebaute Hello-Addon mit wählbarer Version */
async function onlineRepo(helloVersion: string): Promise<string> {
  const hello = readFileSync(`${BUILTIN}/hello/addon.yaml`, 'utf8').replace(/^version: .*$/m, `version: ${helloVersion}`);
  server = createServer((req, res) => {
    if (req.url === '/repository.yaml') return res.end('name: ELVIS-Addons (online)\naddons: [hello]\n');
    if (req.url === '/hello/addon.yaml') return res.end(hello);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('Addon-Repositories', () => {
  it('vergleicht Versionen numerisch, Vorabversionen zählen niedriger', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.2', '1.0.2')).toBe(0);
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
  });

  it('nimmt bei gleicher ID die höhere Version, bei Gleichstand das eingebaute Repo (offline)', async () => {
    const newer = new RepoService({ builtinDir: BUILTIN, repositories: [await onlineRepo('1.5.0')] }, ':memory:');
    await newer.refresh();
    const hello = newer.list().filter((e) => e.manifest?.id === 'hello');
    expect(hello).toHaveLength(1);
    expect(hello[0]).toMatchObject({ manifest: { version: '1.5.0' }, location: { kind: 'remote' } });
    // die übrigen eingebauten Addons bleiben erhalten
    expect(newer.list().map((e) => e.manifest?.id)).toEqual(expect.arrayContaining(['kartenserver', 'ndi-gateway']));
    server!.close();

    const same = new RepoService({ builtinDir: BUILTIN, repositories: [await onlineRepo('1.0.0')] }, ':memory:');
    await same.refresh();
    expect(same.list().filter((e) => e.manifest?.id === 'hello')[0]).toMatchObject({ location: { kind: 'local' } });
  });

  it('übernimmt Online-Repositories aus ELVIS_ADDON_REPOSITORIES', () => {
    const cfg = loadConfig({ ELVIS_CONFIG: '/gibt/es/nicht.json', ELVIS_ADDON_REPOSITORIES: 'https://example.org/a, https://example.org/b' });
    expect(cfg.addons.repositories).toEqual(['https://example.org/a', 'https://example.org/b']);
  });
});
