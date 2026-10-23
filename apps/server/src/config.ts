import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEVICE_IDS, type DeviceId } from '@elvis/shared';

/** Vorgabe je Fahrzeugmodul; in den Systemeinstellungen gespeicherte Werte haben Vorrang. */
const driverSchema = z.object({
  enabled: z.boolean().default(true),
  driver: z.string().default('sim'),
  options: z.record(z.unknown()).default({}),
});

const mapSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  /** XYZ-Vorlage mit {z}, {x}, {y} und optional {s} (Subdomain) bzw. {r} (Retina-Suffix). */
  url: z.string(),
  attribution: z.string(),
  maxZoom: z.number().int().default(19),
  subdomains: z.string().default('abc'),
  /** 2 für hochauflösende Kacheln (512 px je Kachel), verbessert die Druckschärfe. */
  pixelRatio: z.union([z.literal(1), z.literal(2)]).default(1),
  /** Verwendungszweck: Standard, Dunkelmodus oder Druck. */
  variant: z.enum(['light', 'dark', 'print']).optional(),
  /** Kacheln zwischenspeichern (für Quellen im LAN, z. B. Kartenserver-Addon, nicht sinnvoll). */
  cache: z.boolean().default(true),
});

export type MapSourceConfig = z.infer<typeof mapSourceSchema>;

const configSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().default(8080),
  dataDir: z.string().default('./data'),
  /** Built web frontend; served by the backend in production. */
  webDist: z.string().nullable().default(null),
  vehicle: z
    .object({
      name: z.string().default('ELW 2'),
      callsign: z.string().default('Florian Musterstadt 12/11-1'),
      organization: z.string().default('Freiwillige Feuerwehr Musterstadt'),
    })
    .default({}),
  devices: z.record(z.enum(DEVICE_IDS as [DeviceId, ...DeviceId[]]), driverSchema).default({}),
  map: z
    .object({
      sources: z.array(mapSourceSchema).min(1).default([
        {
          id: 'osm',
          name: 'OpenStreetMap',
          url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          attribution: '© OpenStreetMap-Mitwirkende',
          maxZoom: 19,
          subdomains: 'abc',
          pixelRatio: 1,
        },
      ]),
      /** Kacheln älter als diese Anzahl Tage werden neu geladen (offline wird der alte Stand genutzt). */
      cacheMaxAgeDays: z.number().default(30),
      /** Pflichtangabe nach Tile-Usage-Policy von OpenStreetMap. */
      userAgent: z.string().default('ELVIS/0.1 (Einsatzleitwagen-Verwaltungssystem)'),
    })
    .default({}),
  docker: z
    .object({
      /** Docker- und Addon-Verwaltung in ELVIS anbieten. */
      enabled: z.boolean().default(true),
      /** TLS-Port der Docker-Engine-API auf den Hosts. */
      port: z.number().int().default(2376),
    })
    .default({}),
  addons: z
    .object({
      /** Eingebautes Repo; null = automatisch suchen (./addons bzw. ../../addons). */
      builtinDir: z.string().nullable().default(null),
      /** Weitere Repos als Basis-URL (z. B. GitHub-Raw), jeweils mit repository.yaml. */
      repositories: z.array(z.string().url()).default([]),
    })
    .default({}),
  alerts: z
    .object({
      stormWarnMs: z.number().default(17),
    })
    .default({}),
});

export type ElvisConfig = z.infer<typeof configSchema>;

/**
 * Loads config from the JSON file in ELVIS_CONFIG (default ./config/elvis.json, optional),
 * then applies environment overrides.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ElvisConfig {
  const file = resolve(env.ELVIS_CONFIG ?? 'config/elvis.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return configSchema.parse({
    ...fromFile,
    ...(env.HOST && { host: env.HOST }),
    ...(env.PORT && { port: env.PORT }),
    ...(env.ELVIS_DATA_DIR && { dataDir: env.ELVIS_DATA_DIR }),
    ...(env.ELVIS_WEB_DIST && { webDist: env.ELVIS_WEB_DIST }),
    ...(env.ELVIS_ADDONS_DIR && { addons: { ...fromFile.addons, builtinDir: env.ELVIS_ADDONS_DIR } }),
  });
}

export function parseConfig(input: unknown): ElvisConfig {
  return configSchema.parse(input);
}
