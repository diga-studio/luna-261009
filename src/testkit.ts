import type { GatewayRequest, Scheduler } from "./types.js";

interface FakeTimer {
  at: number;
  cb: () => void;
}

export class FakeScheduler implements Scheduler {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, FakeTimer>();

  now(): number {
    return this.time;
  }

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Move the clock without firing any timers. */
  setTime(t: number): void {
    this.time = t;
  }

  /** Fire every timer whose deadline is <= current time, in due order. */
  runDue(): void {
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= this.time && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId < 0) return;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      timer.cb();
    }
  }

  advanceBy(ms: number): void {
    this.time += ms;
    this.runDue();
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

export class ManualExecute {
  readonly calls: GatewayRequest[] = [];
  readonly signals: AbortSignal[] = [];
  private resolutions: Array<{
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  readonly execute = (request: GatewayRequest, signal: AbortSignal): Promise<unknown> => {
    this.calls.push(request);
    this.signals.push(signal);
    return new Promise<unknown>((resolve, reject) => {
      this.resolutions.push({ resolve, reject });
    });
  };

  get callCount(): number {
    return this.calls.length;
  }

  resolve(index: number, value: unknown): void {
    this.resolutions[index].resolve(value);
  }

  reject(index: number, error: unknown): void {
    this.resolutions[index].reject(error);
  }
}

export async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
