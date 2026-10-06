import { FunnelEvent, FUNNEL_ACTIONS, StageCounts, STAGE_COUNT } from "../src/types";

/**
 * 独立参考实现：逐旅程完整计算。
 * 对每个旅程：窗口内事件按 (time, seq) 排序后贪心依次匹配
 * impression/click/click/conversion，能匹配到第 k 个动作即完成第 k 阶段。
 * 客户任一旅程完成即计 1 人。
 */
export function bruteForce(
  events: FunnelEvent[],
  startMs: number,
  endMs: number,
): StageCounts {
  const journeys = new Map<string, { cust: string; time: number; seq: number; action: string }[]>();
  for (const e of events) {
    if (e.time < startMs || e.time >= endMs) continue;
    let j = journeys.get(e.journey);
    if (!j) {
      j = [];
      journeys.set(e.journey, j);
    }
    j.push({ cust: e.customer, time: e.time, seq: e.seq, action: e.action });
  }
  const done: Set<string>[] = [];
  for (let s = 0; s < STAGE_COUNT; s++) done.push(new Set<string>());
  for (const evs of journeys.values()) {
    evs.sort((a, b) => a.time - b.time || a.seq - b.seq);
    let stage = 0;
    for (const e of evs) {
      if (stage < STAGE_COUNT && e.action === FUNNEL_ACTIONS[stage]) {
        done[stage].add(e.cust);
        stage++;
      }
    }
  }
  return [
    done[0].size,
    done[1].size,
    done[2].size,
    done[3].size,
  ] as StageCounts;
}
