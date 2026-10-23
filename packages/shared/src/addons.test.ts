import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { addonManifestSchema, defaultOptionValues, jobSteps, optionsSchema, renderTemplate, requestedPermissions, type AddonManifest } from './addons';

const helloPath = fileURLToPath(new URL('../../../addons/hello/addon.yaml', import.meta.url));
const hello = addonManifestSchema.parse(parseYaml(readFileSync(helloPath, 'utf8')));
const kartenPath = fileURLToPath(new URL('../../../addons/kartenserver/addon.yaml', import.meta.url));
const karten = addonManifestSchema.parse(parseYaml(readFileSync(kartenPath, 'utf8')));

const minimal = { id: 'demo', name: 'Demo', version: '1.0.0', containers: [{ name: 'app', image: 'nginx:1.27' }] };

describe('Addon-Manifest', () => {
  it('akzeptiert das eingebaute Beispiel-Addon', () => {
    expect(hello.id).toBe('hello');
    expect(Object.keys(hello.options)).toEqual(['name', 'port', 'verbose']);
    expect(hello.jobs.stamp?.volumes[0]?.name).toBe('data');
  });

  it('setzt Standardwerte', () => {
    const m = addonManifestSchema.parse(minimal);
    expect(m.arch).toEqual(['amd64', 'arm64']);
    expect(m.containers[0]!.restart).toBe('unless-stopped');
    expect(m.containers[0]!.network).toBe('bridge');
  });

  it('weist ungültige Manifeste ab', () => {
    expect(addonManifestSchema.safeParse({ ...minimal, version: 'eins' }).success).toBe(false);
    expect(addonManifestSchema.safeParse({ ...minimal, id: 'Großbuchstaben' }).success).toBe(false);
    expect(addonManifestSchema.safeParse({ ...minimal, containers: [] }).success).toBe(false);
    expect(addonManifestSchema.safeParse({ ...minimal, containers: [{ name: 'a', image: 'x' }, { name: 'a', image: 'y' }] }).success).toBe(false);
    expect(addonManifestSchema.safeParse({ ...minimal, options: { x: { type: 'farbe', label: 'X' } } }).success).toBe(false);
    // Fortschrittsphasen werden zu JavaScript-Regexen: „(?i)“ gibt es dort nicht
    const job = (match: string) => ({ ...minimal, jobs: { j: { label: 'J', image: 'x', progress: { phases: [{ match, percent: 5 }] } } } });
    expect(addonManifestSchema.safeParse(job('[Rr]ank 26')).success).toBe(true);
    expect(addonManifestSchema.safeParse(job('(?i)rank 26')).success).toBe(false);
  });

  it('akzeptiert alle eingebauten Addons', () => {
    const repo = parseYaml(readFileSync(fileURLToPath(new URL('../../../addons/repository.yaml', import.meta.url)), 'utf8')) as { addons: string[] };
    for (const dir of repo.addons) {
      const parsed = addonManifestSchema.safeParse(parseYaml(readFileSync(fileURLToPath(new URL(`../../../addons/${dir}/addon.yaml`, import.meta.url)), 'utf8')));
      expect(parsed.success, `${dir}: ${parsed.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`).toBe(true);
    }
  });
});

describe('Optionen', () => {
  const schema = optionsSchema(hello.options);

  it('liefert Startwerte aus den Defaults', () => {
    expect(defaultOptionValues(hello.options)).toEqual({ name: 'ELW 2', port: 8099, verbose: false });
  });

  it('prüft Pflichtfelder, Grenzen und Typen', () => {
    expect(schema.safeParse({ name: 'ELW', port: 8100, verbose: true }).success).toBe(true);
    expect(schema.safeParse({ name: '', port: 8100, verbose: true }).success).toBe(false);
    expect(schema.safeParse({ name: 'ELW', port: 80, verbose: true }).success).toBe(false);
    expect(schema.safeParse({ name: 'ELW', port: 8100, verbose: true, extra: 1 }).success).toBe(false);
  });

  it('prüft IP-Adressen und Auswahllisten', () => {
    const s = optionsSchema({
      ip: { type: 'ip', label: 'IP', required: true },
      region: { type: 'select', label: 'Gebiet', required: false, choices: ['thueringen', { value: 'hessen', label: 'Hessen' }] },
    } as AddonManifest['options']);
    expect(s.safeParse({ ip: '10.0.0.5', region: 'hessen' }).success).toBe(true);
    expect(s.safeParse({ ip: '10.0.0.500', region: 'hessen' }).success).toBe(false);
    expect(s.safeParse({ ip: '10.0.0.5', region: 'bayern' }).success).toBe(false);
  });
});

describe('Platzhalter und Rechte', () => {
  const ctx = { options: { name: 'ELW 2', port: 8099 }, addon: { id: 'hello', version: '1.0.0' }, host: { address: '10.0.0.2', name: 'server2' } };

  it('ersetzt Platzhalter und meldet unbekannte', () => {
    expect(renderTemplate('http://{{host.address}}:{{ options.port }}/{z}', ctx)).toBe('http://10.0.0.2:8099/{z}');
    expect(() => renderTemplate('{{options.fehlt}}', ctx)).toThrow(/Unbekannter Platzhalter/);
  });

  it('listet beanspruchte Rechte auf', () => {
    const m = addonManifestSchema.parse({ ...minimal, containers: [{ name: 'vrrp', image: 'x', network: 'host', capabilities: ['NET_ADMIN'] }] });
    expect(requestedPermissions(m).map((p) => p.kind)).toEqual(['host-network', 'capability']);
    expect(requestedPermissions(hello).map((p) => p.detail)).toEqual(['web: Port {{options.port}}/tcp → 8080']);
  });
});

describe('Mehrfachauswahl, Job-Schritte und Zeitplan', () => {
  it('prüft Mehrfachauswahl und setzt sie in Platzhaltern als Liste ein', () => {
    const s = optionsSchema(karten.options);
    const ok = { ...defaultOptionValues(karten.options), regions: ['germany/thueringen', 'germany/hessen'] };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ ...ok, regions: [] }).success).toBe(false);
    expect(s.safeParse({ ...ok, regions: ['atlantis'] }).success).toBe(false);
    const ctx = { options: ok, addon: { id: 'k', version: '1' }, host: { address: 'h', name: 'h' } };
    expect(renderTemplate('{{options.regions}}', ctx)).toBe('germany/thueringen,germany/hessen');
  });

  it('akzeptiert das Kartenserver-Addon mit fünf Schritten, Zeitplan und Kartenvarianten', () => {
    const job = karten.jobs.update!;
    expect(jobSteps(job).map((s) => s.label)).toEqual(['Stile und Schriften', 'Zusatzdaten laden', 'OSM-Daten laden', 'Kacheln erzeugen', 'Neue Daten aktivieren']);
    expect(job).toMatchObject({ runOnInstall: true, restartAfter: true, schedule: { interval: '{{options.updateInterval}}' } });
    expect(karten.containers[0]!.waitForJob).toBe('update');
    expect(karten.provides.mapSources.map((m) => m.variant)).toEqual(['light', 'dark', 'print']);
    expect(karten.files?.paths).toContain('styles/druck.json');
    expect(requestedPermissions(karten).map((p) => p.kind)).toEqual(['port']);
  });

  it('macht aus einem einfachen Job einen einzelnen Schritt und verlangt image oder steps', () => {
    expect(jobSteps(hello.jobs.stamp!)).toHaveLength(1);
    const base = { id: 'x', name: 'X', version: '1.0.0', containers: [{ name: 'a', image: 'i' }] };
    expect(addonManifestSchema.safeParse({ ...base, jobs: { j: { label: 'J' } } }).success).toBe(false);
    expect(addonManifestSchema.safeParse({ ...base, containers: [{ name: 'a', image: 'i', waitForJob: 'fehlt' }] }).success).toBe(false);
    expect(addonManifestSchema.safeParse({ ...base, files: { volume: 'data', target: '/a', paths: ['../etc/passwd'] } }).success).toBe(false);
  });
});
