import type {
  Capability,
  GatewayOptions,
  GatewayRequest,
  ModelDescriptor,
  ModelSnapshot,
  MonotonicClock,
  Scheduler,
  TerminalReason,
  TimerHandle,
} from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_WAITING = 20;
const FAILURE_THRESHOLD = 3;

interface Entry {
  readonly id: string;
  readonly capability: Capability;
  readonly seq: number;
  readonly request: GatewayRequest;
  readonly userSignal: AbortSignal | undefined;
  readonly controller: AbortController;
  readonly deadline: number;
  state: "waiting" | "running" | "settled";
  model: ModelState | null;
  timer: TimerHandle | null;
  abortListener: (() => void) | null;
  resolve: (reason: TerminalReason) => void;
}

interface ModelState {
  readonly desc: ModelDescriptor;
  healthy: boolean;
  consecutiveFailures: number;
  running: Entry | null;
  waiting: Entry[];
}

const defaultClock: MonotonicClock = { now: () => Date.now() };

const defaultScheduler: Scheduler = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  },
};

export class ModelGateway {
  private readonly models: ModelState[] = [];
  private readonly byId = new Map<string, ModelState>();
  private readonly clock: MonotonicClock;
  private readonly scheduler: Scheduler;
  private readonly waitTimeoutMs: number;
  private readonly maxWaiting: number;
  private nextSeq = 0;

  constructor(options: GatewayOptions) {
    this.clock = options.clock ?? defaultClock;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.maxWaiting = options.maxWaitingPerModel ?? DEFAULT_MAX_WAITING;
    for (const desc of options.models) {
      const model: ModelState = {
        desc,
        healthy: true,
        consecutiveFailures: 0,
        running: null,
        waiting: [],
      };
      this.models.push(model);
      this.byId.set(desc.id, model);
    }
  }

  submit(request: GatewayRequest, signal?: AbortSignal): Promise<TerminalReason> {
    if (signal?.aborted) {
      return Promise.resolve({ kind: "cancelled" });
    }
    return new Promise<TerminalReason>((resolve) => {
      const entry: Entry = {
        id: request.id,
        capability: request.capability,
        seq: this.nextSeq++,
        request,
        userSignal: signal,
        controller: new AbortController(),
        deadline: this.clock.now() + this.waitTimeoutMs,
        state: "settled",
        model: null,
        timer: null,
        abortListener: null,
        resolve,
      };
      const model = this.chooseModel(request.capability);
      if (!model) {
        resolve({ kind: "rejected", reason: "no-capacity" });
        return;
      }
      entry.state = "waiting";
      entry.model = model;
      this.insertWaiting(model, entry);
      entry.timer = this.scheduler.setTimeout(
        () => this.onWaitTimeout(entry),
        this.waitTimeoutMs,
      );
      if (signal) {
        const listener = () => this.onUserAbort(entry);
        entry.abortListener = listener;
        signal.addEventListener("abort", listener, { once: true });
      }
      this.pump(model);
    });
  }

  reportHealth(modelId: string, success: boolean): void {
    const model = this.byId.get(modelId);
    if (!model) return;
    if (success) {
      model.consecutiveFailures = 0;
      model.healthy = true;
      this.pump(model);
      return;
    }
    model.consecutiveFailures += 1;
    if (model.consecutiveFailures >= FAILURE_THRESHOLD && model.healthy) {
      model.healthy = false;
      this.reroute(model);
    }
  }

  snapshot(): ModelSnapshot[] {
    return this.models.map((model) => ({
      id: model.desc.id,
      healthy: model.healthy,
      running: model.running ? model.running.id : null,
      waiting: model.waiting.map((entry) => entry.id),
    }));
  }

  private chooseModel(capability: Capability): ModelState | null {
    let best: ModelState | null = null;
    let bestScore = Infinity;
    for (const model of this.models) {
      if (!model.healthy) continue;
      if (!model.desc.capabilities.includes(capability)) continue;
      if (model.waiting.length >= this.maxWaiting) continue;
      const score = (model.running ? 1 : 0) + model.waiting.length;
      if (
        score < bestScore ||
        (score === bestScore && best !== null && model.desc.id < best.desc.id)
      ) {
        best = model;
        bestScore = score;
      }
    }
    return best;
  }

  private insertWaiting(model: ModelState, entry: Entry): void {
    const queue = model.waiting;
    let index = queue.length;
    while (index > 0) {
      const prev = queue[index - 1];
      if (!prev || prev.seq < entry.seq) break;
      index -= 1;
    }
    queue.splice(index, 0, entry);
  }

  private removeWaiting(entry: Entry): void {
    const model = entry.model;
    if (!model) return;
    const index = model.waiting.indexOf(entry);
    if (index >= 0) model.waiting.splice(index, 1);
  }

  private settle(entry: Entry, reason: TerminalReason): void {
    if (entry.state === "settled") return;
    entry.state = "settled";
    if (entry.timer) {
      entry.timer.cancel();
      entry.timer = null;
    }
    if (entry.abortListener && entry.userSignal) {
      entry.userSignal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = null;
    }
    entry.resolve(reason);
  }

  private pump(model: ModelState): void {
    while (model.healthy && model.running === null) {
      const entry = model.waiting[0];
      if (!entry) return;
      if (entry.userSignal?.aborted) {
        model.waiting.shift();
        this.settle(entry, { kind: "cancelled" });
        continue;
      }
      if (this.clock.now() >= entry.deadline) {
        model.waiting.shift();
        this.settle(entry, { kind: "timedOut" });
        continue;
      }
      model.waiting.shift();
      entry.state = "running";
      model.running = entry;
      if (entry.timer) {
        entry.timer.cancel();
        entry.timer = null;
      }
      this.startExecute(model, entry);
    }
  }

  private startExecute(model: ModelState, entry: Entry): void {
    let result: Promise<unknown>;
    try {
      result = model.desc.execute(entry.request, entry.controller.signal);
    } catch (error) {
      this.onExecuteFinished(model, entry, false, error);
      return;
    }
    result.then(
      (value) => this.onExecuteFinished(model, entry, true, value),
      (error) => this.onExecuteFinished(model, entry, false, error),
    );
  }

  private onExecuteFinished(
    model: ModelState,
    entry: Entry,
    ok: boolean,
    payload: unknown,
  ): void {
    if (model.running === entry) {
      model.running = null;
    }
    if (ok) {
      this.settle(entry, { kind: "completed", value: payload });
    } else {
      this.settle(entry, { kind: "failed", error: payload });
    }
    this.pump(model);
  }

  private onUserAbort(entry: Entry): void {
    if (entry.state === "waiting") {
      this.removeWaiting(entry);
      this.settle(entry, { kind: "cancelled" });
      return;
    }
    if (entry.state === "running") {
      entry.controller.abort();
      this.settle(entry, { kind: "cancelled" });
    }
  }

  private onWaitTimeout(entry: Entry): void {
    if (entry.state !== "waiting") return;
    if (this.clock.now() < entry.deadline) return;
    this.removeWaiting(entry);
    this.settle(entry, { kind: "timedOut" });
  }

  private reroute(degraded: ModelState): void {
    const pending = degraded.waiting;
    degraded.waiting = [];
    for (const entry of pending) {
      if (entry.state !== "waiting") continue;
      if (entry.userSignal?.aborted) {
        this.settle(entry, { kind: "cancelled" });
        continue;
      }
      if (this.clock.now() >= entry.deadline) {
        this.settle(entry, { kind: "timedOut" });
        continue;
      }
      const target = this.chooseModel(entry.capability);
      if (!target) {
        this.settle(entry, { kind: "rejected", reason: "no-capacity" });
        continue;
      }
      entry.model = target;
      this.insertWaiting(target, entry);
    }
    for (const model of this.models) {
      this.pump(model);
    }
  }
}
