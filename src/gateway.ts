import type {
  Capability,
  GatewayRequest,
  ModelDefinition,
  ModelSnapshot,
  Outcome,
  Scheduler,
} from "./types.js";

export const WAIT_TIMEOUT_MS = 45_000;
export const MAX_WAITING_PER_MODEL = 20;
export const FAILURE_THRESHOLD = 3;

type PendingState = "waiting" | "running" | "settled";

interface PendingRequest {
  id: string;
  request: GatewayRequest;
  seq: number;
  deadline: number;
  timer: unknown;
  state: PendingState;
  model: ModelState | null;
  settle: (outcome: Outcome) => void;
  callerSignal?: AbortSignal;
  abortListener?: () => void;
  executeAbort?: AbortController;
}

interface ModelState {
  def: ModelDefinition;
  healthy: boolean;
  failures: number;
  running: PendingRequest | null;
  queue: PendingRequest[];
}

const defaultScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
};

export class InferenceGateway {
  private readonly scheduler: Scheduler;
  private readonly models: ModelState[] = [];
  private readonly byId = new Map<string, ModelState>();
  private seqCounter = 0;

  constructor(models: ModelDefinition[], scheduler: Scheduler = defaultScheduler) {
    this.scheduler = scheduler;
    for (const def of models) {
      if (this.byId.has(def.id)) {
        throw new Error(`duplicate model id: ${def.id}`);
      }
      const state: ModelState = {
        def,
        healthy: true,
        failures: 0,
        running: null,
        queue: [],
      };
      this.models.push(state);
      this.byId.set(def.id, state);
    }
  }

  submit(request: GatewayRequest, signal?: AbortSignal): Promise<Outcome> {
    let settleFn!: (outcome: Outcome) => void;
    const promise = new Promise<Outcome>((resolve) => {
      settleFn = resolve;
    });

    const pending: PendingRequest = {
      id: request.id,
      request,
      seq: this.seqCounter++,
      deadline: this.scheduler.now() + WAIT_TIMEOUT_MS,
      timer: undefined,
      state: "waiting",
      model: null,
      settle: settleFn,
      callerSignal: signal,
    };

    if (signal?.aborted) {
      this.settleOnce(pending, { status: "failed", reason: "cancelled" });
      return promise;
    }

    pending.timer = this.scheduler.setTimeout(
      () => this.onTimeout(pending),
      WAIT_TIMEOUT_MS,
    );

    if (signal) {
      const listener = () => this.onAbort(pending);
      pending.abortListener = listener;
      signal.addEventListener("abort", listener, { once: true });
    }

    const target = this.route(request.capability);
    if (!target) {
      this.settleOnce(pending, { status: "failed", reason: "no-capacity" });
      return promise;
    }

    pending.model = target;
    target.queue.push(pending);
    this.pump(target);
    return promise;
  }

  reportHealth(modelId: string, success: boolean): void {
    const model = this.byId.get(modelId);
    if (!model) {
      throw new Error(`unknown model id: ${modelId}`);
    }

    if (success) {
      model.failures = 0;
      if (!model.healthy) {
        model.healthy = true;
        this.pump(model);
      }
      return;
    }

    model.failures += 1;
    if (model.failures < FAILURE_THRESHOLD || !model.healthy) {
      return;
    }

    model.healthy = false;
    const displaced = model.queue.splice(0, model.queue.length);
    for (const pending of displaced) {
      pending.model = null;
      const target = this.route(pending.request.capability);
      if (!target) {
        this.settleOnce(pending, { status: "failed", reason: "no-capacity" });
        continue;
      }
      pending.model = target;
      this.insertBySeq(target.queue, pending);
      this.pump(target);
    }
  }

  snapshot(): ModelSnapshot[] {
    return this.models.map((model) => ({
      modelId: model.def.id,
      healthy: model.healthy,
      running: model.running ? model.running.id : null,
      waiting: model.queue.map((pending) => pending.id),
    }));
  }

  private insertBySeq(queue: PendingRequest[], pending: PendingRequest): void {
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (queue[mid].seq < pending.seq) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, pending);
  }

  private route(capability: Capability): ModelState | null {
    let best: ModelState | null = null;
    let bestScore = Infinity;
    for (const model of this.models) {
      if (!model.healthy) continue;
      if (!model.def.capabilities.includes(capability)) continue;
      if (model.queue.length >= MAX_WAITING_PER_MODEL) continue;
      const score = (model.running ? 1 : 0) + model.queue.length;
      if (
        score < bestScore ||
        (score === bestScore && best !== null && model.def.id < best.def.id)
      ) {
        best = model;
        bestScore = score;
      }
    }
    return best;
  }

  private pump(model: ModelState): void {
    while (model.healthy && model.running === null && model.queue.length > 0) {
      const head = model.queue[0];
      if (this.scheduler.now() >= head.deadline) {
        model.queue.shift();
        head.model = null;
        this.settleOnce(head, { status: "failed", reason: "timeout" });
        continue;
      }
      model.queue.shift();
      head.model = null;
      this.startExecute(model, head);
    }
  }

  private startExecute(model: ModelState, pending: PendingRequest): void {
    pending.state = "running";
    model.running = pending;
    if (pending.timer !== undefined) {
      this.scheduler.clearTimeout(pending.timer);
      pending.timer = undefined;
    }

    const controller = new AbortController();
    pending.executeAbort = controller;

    let result: Promise<unknown>;
    try {
      result = model.def.execute(pending.request, controller.signal);
    } catch (error) {
      this.finishExecute(model, pending, {
        status: "failed",
        reason: "execute-error",
        error,
      });
      return;
    }
    result.then(
      (value) =>
        this.finishExecute(model, pending, { status: "completed", value }),
      (error) =>
        this.finishExecute(model, pending, {
          status: "failed",
          reason: "execute-error",
          error,
        }),
    );
  }

  private finishExecute(
    model: ModelState,
    pending: PendingRequest,
    outcome: Outcome,
  ): void {
    if (model.running === pending) {
      model.running = null;
    }
    pending.executeAbort = undefined;
    this.settleOnce(pending, outcome);
    this.pump(model);
  }

  private onTimeout(pending: PendingRequest): void {
    if (pending.state !== "waiting") return;
    const model = pending.model;
    if (model) {
      const index = model.queue.indexOf(pending);
      if (index >= 0) model.queue.splice(index, 1);
      pending.model = null;
    }
    this.settleOnce(pending, { status: "failed", reason: "timeout" });
    if (model) this.pump(model);
  }

  private onAbort(pending: PendingRequest): void {
    if (pending.state === "settled") return;
    if (pending.state === "waiting") {
      const model = pending.model;
      if (model) {
        const index = model.queue.indexOf(pending);
        if (index >= 0) model.queue.splice(index, 1);
        pending.model = null;
      }
      this.settleOnce(pending, { status: "failed", reason: "cancelled" });
      if (model) this.pump(model);
      return;
    }
    // running: settle caller immediately, signal execute, keep slot until execute returns
    pending.executeAbort?.abort();
    this.settleOnce(pending, { status: "failed", reason: "cancelled" });
  }

  private settleOnce(pending: PendingRequest, outcome: Outcome): void {
    if (pending.state === "settled") return;
    pending.state = "settled";
    if (pending.timer !== undefined) {
      this.scheduler.clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    if (pending.callerSignal && pending.abortListener) {
      pending.callerSignal.removeEventListener("abort", pending.abortListener);
      pending.abortListener = undefined;
    }
    pending.settle(outcome);
  }
}
