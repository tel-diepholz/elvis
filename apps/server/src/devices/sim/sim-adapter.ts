import type { DeviceId, DeviceStateMap } from '@elvis/shared';
import { BaseAdapter, type AdapterContext } from '../adapter.js';

export interface SimOptions {
  tickMs?: number;
}

/** Base for simulated devices: drives a periodic tick that evolves the state. */
export abstract class SimAdapter<K extends DeviceId> extends BaseAdapter<K> {
  private timer: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  private readonly tickMs: number;

  protected constructor(id: K, initial: DeviceStateMap[K], opts: SimOptions = {}) {
    super(id, 'sim', initial);
    this.tickMs = opts.tickMs ?? 1000;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      this.tick(dt);
    }, this.tickMs);
  }

  override async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  protected abstract tick(dtSec: number): void;
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const jitter = (amount: number) => (Math.random() * 2 - 1) * amount;
export const round = (v: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
/** Mean-reverting random walk, keeps simulated values plausible over long runs. */
export const drift = (value: number, target: number, noise: number, pull = 0.05) =>
  value + (target - value) * pull + jitter(noise);
