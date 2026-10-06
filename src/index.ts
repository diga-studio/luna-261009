import { EventInput, StageCounts } from "./types";
import { buildPrepared } from "./prepare";
import { loadPrepared, savePrepared } from "./store";
import { FunnelEngine } from "./engine";

export * from "./types";

export interface FunnelDB {
  /** Per-stage distinct customer counts for the window [startMs, endMs). */
  query(startMs: number, endMs: number): StageCounts;
  close(): void;
}

/** Prepare raw events and persist the immutable result into `outDir`. */
export function prepareFunnel(events: EventInput, outDir: string): void {
  const data = buildPrepared(events);
  savePrepared(outDir, data);
}

/** Open a previously prepared directory. A new process opening the same
 *  directory must produce identical query results. */
export function openFunnel(dir: string): FunnelDB {
  const data = loadPrepared(dir);
  const engine = new FunnelEngine(data);
  return {
    query(startMs: number, endMs: number): StageCounts {
      return engine.query(startMs, endMs);
    },
    close(): void {
      // Nothing to release; data is held in memory only.
    },
  };
}
