import { defaultScoreFn } from '../src/scorer';
import type { DirectoryScore, Profile, ScoreFn, ScoreInput } from '../src/types';

export interface PendingScoring {
  input: ScoreInput;
  settle: (score: DirectoryScore) => void;
}

/**
 * 完全手动控制的评分函数：每次评分启动后挂起，由测试显式完成，
 * 从而确定性地构造任意完成交错，不依赖随机延时。
 */
export class ScoringHarness {
  /** 已启动的评分输入，按启动顺序记录。 */
  readonly started: ScoreInput[] = [];
  /** 当前已启动但未结束的评分数量。 */
  running = 0;
  /** 运行期间出现过的最大并发数。 */
  maxRunning = 0;
  private readonly pending: PendingScoring[] = [];

  readonly scoreFn: ScoreFn = (input) => {
    this.started.push(input);
    this.running += 1;
    if (this.running > this.maxRunning) {
      this.maxRunning = this.running;
    }
    return new Promise<DirectoryScore>((resolve) => {
      this.pending.push({
        input,
        settle: (score) => {
          this.running -= 1;
          resolve(score);
        },
      });
    });
  };

  pendingCount(): number {
    return this.pending.length;
  }

  /** 完成最老的一个挂起评分（可按输入过滤），结果用默认规则对其快照计算。 */
  async resolveOne(predicate?: (input: ScoreInput) => boolean): Promise<ScoreInput> {
    const idx = predicate ? this.pending.findIndex((p) => predicate(p.input)) : 0;
    if (idx < 0) {
      throw new Error('no matching pending scoring');
    }
    const entry = this.pending.splice(idx, 1)[0]!;
    const score = await defaultScoreFn(entry.input);
    entry.settle(score);
    await tick();
    return entry.input;
  }

  async resolveAll(): Promise<void> {
    while (this.pending.length > 0) {
      await this.resolveOne();
    }
  }

  /** 完成所有满足条件的挂起评分。 */
  async resolveAllWhere(predicate: (input: ScoreInput) => boolean): Promise<number> {
    let count = 0;
    while (this.pending.some((p) => predicate(p.input))) {
      await this.resolveOne(predicate);
      count += 1;
    }
    return count;
  }
}

/** 让已排队的微任务/回调执行一轮。 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => resolve()));
}

export function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    businessName: 'Acme Coffee',
    address: '1 Main St',
    phone: '555-0100',
    ...overrides,
    hours: overrides.hours ? [...overrides.hours] : ['9-17', '9-17', '9-17', '9-17', '9-17', '10-14', 'closed'],
  };
}
