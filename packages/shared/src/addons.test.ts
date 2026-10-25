import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { addonManifestSchema, defaultOptionValues, jobSteps, optionsSchema, renderTemplate, requestedPermissions, type AddonManifest } from './addons';

const helloPath = fileURLToPath(new URL('../../../addons/hello/addon.yaml', import.meta.url));
const hello = addonManifestSchema.parse(parseYaml(readFileSync(helloPath, 'utf8')));
const osmPath = fileURLToPath(new URL('../../../addons/osm-daten/addon.yaml', import.meta.url));
const osm = addonManifestSchema.parse(parseYaml(readFileSync(osmPath, 'utf8')));

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
    const s = optionsSchema(osm.options);
    const ok = { ...defaultOptionValues(osm.options), regions: ['europe/germany/thueringen', 'europe/luxembourg'] };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ ...ok, regions: ['atlantis'] }).success).toBe(false);
    const ctx = { options: ok, addon: { id: 'k', version: '1' }, host: { address: 'h', name: 'h' } };
    expect(renderTemplate('{{options.regions}}', ctx)).toBe('europe/germany/thueringen,europe/luxembourg');
  });

  it('akzeptiert freie Geofabrik-Pfade als weitere Regionen', () => {
    const s = optionsSchema(osm.options);
    const base = defaultOptionValues(osm.options);
    for (const v of ['', 'africa/mali', 'europe/spain, africa/morocco', 'asia/japan/kanto']) expect(s.safeParse({ ...base, extraRegions: v }).success, v).toBe(true);
    for (const v of ['../etc', 'europe/spain;rm', 'Europe/Spain', 'europe//spain']) expect(s.safeParse({ ...base, extraRegions: v }).success, v).toBe(false);
  });

  it('akzeptiert das OSM-Daten-Addon: ein Bau-Job ohne Zeitplan für alle vier Dienste', () => {
    const job = osm.jobs.build!;
    expect(jobSteps(job).map((s) => s.label)).toEqual([
      'OSM-Daten laden',
      'Stile und Schriften',
      'Zusatzdaten laden',
      'Kacheln erzeugen',
      'Routing bauen',
      'Ortssuche importieren',
      'Overpass bauen',
      'Neue Daten aktivieren',
    ]);
    expect(job).toMatchObject({ runOnInstall: true, restartAfter: true });
    expect(job.schedule).toBeUndefined();
    expect(osm.containers.map((c) => [c.name, c.waitForJob])).toEqual([
      ['tiles', 'build'],
      ['nominatim', 'build'],
      ['valhalla', 'build'],
      ['overpass', 'build'],
    ]);
    expect(jobSteps(job).find((s) => s.label === 'Ortssuche importieren')!.stopContainers).toEqual(['nominatim']);
    expect(osm.provides.mapSources.map((m) => m.variant)).toEqual(['light', 'dark', 'print']);
    expect(osm.provides.geocoders.map((g) => g.type)).toEqual(['nominatim']);
    expect(osm.provides.routers.map((r) => r.type)).toEqual(['valhalla']);
    expect(osm.provides.overpass).toHaveLength(1);
    expect(osm.files?.paths).toContain('styles/druck.json');
    expect(requestedPermissions(osm).map((p) => p.kind)).toEqual(['port', 'port', 'port', 'port']);
  });

  it('prüft die Container in stopContainers', () => {
    const base = { id: 'x', name: 'X', version: '1.0.0', containers: [{ name: 'db', image: 'i' }] };
    const job = (stop: string[]) => ({ ...base, jobs: { j: { label: 'J', steps: [{ label: 'S', image: 'i', stopContainers: stop }] } } });
    expect(addonManifestSchema.safeParse(job(['db'])).success).toBe(true);
    expect(addonManifestSchema.safeParse(job(['fehlt'])).success).toBe(false);
    expect(jobSteps(addonManifestSchema.parse({ ...base, jobs: { j: { label: 'J', image: 'i' } } }).jobs.j!)[0]!.stopContainers).toEqual([]);
  });

  it('macht aus einem einfachen Job einen einzelnen Schritt und verlangt image oder steps', () => {
    expect(jobSteps(hello.jobs.stamp!)).toHaveLength(1);
    const base = { id: 'x', name: 'X', version: '1.0.0', containers: [{ name: 'a', image: 'i' }] };
    expect(addonManifestSchema.safeParse({ ...base, jobs: { j: { label: 'J' } } }).success).toBe(false);
    expect(addonManifestSchema.safeParse({ ...base, containers: [{ name: 'a', image: 'i', waitForJob: 'fehlt' }] }).success).toBe(false);
    expect(addonManifestSchema.safeParse({ ...base, files: { volume: 'data', target: '/a', paths: ['../etc/passwd'] } }).success).toBe(false);
  });
});
