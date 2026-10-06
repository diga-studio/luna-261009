import type {
  Capability,
  GatewayRequest,
  ModelDescriptor,
  MonotonicClock,
  Scheduler,
  TerminalReason,
  TimerHandle,
} from "../src/types.js";

interface VirtualTimer {
  due: number;
  order: number;
  cancelled: boolean;
  callback: () => void;
}

export class VirtualTime implements MonotonicClock, Scheduler {
  private current = 0;
  private timers: VirtualTimer[] = [];
  private nextOrder = 0;

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const timer: VirtualTimer = {
      due: this.current + delayMs,
      order: this.nextOrder++,
      cancelled: false,
      callback,
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  setNow(ms: number): void {
    this.current = ms;
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  advanceTo(target: number): void {
    for (;;) {
      let next: VirtualTimer | null = null;
      for (const timer of this.timers) {
        if (timer.cancelled || timer.due > target) continue;
        if (
          !next ||
          timer.due < next.due ||
          (timer.due === next.due && timer.order < next.order)
        ) {
          next = timer;
        }
      }
      if (!next) break;
      next.cancelled = true;
      this.current = next.due;
      next.callback();
    }
    this.current = target;
  }

  pendingTimerCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface ExecuteCall {
  request: GatewayRequest;
  signal: AbortSignal;
  result: Deferred<unknown>;
}

export class ControllableModel implements ModelDescriptor {
  readonly calls: ExecuteCall[] = [];
  executeStarted = 0;

  constructor(
    readonly id: string,
    readonly capabilities: readonly Capability[],
  ) {}

  execute(request: GatewayRequest, signal: AbortSignal): Promise<unknown> {
    this.executeStarted += 1;
    const result = deferred<unknown>();
    this.calls.push({ request, signal, result });
    return result.promise;
  }

  lastCall(): ExecuteCall {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error(`model ${this.id} has no execute calls`);
    return call;
  }
}

export function trackTerminal(): {
  events: TerminalReason[];
  sink(reason: TerminalReason): void;
} {
  const events: TerminalReason[] = [];
  return {
    events,
    sink(reason: TerminalReason) {
      events.push(reason);
    },
  };
}

export async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

