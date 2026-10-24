import { z } from 'zod';
import { renderPlaceholders, type PlaceholderBags } from './template';

/**
 * Addon-Manifest (addon.yaml). Client (Formular) und Server (Installation) prüfen mit
 * denselben Schemata, damit das erzeugte Formular genau das verlangt, was installiert wird.
 */

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'nur Kleinbuchstaben, Ziffern und Bindestriche');
/** Werte dürfen Platzhalter wie {{options.port}} enthalten. */
const templated = z.string().max(2000);

const optionBase = {
  label: z.string().min(1).max(80),
  help: z.string().max(300).optional(),
  required: z.boolean().default(false),
};

export const addonOptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), ...optionBase, default: z.string().optional(), pattern: z.string().optional(), maxLength: z.number().int().positive().optional() }),
  z.object({ type: z.literal('password'), ...optionBase }),
  z.object({ type: z.literal('int'), ...optionBase, default: z.number().int().optional(), min: z.number().int().optional(), max: z.number().int().optional() }),
  z.object({ type: z.literal('bool'), ...optionBase, default: z.boolean().optional() }),
  z.object({
    type: z.literal('select'),
    ...optionBase,
    choices: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).min(1),
    default: z.string().optional(),
  }),
  z.object({ type: z.literal('ip'), ...optionBase, default: z.string().optional() }),
  /** Serielle Schnittstelle: Auswahl aus den am Server erkannten Geräten oder freier Pfad. */
  z.object({ type: z.literal('serialport'), ...optionBase, default: z.string().optional() }),
  z.object({
    type: z.literal('multiselect'),
    ...optionBase,
    choices: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).min(1),
    default: z.array(z.string()).default([]),
  }),
]);

export type AddonOption = z.infer<typeof addonOptionSchema>;

const volumeSchema = z.object({
  /** Benanntes Volume je Addon (elvis-addon-<id>-<name>), bleibt bei Updates erhalten. */
  name: slug,
  target: z.string().startsWith('/'),
  readOnly: z.boolean().default(false),
});

/** Bedingung auf eine Option, z. B. { option: 'encoder', equals: 'vaapi' } */
const whenSchema = z.object({ option: z.string().min(1), equals: z.union([z.string(), z.array(z.string()).min(1)]) });
export type AddonCondition = z.infer<typeof whenSchema>;

export function conditionMet(when: AddonCondition | undefined, options: OptionValues): boolean {
  if (!when) return true;
  const value = String(options[when.option] ?? '');
  return Array.isArray(when.equals) ? when.equals.includes(value) : when.equals === value;
}

const runSpec = {
  /** Image aus einer Registry oder „build:<name>“ für ein vom Addon gebautes Image (siehe builds) */
  image: z.string().min(1),
  command: z.array(templated).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), templated).default({}),
  volumes: z.array(volumeSchema).default([]),
  network: z.enum(['bridge', 'host']).default('bridge'),
  capabilities: z.array(z.string().regex(/^[A-Z_]+$/)).default([]),
  /** Geräte des Hosts durchreichen, z. B. /dev/dri für VA-API – optional nur bei passender Option */
  devices: z.array(z.object({ path: z.string().regex(/^\/dev\/[\w./-]+$/, 'Gerätepfad unter /dev'), when: whenSchema.optional() })).default([]),
  /** NVIDIA-GPU anfordern (NVIDIA Container Toolkit auf dem Host nötig) – optional nur bei passender Option */
  gpus: z.object({ when: whenSchema.optional() }).optional(),
  /** Größe von /dev/shm, z. B. "1g" oder "{{options.shm}}" (Docker-Vorgabe 64 MB; PostgreSQL braucht oft mehr) */
  shmSize: templated.optional(),
  /** AppArmor-Profil des Containers: „unconfined“ z. B. für Systemabbilder (mount im chroot) – wird vor der Installation angezeigt */
  apparmor: z.enum(['default', 'unconfined']).default('default'),
};

const containerSchema = z.object({
  name: slug,
  ...runSpec,
  ports: z
    .array(
      z.object({
        container: z.number().int().min(1).max(65535),
        /** Feste Nummer oder Platzhalter, z. B. "{{options.port}}". */
        host: z.union([z.number().int().min(1).max(65535), templated]),
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
      }),
    )
    .default([]),
  restart: z.enum(['no', 'unless-stopped', 'always']).default('unless-stopped'),
  /** Container erst starten, wenn dieser Job einmal erfolgreich gelaufen ist (z. B. Daten erzeugen). */
  waitForJob: slug.optional(),
});

/**
 * Fortschritt eines Schritts. Ohne Angabe gelten Zeilen „ELVIS_PROGRESS <prozent> [text]“ im Protokoll.
 * Mit `phases` werden Logzeilen fremder Programme Phasen mit Startprozent zugeordnet.
 */
const progressSchema = z.object({
  phases: z
    .array(
      z.object({
        // Wird zu new RegExp(match) – ungültige Muster (z. B. „(?i)“) schon beim Laden des Manifests melden
        match: z
          .string()
          .min(1)
          .refine((m) => {
            try {
              new RegExp(m);
              return true;
            } catch {
              return false;
            }
          }, 'Ungültiger regulärer Ausdruck (JavaScript-Syntax)'),
        percent: z.number().min(0).max(100),
        label: z.string().max(80).optional(),
      }),
    )
    .default([]),
  /** Prozentangaben in Logzeilen („42%“) verfeinern den Fortschritt innerhalb einer Phase. */
  inlinePercent: z.boolean().default(false),
});

const stepSchema = z.object({
  label: z.string().min(1).max(80),
  ...runSpec,
  /** Anteil am Gesamtfortschritt des Jobs. */
  weight: z.number().positive().default(1),
  progress: progressSchema.optional(),
});

const jobSchema = z
  .object({
    label: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    // Einfacher Job: ein Container …
    image: z.string().min(1).optional(),
    command: runSpec.command,
    env: runSpec.env,
    volumes: runSpec.volumes,
    network: runSpec.network,
    capabilities: runSpec.capabilities,
    apparmor: runSpec.apparmor,
    devices: runSpec.devices,
    gpus: runSpec.gpus,
    shmSize: runSpec.shmSize,
    progress: progressSchema.optional(),
    // … oder mehrere Schritte nacheinander
    steps: z.array(stepSchema).min(1).optional(),
    /** Zeitplan; `interval` darf Platzhalter enthalten und ergibt never|daily|weekly|monthly. */
    schedule: z.object({ interval: templated, hour: z.union([z.number().int().min(0).max(23), templated]).default(3) }).optional(),
    /** Nach der Installation automatisch ausführen. */
    runOnInstall: z.boolean().default(false),
    /** Nach erfolgreichem Lauf die Container des Addons (neu) starten. */
    restartAfter: z.boolean().default(false),
  })
  .refine((j) => !!j.image !== !!j.steps, { message: 'Job braucht entweder image oder steps' });

/**
 * Videoquellen eines Gateways (z. B. NDI): ELVIS fragt die Status-Adresse ab (JSON mit streams[].path) und
 * bindet die Ströme per WebRTC ein (MediaMTX-Player unter <webrtc>/<path>).
 */
const videoSourceProvision = z.object({
  id: slug,
  name: z.string().min(1),
  /** Status als JSON, z. B. http://{{host.address}}:8890/status.json */
  status: templated,
  /** WebRTC-Basisadresse, z. B. http://{{host.address}}:8889 */
  webrtc: templated,
});

const mapSourceProvision = z.object({
  id: slug,
  name: z.string().min(1),
  /** XYZ-Vorlage; {{…}} wird beim Installieren ersetzt, {z}/{x}/{y}/{r} bleiben für den Kachel-Proxy. */
  url: templated,
  attribution: z.string().default(''),
  maxZoom: z.number().int().min(1).max(22).default(18),
  pixelRatio: z.union([z.literal(1), z.literal(2)]).default(1),
  /** Verwendungszweck: Standard, Dunkelmodus oder Druck. */
  variant: z.enum(['light', 'dark', 'print']).optional(),
});

/** Ortssuche: Photon (GET <url>/api?q=…) oder Nominatim (GET <url>/search, Umrisse über /lookup) */
const geocoderProvision = z.object({
  id: slug,
  name: z.string().min(1),
  type: z.enum(['photon', 'nominatim']).default('photon'),
  /** Basisadresse, z. B. http://{{host.address}}:8088 */
  url: templated,
});

/** Office-Server mit WOPI (Collabora Online): Dokumente im Browser bearbeiten */
const officeProvision = z.object({
  id: slug,
  name: z.string().min(1),
  /** Adresse, unter der Browser den Office-Server erreichen, z. B. http://{{host.address}}:9980 */
  url: templated,
  /** Adresse von ELVIS aus Sicht des Office-Servers (WOPI-Rückrufe), z. B. {{options.elvisUrl}} */
  wopiBase: templated,
});

/** Druckserver mit IPP (CUPS): ELVIS listet dessen Drucker und reicht Druckaufträge weiter */
const printServerProvision = z.object({
  id: slug,
  name: z.string().min(1),
  /** IPP-Adresse aus Sicht von ELVIS, z. B. http://{{host.address}}:{{options.port}} */
  url: templated,
});

/**
 * Gastdrucker: virtueller Drucker im Gastnetz, der Aufträge als PDF an ELVIS schickt
 * (POST /api/printing/guest/submit mit „Authorization: Bearer <token>“).
 */
const guestPrinterProvision = z.object({
  id: slug,
  name: z.string().min(1),
  /** Gemeinsames Geheimnis, meist {{addon.secret}} – dasselbe bekommt der Container per Umgebungsvariable */
  token: templated,
});

/**
 * Arbeitsplätze: der PXE-Installer des Addons registriert neue Notebooks bei ELVIS
 * (POST /api/clients/enroll mit „Authorization: Bearer <token>“).
 */
const workstationProvision = z.object({
  id: slug,
  name: z.string().min(1),
  /** Gemeinsames Geheimnis, meist {{addon.secret}} */
  token: templated,
  /** Download der Installer-ISO für den Browser, z. B. http://{{host.address}}:{{options.httpPort}}/iso/elvis-installer.iso */
  installerIso: templated.optional(),
  /** apt-Proxy für Updates der Arbeitsplätze, z. B. http://{{host.address}}:{{options.aptCachePort}} */
  aptProxy: templated.optional(),
});

export const addonManifestSchema = z
  .object({
    id: slug,
    name: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+([-+][\w.]+)?$/, 'Version im Format 1.2.3'),
    description: z.string().max(500).default(''),
    icon: z.string().max(40).optional(),
    url: z.string().url().optional(),
    arch: z.array(z.enum(['amd64', 'arm64'])).min(1).default(['amd64', 'arm64']),
    options: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]*$/), addonOptionSchema).default({}),
    containers: z.array(containerSchema).min(1),
    jobs: z.record(slug, jobSchema).default({}),
    provides: z
      .object({
        mapSources: z.array(mapSourceProvision).default([]),
        videoSources: z.array(videoSourceProvision).default([]),
        geocoders: z.array(geocoderProvision).default([]),
        office: z.array(officeProvision).default([]),
        printServers: z.array(printServerProvision).default([]),
        guestPrinters: z.array(guestPrinterProvision).default([]),
        workstations: z.array(workstationProvision).default([]),
      })
      .default({}),
    /**
     * Images, die ELVIS beim Installieren auf dem Zielhost aus dem Addon baut (Docker-API). Kontext ist ein
     * Unterordner von files/; Container und Job-Schritte verweisen mit „build:<name>“ darauf.
     */
    builds: z
      .record(
        slug,
        z.object({
          context: z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/, 'relativer Pfad ohne ..'),
          files: z.array(z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/, 'relativer Pfad ohne ..')).min(1),
          /** grobe Bauzeit für den Hinweis in der Oberfläche */
          label: z.string().max(80).optional(),
        }),
      )
      .default({}),
    /** Dateien aus dem Unterordner files/ des Addons, die vor dem Start ins Volume kopiert werden (Skripte, Stile …). */
    files: z
      .object({
        volume: slug,
        target: z.string().startsWith('/'),
        paths: z.array(z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/, 'relativer Pfad ohne ..')).min(1),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    const names = m.containers.map((c) => c.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Containernamen müssen eindeutig sein', path: ['containers'] });
    for (const c of m.containers) {
      if (c.waitForJob && !m.jobs[c.waitForJob]) ctx.addIssue({ code: 'custom', message: `Unbekannter Job „${c.waitForJob}“`, path: ['containers'] });
    }
    const runs = [...m.containers, ...Object.values(m.jobs).flatMap((j) => (j.steps ?? []) as { image: string }[]), ...Object.values(m.jobs).filter((j) => j.image).map((j) => ({ image: j.image! }))];
    for (const r of runs) {
      const ref = /^build:(.+)$/.exec(r.image);
      if (ref && !m.builds[ref[1]!]) ctx.addIssue({ code: 'custom', message: `Unbekanntes Build-Image „${ref[1]}“`, path: ['builds'] });
    }
    if (Object.keys(m.builds).length && !m.files) ctx.addIssue({ code: 'custom', message: 'builds braucht files (Dateien des Build-Kontexts)', path: ['builds'] });
  });

export type AddonManifest = z.infer<typeof addonManifestSchema>;
export type AddonContainer = AddonManifest['containers'][number];
export type AddonJob = AddonManifest['jobs'][string];
export type AddonJobStep = z.infer<typeof stepSchema>;
export type AddonProgressSpec = z.infer<typeof progressSchema>;

/** Schritte eines Jobs – ein einfacher Job ist ein einzelner Schritt. */
export function jobSteps(j: AddonJob): AddonJobStep[] {
  if (j.steps) return j.steps;
  return [{ label: j.label, image: j.image!, command: j.command, env: j.env, volumes: j.volumes, network: j.network, capabilities: j.capabilities, devices: j.devices, gpus: j.gpus, shmSize: j.shmSize, apparmor: j.apparmor, weight: 1, progress: j.progress }];
}

/** Versionsvergleich „1.2.3“ (Zusätze wie „-beta“ zählen niedriger als die reine Version): <0, 0, >0 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split(/[-+]/, 2);
    return { nums: core!.split('.').map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  return x.pre === null ? 1 : y.pre === null ? -1 : x.pre.localeCompare(y.pre);
}

export type ScheduleInterval = 'never' | 'daily' | 'weekly' | 'monthly';
export const SCHEDULE_INTERVALS: ScheduleInterval[] = ['never', 'daily', 'weekly', 'monthly'];

export const repositorySchema = z.object({
  name: z.string().min(1),
  maintainer: z.string().optional(),
  url: z.string().optional(),
  /** Verzeichnisnamen der Addons (GitHub-Raw-URLs lassen sich nicht auflisten). */
  addons: z.array(slug).default([]),
});

export type AddonRepository = z.infer<typeof repositorySchema>;

// --- Optionen ---

export type OptionValues = Record<string, string | number | boolean | string[]>;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function optionValueSchema(o: AddonOption): z.ZodTypeAny {
  switch (o.type) {
    case 'string': {
      let s = z.string();
      if (o.maxLength) s = s.max(o.maxLength);
      if (o.pattern) s = s.regex(new RegExp(o.pattern), 'Format ungültig');
      return o.required ? s.min(1, 'Pflichtfeld') : s;
    }
    case 'password':
      return o.required ? z.string().min(1, 'Pflichtfeld') : z.string();
    case 'int': {
      let n = z.coerce.number().int('Ganze Zahl erforderlich');
      if (o.min !== undefined) n = n.min(o.min, `mindestens ${o.min}`);
      if (o.max !== undefined) n = n.max(o.max, `höchstens ${o.max}`);
      return n;
    }
    case 'bool':
      return z.boolean();
    case 'select': {
      const values = o.choices.map((c) => (typeof c === 'string' ? c : c.value)) as [string, ...string[]];
      return z.enum(values);
    }
    case 'ip':
      return o.required ? z.string().regex(IPV4, 'IPv4-Adresse erwartet') : z.union([z.literal(''), z.string().regex(IPV4, 'IPv4-Adresse erwartet')]);
    case 'serialport':
      return o.required ? z.string().min(1, 'Schnittstelle wählen') : z.string();
    case 'multiselect': {
      const values = o.choices.map((c) => (typeof c === 'string' ? c : c.value)) as [string, ...string[]];
      const arr = z.array(z.enum(values));
      return o.required ? arr.min(1, 'Mindestens eine Auswahl') : arr;
    }
  }
}

/** Prüfschema für die Optionswerte eines Addons. */
export function optionsSchema(options: AddonManifest['options']): z.ZodType<OptionValues> {
  return z.object(Object.fromEntries(Object.entries(options).map(([k, o]) => [k, optionValueSchema(o)]))).strict() as unknown as z.ZodType<OptionValues>;
}

/** Startwerte für das Formular aus den Defaults des Manifests. */
export function defaultOptionValues(options: AddonManifest['options']): OptionValues {
  return Object.fromEntries(
    Object.entries(options).map(([k, o]) => {
      if (o.type === 'bool') return [k, o.default ?? false];
      if (o.type === 'int') return [k, o.default ?? o.min ?? 0];
      if (o.type === 'select') return [k, o.default ?? (typeof o.choices[0] === 'string' ? o.choices[0] : o.choices[0]!.value)];
      if (o.type === 'password') return [k, ''];
      if (o.type === 'multiselect') return [k, o.default];
      return [k, o.default ?? ''];
    }),
  );
}

// --- Platzhalter ---

export interface TemplateContext {
  options: OptionValues;
  /** secret: zufälliges, je Addon festes Geheimnis von ELVIS (z. B. für Rückrufe des Addons an ELVIS) */
  addon: { id: string; version: string; secret?: string };
  host: { address: string; name: string };
}

/** Ersetzt {{options.x}}, {{addon.id}}, {{host.address}} …; unbekannte Platzhalter sind ein Fehler. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return renderPlaceholders(template, ctx as unknown as PlaceholderBags);
}

// --- Rechte ---

export interface RequestedPermission {
  kind: 'host-network' | 'capability' | 'apparmor' | 'port' | 'device' | 'gpu' | 'build';
  detail: string;
}

/** Rechte, die ein Addon auf dem Host beansprucht – wird vor der Installation angezeigt. */
export function requestedPermissions(m: AddonManifest): RequestedPermission[] {
  const out: RequestedPermission[] = [];
  const runs = [
    ...m.containers.map((c) => ({ ...c, label: c.name })),
    ...Object.entries(m.jobs).flatMap(([id, j]) => jobSteps(j).map((s) => ({ ...s, label: `Job ${id} (${s.label})`, ports: [] }))),
  ];
  for (const r of runs) {
    if (r.network === 'host') out.push({ kind: 'host-network', detail: `${r.label}: Netzwerk des Hosts` });
    for (const cap of r.capabilities) out.push({ kind: 'capability', detail: `${r.label}: ${cap}` });
    if (r.apparmor === 'unconfined') out.push({ kind: 'apparmor', detail: `${r.label}: ohne AppArmor-Profil` });
    for (const p of r.ports) out.push({ kind: 'port', detail: `${r.label}: Port ${p.host}/${p.protocol} → ${p.container}` });
    const cond = (w?: AddonCondition) => (w ? ` (wenn ${w.option} = ${Array.isArray(w.equals) ? w.equals.join('/') : w.equals})` : '');
    for (const d of r.devices) out.push({ kind: 'device', detail: `${r.label}: Gerät ${d.path}${cond(d.when)}` });
    if (r.gpus) out.push({ kind: 'gpu', detail: `${r.label}: NVIDIA-GPU${cond(r.gpus.when)}` });
  }
  for (const [name, b] of Object.entries(m.builds)) out.push({ kind: 'build', detail: `Image „${name}“ wird auf dem Host gebaut${b.label ? ` (${b.label})` : ''}` });
  return out;
}

// --- API-Typen ---

export type DockerHostStatus = 'pending' | 'ready' | 'unreachable';

export interface DockerHost {
  id: number;
  name: string;
  address: string;
  port: number;
  certMode: 'elvis' | 'custom';
  status: DockerHostStatus;
  error: string | null;
  dockerVersion: string | null;
  arch: 'amd64' | 'arm64' | null;
  os: string | null;
  addonCount: number;
  certExpiresAt: string | null;
  checkedAt: string | null;
}

export interface HostSetup {
  host: DockerHost;
  command: string;
  expiresAt: string;
}

export interface AddonStoreEntry {
  repository: { id: string; name: string; url: string | null };
  manifest: AddonManifest | null;
  /** Gesetzt, wenn das Manifest ungültig ist. */
  error: string | null;
  addonDir: string;
  installedVersion: string | null;
}

export type AddonStatus = 'installing' | 'running' | 'stopped' | 'partial' | 'waiting' | 'error' | 'updating' | 'removing';

export interface AddonStep {
  label: string;
  state: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
}

export interface AddonOperation {
  kind: 'install' | 'reconfigure' | 'update' | 'uninstall' | 'job';
  label: string;
  steps: AddonStep[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface AddonContainerState {
  name: string;
  state: string;
  status: string;
}

export interface AddonJobStepState {
  label: string;
  state: 'pending' | 'running' | 'done' | 'error';
  /** null = Fortschritt unbekannt (unbestimmter Balken). */
  percent: number | null;
  message: string | null;
}

export interface AddonJobState {
  id: string;
  label: string;
  description?: string;
  state: 'idle' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  triggeredBy: string | null;
  /** Gesamtfortschritt 0–100 (gewichtet über die Schritte), null = unbekannt. */
  percent: number | null;
  steps: AddonJobStepState[];
  schedule: { interval: ScheduleInterval; hour: number; nextRun: string | null } | null;
  lastSuccessAt: string | null;
}

export interface InstalledAddon {
  id: string;
  name: string;
  repositoryId: string;
  hostId: number;
  hostName: string;
  version: string;
  availableVersion: string | null;
  /** Passwörter werden nie ausgeliefert; gesetzte Passwortfelder stehen in secretsSet. */
  options: OptionValues;
  secretsSet: string[];
  status: AddonStatus;
  error: string | null;
  containers: AddonContainerState[];
  jobs: AddonJobState[];
  operation: AddonOperation | null;
  manifest: AddonManifest | null;
  installedAt: string;
  updatedAt: string;
}
