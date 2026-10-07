import { Directive, DisciplineState, Penalty, PenaltyId, PeriodDossier } from "./types.js";
import { Timeline } from "./timeline.js";

export { Directive, DisciplineState, Penalty, PenaltyId, PeriodDossier } from "./types.js";

function assertInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v)) {
    throw new RangeError(`${name} must be a safe integer, got ${v}`);
  }
}

/**
 * 单个领导、单个评价周期的纪律历史。
 *
 * 通过 constructor 指定不可变的周期窗口 [periodStart, periodEnd)，
 * 然后调用一次 load() 装载完整资料；此后只允许 revokePenalty() 与 query()。
 * 撤销代表成功申诉：该处罚视为在整个周期内从未提供过处分资格，
 * 所有人工指令按更正后的事实重新判定。
 */
export class DisciplineHistory {
  readonly periodStart: number;
  readonly periodEnd: number;

  private timeline: Timeline | null = null;
  private penalties = new Map<PenaltyId, Penalty>();
  private revoked = new Set<PenaltyId>();

  constructor(periodStart: number, periodEnd: number) {
    assertInt("periodStart", periodStart);
    assertInt("periodEnd", periodEnd);
    if (periodStart >= periodEnd) {
      throw new RangeError(`period window must satisfy start < end, got [${periodStart}, ${periodEnd})`);
    }
    this.periodStart = periodStart;
    this.periodEnd = periodEnd;
  }

  /** 装载完整资料，只能调用一次。 */
  load(dossier: PeriodDossier): void {
    if (this.timeline !== null) {
      throw new Error("dossier already loaded");
    }
    const timeline = new Timeline(this.periodStart, this.periodEnd);

    const penaltyIds = new Set<PenaltyId>();
    for (const p of dossier.penalties) {
      assertInt("penalty.start", p.start);
      assertInt("penalty.end", p.end);
      if (!(p.start < p.end)) {
        throw new RangeError(`penalty ${String(p.id)} must satisfy start < end`);
      }
      if (p.start < this.periodStart || p.end > this.periodEnd) {
        throw new RangeError(`penalty ${String(p.id)} lies outside the period window`);
      }
      if (penaltyIds.has(p.id)) {
        throw new Error(`duplicate penalty id: ${String(p.id)}`);
      }
      penaltyIds.add(p.id);
      timeline.addPenalty(p.start, p.end);
    }

    const seqs = new Set<number>();
    for (const d of dossier.directives) {
      assertInt("directive.time", d.time);
      assertInt("directive.seq", d.seq);
      if (d.time < this.periodStart || d.time >= this.periodEnd) {
        throw new RangeError(`directive seq=${d.seq} lies outside the period window`);
      }
      if (seqs.has(d.seq)) {
        throw new Error(`duplicate directive seq: ${d.seq}`);
      }
      seqs.add(d.seq);
      timeline.addDirective(d);
    }

    timeline.build();
    for (const p of dossier.penalties) {
      this.penalties.set(p.id, p);
    }
    this.timeline = timeline;
  }

  /**
   * 撤销处罚（成功申诉）。返回是否本次撤销生效；
   * 撤销未知编号或重复撤销均返回 false，无额外效果。
   */
  revokePenalty(id: PenaltyId): boolean {
    const timeline = this.requireLoaded();
    const p = this.penalties.get(id);
    if (p === undefined || this.revoked.has(id)) {
      return false;
    }
    this.revoked.add(id);
    timeline.removeCoverage(p.start, p.end);
    return true;
  }

  /** 查询 time 秒处理完全部变化后的状态。 */
  query(time: number): DisciplineState {
    const timeline = this.requireLoaded();
    assertInt("time", time);
    if (time < this.periodStart || time >= this.periodEnd) {
      throw new RangeError(`query time ${time} lies outside the period window`);
    }
    return timeline.query(time);
  }

  private requireLoaded(): Timeline {
    if (this.timeline === null) {
      throw new Error("dossier not loaded yet");
    }
    return this.timeline;
  }
}
