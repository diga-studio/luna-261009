import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 可手动推进的逻辑时钟。 */
export class FakeClock {
  private current: number;
  constructor(start = 1_000_000) {
    this.current = start;
  }
  now = (): number => this.current;
  advance(ms: number): number {
    if (ms < 0) throw new RangeError("clock must be non-decreasing");
    this.current += ms;
    return this.current;
  }
  set(value: number): number {
    if (value < this.current) throw new RangeError("clock must be non-decreasing");
    this.current = value;
    return this.current;
  }
}

/** 临时 SQLite 文件路径，afterEach/测试结束可清理。 */
export function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pipelite-test-"));
  return {
    path: join(dir, "pipelite.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 确定性伪随机数（LCG），用于规模场景可复现。 */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
