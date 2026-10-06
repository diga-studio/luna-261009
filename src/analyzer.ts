import { PreparedFunnel, StageIndex } from "./prepare";
import { StageCounts, STAGE_COUNT } from "./types";
import { WaveletMatrix } from "./wavelet";

interface StageRuntime {
  ax: Uint32Array;
  bx: Uint32Array;
  wa: WaveletMatrix;
  wb: WaveletMatrix;
}

/** 由阶段点集构建查询结构（点集已按 x 排序）。 */
export function buildStageRuntime(stage: StageIndex, timeBits: number): StageRuntime {
  return {
    ax: stage.ax,
    bx: stage.bx,
    wa: WaveletMatrix.build(stage.ay, timeBits),
    wb: WaveletMatrix.build(stage.by, timeBits),
  };
}

function lowerBoundF64(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundU32(arr: Uint32Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 查询分析器：对准备数据执行时间窗查询。 */
export class FunnelAnalyzer {
  private readonly times: Float64Array;
  private readonly stages: StageRuntime[];

  constructor(prepared: PreparedFunnel) {
    this.times = prepared.times;
    this.stages = [];
    for (let s = 0; s < STAGE_COUNT; s++) {
      this.stages.push(buildStageRuntime(prepared.stages[s], prepared.timeBits));
    }
  }

  /**
   * 查询左闭右开时间窗 [startMs, endMs) 内各阶段完成的客户数。
   *
   * 每阶段答案 = A 点支配计数 - B 点支配计数：
   * A 点 (xl, y) 统计 xl_time < s 且 y_time < e，
   * B 点 (xr, y) 统计 xr_time < s 且 y_time < e，
   * 差值即满足 xl < s <= xr 且 y < e 的矩形数（= 去重客户数）。
   */
  query(startMs: number, endMs: number): StageCounts {
    const times = this.times;
    // S = 严格小于 s 的事件时间个数；E = 严格小于 e 的事件时间个数
    const S = lowerBoundF64(times, startMs);
    const E = lowerBoundF64(times, endMs);
    const upper = E + 1; // y 秩 <= E 即 y_time < e
    const out: StageCounts = [0, 0, 0, 0];
    for (let s = 0; s < STAGE_COUNT; s++) {
      const st = this.stages[s];
      const pa = upperBoundU32(st.ax, S);
      const pb = upperBoundU32(st.bx, S);
      const ca = pa === 0 ? 0 : st.wa.rangeFreq(0, pa, upper);
      const cb = pb === 0 ? 0 : st.wb.rangeFreq(0, pb, upper);
      out[s] = ca - cb;
    }
    return out;
  }
}
