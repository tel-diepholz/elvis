import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { addonManifestSchema } from './addons';

const dir = fileURLToPath(new URL('../../../addons/orthophotos/', import.meta.url));
const manifest = addonManifestSchema.parse(parseYaml(readFileSync(`${dir}addon.yaml`, 'utf8')));

describe('Orthophoto-Addon', () => {
  it('hat ein gültiges Manifest mit Kartenquelle und eigener Oberfläche', () => {
    expect(manifest.provides.mapSources[0]?.url).toContain('/tiles/{z}/{x}/{y}.png');
    expect(manifest.provides.ui?.url).toBe('http://{{host.address}}:{{options.port}}/');
  });

  it('liefert alle Dateien mit, die der Server und die Oberfläche brauchen', () => {
    const paths = manifest.files?.paths ?? [];
    for (const p of paths) expect(existsSync(`${dir}files/${p}`), p).toBe(true);
    const html = readFileSync(`${dir}files/ui/index.html`, 'utf8');
    for (const ref of html.matchAll(/(?:src|href)="([^"]+)"/g)) expect(paths, ref[1]).toContain(`ui/${ref[1]}`);
  });
});
