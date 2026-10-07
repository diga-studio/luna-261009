import type { RulResult, TelemetryPoint } from './types';
import { Timeline } from './timeline';

const MS_PER_DAY = 86_400_000;
const WINDOW_DAYS = 30;
const HEALTH_THRESHOLD = 0.8;
const MIN_DECLINE_PER_HOUR = 0.000001;

/** 单台泵的数字孪生：线性退化剩余寿命预测。 */
export class PumpTwin {
  private readonly timeline = new Timeline();

  constructor(
    public readonly ratedRpm: number,
    public readonly ratedHead: number,
  ) {
    if (!(ratedRpm > 0) || !(ratedHead > 0)) {
      throw new RangeError('ratedRpm and ratedHead must be positive');
    }
  }

  /** 批量写入遥测；同时间戳后者覆盖前者，批次内按给定顺序生效。 */
  writeBatch(points: readonly TelemetryPoint[]): void {
    for (const p of points) {
      const running = p.rpm > 0;
      const expectedHead =
        this.ratedHead * (p.rpm / this.ratedRpm) * (p.rpm / this.ratedRpm);
      const y = running ? p.head / expectedHead : 0;
      this.timeline.upsert(p.timestampMs, running, y);
    }
  }

  /** 查询 atMs 时刻的寿命预测；仅使用 atMs 之前 30 个自然日内的遥测。 */
  predict(atMs: number): RulResult {
    const leftMs = atMs - WINDOW_DAYS * MS_PER_DAY;
    const sums = this.timeline.windowSums(leftMs, atMs);
    const n = sums.count;
    if (n < 2) {
      return { status: 'insufficient-data' };
    }
    const denom = n * sums.sumXX - sums.sumX * sums.sumX;
    const slope =
      denom > 0 ? (n * sums.sumXY - sums.sumX * sums.sumY) / denom : 0;
    const intercept = (sums.sumY - slope * sums.sumX) / n;
    const xAtT =
      this.timeline.runningHoursAt(atMs) - this.timeline.runningHoursAt(leftMs);
    const fittedValue = intercept + slope * xAtT;
    if (fittedValue <= HEALTH_THRESHOLD) {
      return { status: 'exhausted', slope, fittedValue, remainingLifeHours: 0 };
    }
    if (slope >= -MIN_DECLINE_PER_HOUR) {
      return { status: 'no-finite-estimate', slope, fittedValue };
    }
    return {
      status: 'ok',
      slope,
      fittedValue,
      remainingLifeHours: (fittedValue - HEALTH_THRESHOLD) / -slope,
    };
  }
}
