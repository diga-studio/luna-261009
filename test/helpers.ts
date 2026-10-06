import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipeLite } from '../src/index';

/** 手动推进的逻辑时钟（毫秒，非递减）。 */
export class ManualClock {
  private t: number;
  constructor(start = 1_000_000) {
    this.t = start;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    if (ms < 0) throw new RangeError('clock cannot go backwards');
    this.t += ms;
  }
  set(t: number): void {
    if (t < this.t) throw new RangeError('clock cannot go backwards');
    this.t = t;
  }
}

export interface TestContext {
  clock: ManualClock;
  dir: string;
  dbPath: string;
  open(groups?: string[]): PipeLite;
  cleanup(): void;
}

export function makeContext(groups: string[] = ['g1', 'g2']): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'pipelite-'));
  const dbPath = join(dir, 'queue.db');
  const clock = new ManualClock();
  return {
    clock,
    dir,
    dbPath,
    open: (g = groups) => new PipeLite({ path: dbPath, groups: g, clock: clock.now }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const GROUPS8 = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];
