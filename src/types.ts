export type Capability = "chat" | "embeddings";

export interface GatewayRequest {
  id: string;
  capability: Capability;
}

export interface ModelDescriptor {
  id: string;
  capabilities: readonly Capability[];
  execute(request: GatewayRequest, signal: AbortSignal): Promise<unknown>;
}

export type TerminalReason =
  | { kind: "completed"; value: unknown }
  | { kind: "cancelled" }
  | { kind: "timedOut" }
  | { kind: "rejected"; reason: "no-capacity" }
  | { kind: "failed"; error: unknown };

export interface MonotonicClock {
  now(): number;
}

export interface TimerHandle {
  cancel(): void;
}

export interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
}

export interface ModelSnapshot {
  id: string;
  healthy: boolean;
  running: string | null;
  waiting: string[];
}

export interface GatewayOptions {
  models: readonly ModelDescriptor[];
  clock?: MonotonicClock;
  scheduler?: Scheduler;
  waitTimeoutMs?: number;
  maxWaitingPerModel?: number;
}
