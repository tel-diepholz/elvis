import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(newer.list().map((e) => e.manifest?.id)).toEqual(expect.arrayContaining(['osm-daten', 'ndi-gateway']));
    server!.close();

    const same = new RepoService({ builtinDir: BUILTIN, repositories: [await onlineRepo('1.0.0')] }, ':memory:');
    await same.refresh();
    expect(same.list().filter((e) => e.manifest?.id === 'hello')[0]).toMatchObject({ location: { kind: 'local' } });
  });

  it('übernimmt Online-Repositories aus ELVIS_ADDON_REPOSITORIES', () => {
    const cfg = loadConfig({ ELVIS_CONFIG: '/gibt/es/nicht.json', ELVIS_ADDON_REPOSITORIES: 'https://example.org/a, https://example.org/b' });
    expect(cfg.addons.repositories).toEqual(['https://example.org/a', 'https://example.org/b']);
  });
  it('liest die Anleitung (docs) lokal und online, online auch aus dem Zwischenspeicher', async () => {
    const local = new RepoService({ builtinDir: BUILTIN, repositories: [] }, ':memory:');
    await local.refresh();
    expect(local.docs('signal-cli')).toMatch(/^# Signal \(signal-cli\)/);
    expect(local.docs('signal-cli')).toContain('signalcaptchas.org');
    expect(local.docs('hello')).toBeNull();

    const doc = '# Hallo\n\nAnleitung online';
    const hello = readFileSync(`${BUILTIN}/hello/addon.yaml`, 'utf8').replace(/^version: .*$/m, 'version: 9.0.0').replace(/^arch:/m, 'docs: docs/ANLEITUNG.md\narch:');
    let online = true;
    server = createServer((req, res) => {
      if (!online) return res.writeHead(503).end();
      if (req.url === '/repository.yaml') return res.end('name: Online\naddons: [hello]\n');
      if (req.url === '/hello/addon.yaml') return res.end(hello);
      if (req.url === '/hello/docs/ANLEITUNG.md') return res.end(doc);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const dataDir = mkdtempSync(join(tmpdir(), 'elvis-repo-docs-'));
    try {
      const repo = new RepoService({ builtinDir: null, repositories: [url] }, dataDir);
      await repo.refresh();
      expect(repo.docs('hello')).toBe(doc);
      online = false;
      await repo.refresh();
      expect(repo.docs('hello')).toBe(doc);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
