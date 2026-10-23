import { PassThrough, Readable } from 'node:stream';
import type Docker from 'dockerode';

/**
 * Minimaler Docker-Daemon im Speicher für Tests – bildet genau die Engine-API-Aufrufe ab,
 * die HostService und AddonManager verwenden.
 */
export interface FakeContainer {
  id: string;
  name: string;
  spec: Record<string, unknown> & { Labels?: Record<string, string>; Env?: string[]; Image?: string; HostConfig?: Record<string, unknown> };
  state: 'created' | 'running' | 'exited';
  logs: string;
  startedAt?: number;
  exitCode: number;
}

export class FakeDocker {
  images = new Set<string>();
  volumes = new Set<string>();
  containers = new Map<string, FakeContainer>();
  pullable = true;
  arch = 'x86_64';
  /** Exit-Code für Job-Container. */
  jobExitCode = 0;
  /** Laufzeit von Job-Containern (für Vorführungen); Protokollzeilen erscheinen verteilt über die Laufzeit. */
  jobDurationMs = 5;
  /** Job-Container geben zusätzlich ELVIS_PROGRESS-Zeilen von 0 bis 100 aus. */
  simulateProgress = false;
  /** Gebaute Images: Tag → Dateien des Build-Kontexts */
  builds: { tag: string; files: string[] }[] = [];
  /** Build schlägt mit dieser Meldung fehl */
  buildError: string | null = null;
  /** Per putArchive hochgeladene Dateien: Volume → Archiv-Einträge. */
  archives: { volume: string; entries: string[] }[] = [];
  private seq = 0;

  constructor(images: string[] = []) {
    images.forEach((i) => this.images.add(i));
  }

  private find(idOrName: string): FakeContainer | undefined {
    return this.containers.get(idOrName) ?? [...this.containers.values()].find((c) => c.name === idOrName);
  }

  private notFound(): Error {
    return Object.assign(new Error('no such container'), { statusCode: 404 });
  }

  asDocker(): Docker {
    const self = this;
    const container = (idOrName: string) => ({
      id: idOrName,
      async start() {
        const c = self.find(idOrName);
        if (!c) throw self.notFound();
        c.state = 'running';
        if (c.spec.Labels?.['elvis.addon.job']) {
          // Job-Container „führen“ ihr Kommando aus: jede Zeile davon erscheint im Protokoll.
          const lines = [...((c.spec as { Cmd?: string[] }).Cmd ?? [])];
          if (self.simulateProgress) for (let p = 10; p <= 100; p += 10) lines.push(`ELVIS_PROGRESS ${p} Simulierter Fortschritt ${p} %`);
          c.logs = `${lines.join('\n')}\n`;
          c.startedAt = Date.now();
          setTimeout(() => (c.state = 'exited'), self.jobDurationMs);
        }
      },
      async stop() {
        const c = self.find(idOrName);
        if (!c) throw self.notFound();
        c.state = 'exited';
      },
      async restart() {
        const c = self.find(idOrName);
        if (!c) throw self.notFound();
        c.state = 'running';
      },
      async remove() {
        const c = self.find(idOrName);
        if (!c) throw self.notFound();
        self.containers.delete(c.id);
      },
      async wait() {
        const c0 = self.find(idOrName);
        await new Promise((r) => setTimeout(r, c0?.spec.Labels?.['elvis.addon.job'] ? self.jobDurationMs + 5 : 10));
        const c = self.find(idOrName);
        return { StatusCode: c?.spec.Labels?.['elvis.addon.job'] ? self.jobExitCode : 0 };
      },
      async logs(opts: { follow?: boolean } = {}) {
        const c = self.find(idOrName);
        if (!c) throw self.notFound();
        // Jede Zeile als eigener Multiplex-Block, wie bei Docker
        const frames = c.logs
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const payload = Buffer.from(`${line}\n`);
            const header = Buffer.alloc(8);
            header[0] = 1;
            header.writeUInt32BE(payload.length, 4);
            return Buffer.concat([header, payload]);
          });
        if (!opts.follow) return Buffer.concat(frames);
        // Zeilen über die Laufzeit verteilt ausgeben, wie ein echter Prozess
        const gap = self.jobDurationMs / Math.max(1, frames.length);
        return Readable.from(
          (async function* () {
            for (const f of frames) {
              yield f;
              await new Promise((r) => setTimeout(r, gap));
            }
          })(),
        );
      },
      async putArchive(data: Buffer, opts: { path: string }) {
        const c = self.find(idOrName);
        if (!c) throw self.notFound();
        const bind = (c.spec.HostConfig?.Binds as string[] | undefined)?.find((b) => b.split(':')[1] === opts.path);
        self.archives.push({ volume: bind?.split(':')[0] ?? '?', entries: tarNames(data) });
      },
    });

    return {
      modem: {
        /** wie docker-modem: JSON-Zeilen als Fortschritt, ein „error“-Eintrag bricht ab */
        followProgress(stream: NodeJS.ReadableStream, done: (err: unknown) => void, onProgress?: (evt: Record<string, string>) => void) {
          let buf = '';
          let error: string | null = null;
          stream.on('data', (chunk: Buffer | string) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const evt = JSON.parse(line) as Record<string, string>;
                onProgress?.(evt);
                if (evt.error) error = evt.error;
              } catch {
                /* keine JSON-Zeile */
              }
            }
          });
          stream.on('end', () => done(error));
          stream.on('error', (e: Error) => done(e));
        },
        demuxStream(stream: NodeJS.ReadableStream, out: NodeJS.WritableStream) {
          stream.on('data', (chunk: Buffer) => {
            for (let i = 0; i + 8 <= chunk.length; ) {
              const len = chunk.readUInt32BE(i + 4);
              out.write(chunk.subarray(i + 8, i + 8 + len));
              i += 8 + len;
            }
          });
        },
      },
      async version() {
        return { Version: '27.3.1' };
      },
      async info() {
        return { Architecture: self.arch, OperatingSystem: 'Debian GNU/Linux 12 (bookworm)' };
      },
      getImage(name: string) {
        return {
          async inspect() {
            if (!self.images.has(name)) throw Object.assign(new Error('no such image'), { statusCode: 404 });
            return { Id: name };
          },
          async get() {
            return Readable.from([Buffer.from(`TAR:${name}`)]);
          },
        };
      },
      pull(name: string, cb: (err: Error | null, stream?: NodeJS.ReadableStream) => void) {
        if (!self.pullable) return cb(new Error('pull access denied / no internet'));
        self.images.add(name);
        cb(null, Readable.from(['{"status":"done"}']));
      },
      async buildImage(context: NodeJS.ReadableStream, opts: { t: string }) {
        const chunks: Buffer[] = [];
        for await (const c of context as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
        // Dateinamen aus den tar-Köpfen (512-Byte-Blöcke, Name in den ersten 100 Byte)
        const tar = Buffer.concat(chunks);
        const files: string[] = [];
        for (let i = 0; i + 512 <= tar.length; ) {
          const name = tar.subarray(i, i + 100).toString().replace(/\0.*$/s, '');
          if (!name) break;
          const size = parseInt(tar.subarray(i + 124, i + 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
          files.push(name);
          i += 512 + Math.ceil(size / 512) * 512;
        }
        const out = new PassThrough();
        if (self.buildError) {
          out.end(`{"stream":"Step 1/2 : FROM debian\\n"}\n{"error":"${self.buildError}","errorDetail":{"message":"${self.buildError}"}}\n`);
        } else {
          self.images.add(opts.t);
          self.builds.push({ tag: opts.t, files });
          out.end('{"stream":"Step 1/2 : FROM debian\\n"}\n{"stream":"Successfully built"}\n');
        }
        return out;
      },
      async loadImage(stream: NodeJS.ReadableStream) {
        const chunks: Buffer[] = [];
        for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
        const name = Buffer.concat(chunks).toString().replace(/^TAR:/, '');
        self.images.add(name);
        const out = new PassThrough();
        out.end('{"stream":"Loaded image"}');
        return out;
      },
      async createVolume(opts: { Name: string }) {
        self.volumes.add(opts.Name);
        return { name: opts.Name };
      },
      getVolume(name: string) {
        return {
          async remove() {
            self.volumes.delete(name);
          },
        };
      },
      async listContainers(opts: { filters?: { label?: string[] } }) {
        const filters = opts.filters?.label ?? [];
        return [...self.containers.values()]
          .filter((c) =>
            filters.every((f) => {
              const [k, v] = f.split('=');
              const labels = c.spec.Labels ?? {};
              return v === undefined ? k! in labels : labels[k!] === v;
            }),
          )
          .map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.spec.Labels ?? {}, State: c.state, Status: c.state === 'running' ? 'Up 1 second' : 'Exited (0)' }));
      },
      async createContainer(spec: FakeContainer['spec'] & { name: string }) {
        if (!self.images.has(spec.Image!)) throw new Error(`No such image: ${spec.Image}`);
        if (self.find(spec.name)) throw Object.assign(new Error('Conflict. The container name is already in use'), { statusCode: 409 });
        const id = `c${++self.seq}`;
        self.containers.set(id, { id, name: spec.name, spec, state: 'created', logs: 'Starting up on port 8080\n', exitCode: 0 });
        return container(id);
      },
      getContainer: container,
    } as unknown as Docker;
  }

  /** Container zu einem Addon-Containernamen, z. B. elvis-hello-web. */
  byName(name: string): FakeContainer | undefined {
    return this.find(name);
  }
}

/** Dateinamen aus einem (unkomprimierten) Tar-Archiv. */
function tarNames(buf: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i + 512 <= buf.length; ) {
    const name = buf.subarray(i, i + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.subarray(i + 124, i + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    names.push(name);
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}
