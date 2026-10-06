import { FunnelEvent } from "../src/types";

/** 基准规模参数：1000 万事件、50 万客户、200 万旅程、365 天。 */
export const BENCH = {
  seed: 20261009,
  eventTarget: intEnv("BENCH_EVENTS", 10_000_000),
  customerCount: intEnv("BENCH_CUSTOMERS", 500_000),
  journeyCount: intEnv("BENCH_JOURNEYS", 2_000_000),
  spanMs: 365 * 24 * 3600 * 1000,
  t0: Date.UTC(2025, 0, 1),
  burstCount: intEnv("BENCH_BURSTS", 5000), // 密集片段：同一毫秒大量事件的瞬时点
};

function intEnv(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 确定性事件流生成器（按种子可重放）。
 * - 每个旅程归属固定客户，旅程间时间交叠；
 * - 30% 旅程为“转化型”（含完整 impression/click/click/conversion 骨架加噪声），
 *   其余旅程动作为随机分布（含重复动作与其他动作）；
 * - 10% 旅程集中在若干个同一毫秒的密集瞬时点上（每毫秒多事件，靠 seq 排序）。
 */
export function* genEvents(seed: number = BENCH.seed): Generator<FunnelEvent> {
  const rng = mulberry32(seed);
  const { customerCount, journeyCount, spanMs, t0, burstCount } = BENCH;

  // 密集瞬时点（年内随机毫秒）
  const bursts = new Float64Array(burstCount);
  for (let b = 0; b < burstCount; b++) {
    bursts[b] = t0 + Math.floor(rng() * spanMs);
  }

  let emitted = 0;
  for (let j = 0; j < journeyCount && emitted < BENCH.eventTarget; j++) {
    const customer = "c" + Math.floor(rng() * customerCount);
    const journey = "j" + j;
    const converter = rng() < 0.3;
    // 旅程长度 1..12，均值约 5
    const len = converter
      ? 4 + Math.floor(rng() * 5)
      : 1 + Math.floor(rng() * 6);
    // 旅程起点：10% 落在密集瞬时点上
    const inBurst = rng() < 0.1;
    const start = inBurst
      ? bursts[Math.floor(rng() * burstCount)]
      : t0 + Math.floor(rng() * spanMs);

    let time = start;
    for (let i = 0; i < len && emitted < BENCH.eventTarget; i++) {
      let action: string;
      if (converter) {
        // 骨架：impression, click, click, conversion，之后随机
        if (i === 0) action = "impression";
        else if (i === 1 || i === 2) action = "click";
        else if (i === 3) action = "conversion";
        else action = pickAction(rng);
      } else {
        action = pickAction(rng);
      }
      // 时间推进：70% 小间隔（含 0，制造同毫秒多事件），30% 大间隔
      if (i > 0) {
        const r = rng();
        if (r < 0.4) time += 0;
        else if (r < 0.7) time += 1 + Math.floor(rng() * 1000);
        else if (r < 0.9) time += 1000 + Math.floor(rng() * 3600_000);
        else time += 3600_000 + Math.floor(rng() * 7 * 86400_000);
      }
      if (time >= t0 + spanMs) time = t0 + spanMs - 1 - Math.floor(rng() * 1000);
      emitted++;
      yield { customer, journey, action, time, seq: i };
    }
  }
}

function pickAction(rng: () => number): string {
  const r = rng();
  if (r < 0.3) return "impression";
  if (r < 0.62) return "click";
  if (r < 0.77) return "conversion";
  return rng() < 0.5 ? "scroll" : "hover";
}
