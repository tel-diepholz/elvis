import type { ContainerCreateOptions } from 'dockerode';
import { conditionMet, jobSteps, renderTemplate, type AddonContainer, type AddonJobStep, type AddonManifest, type TemplateContext } from '@elvis/shared';

export const LABEL_MANAGED = 'elvis.managed';
export const LABEL_ADDON = 'elvis.addon';
export const LABEL_VERSION = 'elvis.addon.version';
export const LABEL_CONTAINER = 'elvis.addon.container';
export const LABEL_JOB = 'elvis.addon.job';
export const LABEL_STEP = 'elvis.addon.step';

/** Kleines Image für Hilfscontainer (Dateien ins Volume kopieren). */
export const HELPER_IMAGE = 'alpine:3.20';

export const containerName = (addonId: string, name: string) => `elvis-${addonId}-${name}`;
export const jobStepName = (addonId: string, jobId: string, step: number) => `elvis-${addonId}-job-${jobId}-${step + 1}`;
export const volumeName = (addonId: string, name: string) => `elvis-addon-${addonId}-${name}`;

const BUILD_PREFIX = 'build:';

/** Tag eines vom Addon gebauten Images (versioniert: neue Addon-Version → neuer Build) */
export const builtImageTag = (m: Pick<AddonManifest, 'id' | 'version'>, name: string) => `elvis-addon-${m.id}-${name}:${m.version}`;

/** „build:<name>“ → Tag des gebauten Images, sonst unverändert */
export const resolveImage = (m: AddonManifest, image: string) => (image.startsWith(BUILD_PREFIX) ? builtImageTag(m, image.slice(BUILD_PREFIX.length)) : image);

/** Namen der Build-Images, auf die Container und Job-Schritte verweisen */
export function addonBuilds(m: AddonManifest): string[] {
  const steps = Object.values(m.jobs).flatMap(jobSteps);
  const refs = [...m.containers.map((c) => c.image), ...steps.map((s) => s.image)].filter((i) => i.startsWith(BUILD_PREFIX));
  return [...new Set(refs.map((i) => i.slice(BUILD_PREFIX.length)))];
}

/** Alle Images aus Registries (Container, Job-Schritte, ggf. Hilfscontainer), ohne Duplikate und ohne Build-Images. */
export function addonImages(m: AddonManifest): string[] {
  const steps = Object.values(m.jobs).flatMap(jobSteps);
  const images = [...m.containers.map((c) => c.image), ...steps.map((s) => s.image)].filter((i) => !i.startsWith(BUILD_PREFIX));
  return [...new Set([...images, ...(m.files ? [HELPER_IMAGE] : [])])];
}

/** Benannte Volumes eines Addons, ohne Duplikate. */
export function addonVolumes(m: AddonManifest): string[] {
  const steps = Object.values(m.jobs).flatMap(jobSteps);
  const names = [...m.containers.flatMap((c) => c.volumes), ...steps.flatMap((s) => s.volumes)].map((v) => v.name);
  if (m.files) names.push(m.files.volume);
  return [...new Set(names)].map((n) => volumeName(m.id, n));
}

const SHM_UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** "512m", "2g" → Bytes */
export function parseShmSize(value: string): number {
  const m = /^(\d+)\s*([kmg]?)b?$/i.exec(value.trim());
  if (!m) throw new Error(`Ungültige shmSize: ${value}`);
  return Number(m[1]) * SHM_UNITS[m[2]!.toLowerCase()]!;
}

function baseSpec(m: AddonManifest, run: AddonContainer | AddonJobStep, ctx: TemplateContext, labels: Record<string, string>): ContainerCreateOptions {
  const r = (s: string) => renderTemplate(s, ctx);
  const devices = run.devices.filter((d) => conditionMet(d.when, ctx.options));
  const gpu = run.gpus && conditionMet(run.gpus.when, ctx.options);
  return {
    Image: resolveImage(m, run.image),
    Cmd: run.command?.map(r),
    Env: Object.entries(run.env).map(([k, v]) => `${k}=${r(v)}`),
    Labels: { [LABEL_MANAGED]: 'true', [LABEL_ADDON]: m.id, [LABEL_VERSION]: m.version, ...labels },
    HostConfig: {
      Binds: run.volumes.map((v) => `${volumeName(m.id, v.name)}:${v.target}${v.readOnly ? ':ro' : ''}`),
      NetworkMode: run.network,
      CapAdd: run.capabilities.length ? run.capabilities : undefined,
      Devices: devices.length ? devices.map((d) => ({ PathOnHost: d.path, PathInContainer: d.path, CgroupPermissions: 'rwm' })) : undefined,
      // NVIDIA: alle GPUs mit Video-Encoder (NVIDIA Container Toolkit auf dem Host)
      DeviceRequests: gpu ? [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu', 'video', 'compute', 'utility']] }] : undefined,
      ShmSize: run.shmSize ? parseShmSize(r(run.shmSize)) : undefined,
      Privileged: false,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
}

export function containerSpec(m: AddonManifest, c: AddonContainer, ctx: TemplateContext): ContainerCreateOptions & { name: string } {
  const spec = baseSpec(m, c, ctx, { [LABEL_CONTAINER]: c.name });
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostPort: string }[]> = {};
  for (const p of c.ports) {
    const hostPort = typeof p.host === 'number' ? p.host : Number(renderTemplate(p.host, ctx));
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error(`Ungültiger Host-Port für ${c.name}: ${String(p.host)}`);
    const key = `${p.container}/${p.protocol}`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: String(hostPort) }];
  }
  return {
    ...spec,
    name: containerName(m.id, c.name),
    ExposedPorts: c.network === 'host' ? undefined : exposed,
    HostConfig: {
      ...spec.HostConfig,
      PortBindings: c.network === 'host' ? undefined : bindings,
      RestartPolicy: { Name: c.restart === 'no' ? '' : c.restart },
    },
  };
}

export function jobStepSpec(m: AddonManifest, jobId: string, step: number, ctx: TemplateContext): ContainerCreateOptions & { name: string } {
  const job = m.jobs[jobId];
  if (!job) throw new Error(`Unbekannter Job ${jobId}`);
  const s = jobSteps(job)[step];
  if (!s) throw new Error(`Job ${jobId} hat keinen Schritt ${step + 1}`);
  return { ...baseSpec(m, s, ctx, { [LABEL_JOB]: jobId, [LABEL_STEP]: String(step + 1) }), name: jobStepName(m.id, jobId, step) };
}

/**
 * Docker liefert Logs ohne TTY als Multiplex-Strom: je Block 8 Byte Kopf (Stream-Typ, 3 × 0,
 * Länge als uint32 BE), danach die Nutzdaten.
 */
export function demuxLogs(buf: Buffer): string {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i]!;
    const len = buf.readUInt32BE(i + 4);
    if (type > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) return buf.toString('utf8'); // kein Multiplex (TTY)
    out.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }
  return Buffer.concat(out).toString('utf8');
}
