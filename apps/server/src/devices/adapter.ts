import { z } from 'zod';
import type { DeviceId, DeviceStateMap } from '@elvis/shared';
import { HttpError } from '../errors.js';

export class CommandError extends HttpError {
  constructor(message: string, statusCode = 409) {
    super(statusCode, message);
  }
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface AdapterContext {
  log: Logger;
  /** Read-only access to other devices, e.g. for interlocks (Lichtmast ↔ Feststellbremse). */
  getState<K extends DeviceId>(id: K): DeviceStateMap[K] | undefined;
}

/**
 * Contract every driver implements. Real hardware drivers (Victron/Modbus, CAN-Bus,
 * TETRA-PEI, SNMP, …) implement this the same way the simulators do.
 */
export interface DeviceAdapter<K extends DeviceId = DeviceId> {
  readonly id: K;
  readonly driver: string;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  getState(): DeviceStateMap[K];
  isOnline(): boolean;
  /** Returns an optional human-readable result message; throws CommandError on refusal. */
  execute(action: string, params: unknown): Promise<string | void>;
  onChange(listener: () => void): () => void;
  /** Häufige Befehle, die nicht ins Bedienprotokoll sollen (z. B. Kamerabewegung per Gedrückthalten) */
  isQuiet?(action: string): boolean;
}

export interface Command<P> {
  schema: z.ZodType<P>;
  run(params: P): Promise<string | void> | string | void;
}

export function command<P>(schema: z.ZodType<P>, run: Command<P>['run']): Command<P> {
  return { schema, run };
}

export const noParams = z.object({}).passthrough();

export abstract class BaseAdapter<K extends DeviceId> implements DeviceAdapter<K> {
  protected ctx!: AdapterContext;
  protected online = true;
  private listeners = new Set<() => void>();
  protected abstract readonly commands: Record<string, Command<any>>;

  protected constructor(
    readonly id: K,
    readonly driver: string,
    protected state: DeviceStateMap[K],
  ) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {}

  getState(): DeviceStateMap[K] {
    return this.state;
  }

  isOnline(): boolean {
    return this.online;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(action: string, params: unknown): Promise<string | void> {
    const cmd = this.commands[action];
    if (!cmd) throw new CommandError(`Unbekannte Aktion „${action}“`, 400);
    const parsed = cmd.schema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new CommandError(`Ungültige Parameter: ${parsed.error.issues.map((i) => i.message).join(', ')}`, 400);
    }
    return cmd.run(parsed.data);
  }

  /** Copy-on-write update so published snapshots are never mutated afterwards. */
  protected update(mutate: (draft: DeviceStateMap[K]) => void): void {
    const next = structuredClone(this.state);
    mutate(next);
    this.state = next;
    this.emit();
  }

  protected setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
