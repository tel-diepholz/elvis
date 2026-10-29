import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { addonManifestSchema } from './addons';

const dir = fileURLToPath(new URL('../../../addons/orthophotos/', import.meta.url));
const manifest = addonManifestSchema.parse(parseYaml(readFileSync(`${dir}addon.yaml`, 'utf8')));
const catalog = JSON.parse(readFileSync(`${dir}files/catalog.json`, 'utf8')) as { states: { id: string; portal: string }[] };

describe('Orthophoto-Addon', () => {
  it('hat ein gültiges Manifest mit Kartenquelle', () => {
    expect(manifest.provides.mapSources[0]?.url).toContain('{z}/{x}/{y}');
  });

  it('deckt alle 16 Bundesländer ab und passt zur Optionsliste', () => {
    expect(catalog.states).toHaveLength(16);
    const choices = (manifest.options.states as { choices: (string | { value: string })[] }).choices.map((c) => (typeof c === 'string' ? c : c.value));
    expect([...choices].sort()).toEqual(catalog.states.map((s) => s.id).sort());
    for (const s of catalog.states) expect(s.portal).toMatch(/^https:\/\//);
  });
});
