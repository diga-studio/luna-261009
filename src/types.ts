export type Capability = "chat" | "embeddings";

export interface GatewayRequest {
  id: string;
  capability: Capability;
}

export interface ModelDefinition {
  id: string;
  capabilities: Capability[];
  execute: (request: GatewayRequest, signal: AbortSignal) => Promise<unknown>;
}

export type TerminalReason =
  | "cancelled"
  | "timeout"
  | "no-capacity"
  | "execute-error";

export type Outcome =
  | { status: "completed"; value: unknown }
  | { status: "failed"; reason: TerminalReason; error?: unknown };

export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ModelSnapshot {
  modelId: string;
  healthy: boolean;
  running: string | null;
  waiting: string[];
}
