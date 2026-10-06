import { BENCH, mulberry32 } from "./gen";

export interface QueryWindow {
  start: number;
  end: number;
}

export interface WindowSet {
  warmup: QueryWindow[];
  queries: QueryWindow[];
}

/**
 * 生成查询工作负载（确定性）：
 * - 100 次预热 + 10000 次正式查询；
 * - 80% 为宽窗口（覆盖总时长 50%~90%，端点为任意毫秒，不对齐事件）；
 * - 20% 为密集区域滑动窗口（宽度 50ms~5s，每次滑动 1~7ms）；
 * - 所有窗口互不相同。
 */
export function genWindows(seed: number = BENCH.seed + 1): WindowSet {
  const rng = mulberry32(seed);
  const { t0, spanMs } = BENCH;
  const seen = new Set<string>();
  const queries: QueryWindow[] = [];

  const push = (start: number, end: number): void => {
    const key = start + "/" + end;
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({ start, end });
  };

  // 80% 宽窗口：覆盖 50%~90% 的时间跨度（约等于覆盖 50%~90% 的事件）
  while (queries.length < 8000) {
    const widthRatio = 0.5 + rng() * 0.4;
    const width = Math.floor(widthRatio * spanMs);
    const slack = spanMs - width;
    const start = t0 + Math.floor(rng() * (slack + 1));
    push(start, start + width);
  }
  // 20% 密集滑动窗口：随机密集区域，小步滑动
  let produced = 0;
  while (produced < 2000) {
    const center = t0 + Math.floor(rng() * spanMs);
    const width = 50 + Math.floor(rng() * 4950);
    const slides = 5 + Math.floor(rng() * 20);
    let start = center - Math.floor(width / 2);
    for (let i = 0; i < slides && produced < 2000; i++) {
      const before = queries.length;
      push(start, start + width);
      if (queries.length > before) produced++;
      start += 1 + Math.floor(rng() * 7); // 每次只移动几毫秒
    }
  }

  const warmup: QueryWindow[] = [];
  for (let i = 0; i < 100; i++) {
    const width = Math.floor((0.1 + rng() * 0.8) * spanMs);
    const start = t0 + Math.floor(rng() * (spanMs - width + 1));
    warmup.push({ start, end: start + width });
  }
  return { warmup, queries };
}
