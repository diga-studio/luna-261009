import type { Grant, Interval } from './types.js';
import type { CompiledPolicy, PolicyDecision } from './policy.js';

const MS_PER_DAY = 86_400_000;
const SESSION_KEY_BASE = 33_554_432; // 2^25 > 8h 毫秒数

/** 简易二叉堆，元素为授权下标，比较器作用于下标。 */
class IndexHeap {
  private items: number[] = [];
  constructor(private readonly less: (a: number, b: number) => boolean) {}
  peek(): number | undefined {
    return this.items[0];
  }
  push(value: number): void {
    const items = this.items;
    items.push(value);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i], items[parent])) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else break;
    }
  }
  pop(): number | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l], items[m])) m = l;
        if (r < items.length && this.less(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

/** 生效中策略集合的增量跟踪器。 */
class PolicyTracker {
  private denyCount = 0;
  private allowCounts = new Map<number, number>();
  private allowApprovalCounts = new Map<number, number>();
  private allowKeys = new IndexHeap((a, b) => a < b); // key 越小越优先

  add(p: CompiledPolicy): void {
    if (p.effect === 'deny') {
      this.denyCount += 1;
      return;
    }
    const key = p.priority * SESSION_KEY_BASE + p.maxSessionMs;
    this.allowCounts.set(key, (this.allowCounts.get(key) ?? 0) + 1);
    if (p.requiresApproval) {
      this.allowApprovalCounts.set(key, (this.allowApprovalCounts.get(key) ?? 0) + 1);
    }
    this.allowKeys.push(key);
  }

  remove(p: CompiledPolicy): void {
    if (p.effect === 'deny') {
      this.denyCount -= 1;
      return;
    }
    const key = p.priority * SESSION_KEY_BASE + p.maxSessionMs;
    this.allowCounts.set(key, (this.allowCounts.get(key) ?? 0) - 1);
    if (p.requiresApproval) {
      this.allowApprovalCounts.set(key, (this.allowApprovalCounts.get(key) ?? 0) - 1);
    }
  }

  decision(): PolicyDecision {
    if (this.denyCount > 0) return { allowed: false };
    let top = this.allowKeys.peek();
    while (top !== undefined && (this.allowCounts.get(top) ?? 0) <= 0) {
      this.allowKeys.pop();
      top = this.allowKeys.peek();
    }
    if (top === undefined) return { allowed: false };
    return {
      allowed: true,
      maxSessionMs: top % SESSION_KEY_BASE,
      requiresApproval: (this.allowApprovalCounts.get(top) ?? 0) > 0,
    };
  }
}

interface PolicyEvent {
  timeMs: number;
  policy: CompiledPolicy;
  enter: boolean;
}

/** 生成策略窗口在 [fromMs, toMs) 内的进/出事件。 */
function windowEvents(
  p: CompiledPolicy,
  fromMs: number,
  toMs: number,
  out: PolicyEvent[],
): void {
  if (p.allDay) return;
  const firstDay = Math.floor(fromMs / MS_PER_DAY) - 1;
  const lastDay = Math.floor((toMs - 1) / MS_PER_DAY) + 1;
  for (let day = firstDay; day <= lastDay; day++) {
    const dayStart = day * MS_PER_DAY;
    // 窗口每日生效段：[dayStart+winStart, dayStart+winEnd)，跨午夜时终点落到次日。
    const start = dayStart + p.winStartMs;
    const end =
      p.winStartMs < p.winEndMs
        ? dayStart + p.winEndMs
        : dayStart + MS_PER_DAY + p.winEndMs;
    const s = Math.max(start, fromMs);
    const e = Math.min(end, toMs);
    if (s < e) {
      // 起点被截断到 fromMs 时，初始状态已计入该窗口，不再发进入事件，避免重复计数。
      if (s > fromMs) out.push({ timeMs: s, policy: p, enter: true });
      out.push({ timeMs: e, policy: p, enter: false });
    }
  }
}

function isActiveAt(p: CompiledPolicy, timeMs: number): boolean {
  if (p.allDay) return true;
  const tod = ((timeMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  if (p.winStartMs < p.winEndMs) {
    return tod >= p.winStartMs && tod < p.winEndMs;
  }
  return tod >= p.winStartMs || tod < p.winEndMs;
}

/**
 * 计算一组（同用户/环境/资源类型）授权在 [fromMs, toMs) 内的漂移区间：
 * 实际访问存在、但没有任何合规授权覆盖的时段。返回合并后的最大区间。
 */
export function driftIntervalsForGroup(
  candidates: readonly CompiledPolicy[],
  grants: readonly Grant[],
  fromMs: number,
  toMs: number,
): Interval[] {
  if (fromMs >= toMs || grants.length === 0) return [];

  // 策略窗口事件。
  const policyEventTimes = new Map<number, PolicyEvent[]>();
  for (const p of candidates) {
    const events: PolicyEvent[] = [];
    windowEvents(p, fromMs, toMs, events);
    for (const ev of events) {
      let list = policyEventTimes.get(ev.timeMs);
      if (!list) policyEventTimes.set(ev.timeMs, (list = []));
      list.push(ev);
    }
  }

  // 授权事件：start<=fromMs 的授权初始即生效，其余在 start 时刻进入。
  const grantEventTimes = new Map<number, { index: number; enter: boolean }[]>();
  const grantActive = new Array<boolean>(grants.length).fill(false);
  const addGrantEvent = (timeMs: number, index: number, enter: boolean) => {
    let list = grantEventTimes.get(timeMs);
    if (!list) grantEventTimes.set(timeMs, (list = []));
    list.push({ index, enter });
  };
  const initiallyActive: number[] = [];
  grants.forEach((g, index) => {
    if (Math.max(g.startMs, fromMs) >= Math.min(g.endMs, toMs)) return;
    if (g.startMs <= fromMs) initiallyActive.push(index);
    else addGrantEvent(g.startMs, index, true);
    if (g.endMs < toMs) addGrantEvent(g.endMs, index, false);
  });

  const times = new Set<number>([fromMs, toMs]);
  for (const t of policyEventTimes.keys()) times.add(t);
  for (const t of grantEventTimes.keys()) times.add(t);
  const sortedTimes = [...times].sort((a, b) => a - b);

  // 初始策略状态。
  const tracker = new PolicyTracker();
  for (const p of candidates) {
    if (isActiveAt(p, fromMs)) tracker.add(p);
  }

  // 初始授权状态与两个最大堆（按 startMs），懒删除。
  let activeCount = 0;
  const byStartDesc = (a: number, b: number) =>
    grants[a].startMs > grants[b].startMs;
  const anyHeap = new IndexHeap(byStartDesc);
  const approvedHeap = new IndexHeap(byStartDesc);
  const activate = (index: number) => {
    grantActive[index] = true;
    activeCount += 1;
    anyHeap.push(index);
    if (grants[index].approved) approvedHeap.push(index);
  };
  const deactivate = (index: number) => {
    grantActive[index] = false;
    activeCount -= 1;
  };
  const topStart = (heap: IndexHeap): number | undefined => {
    for (;;) {
      const top = heap.peek();
      if (top === undefined) return undefined;
      if (grantActive[top]) return grants[top].startMs;
      heap.pop();
    }
  };
  for (const index of initiallyActive) activate(index);

  const result: Interval[] = [];
  const pushDrift = (startMs: number, endMs: number) => {
    const last = result[result.length - 1];
    if (last && last.endMs === startMs) last.endMs = endMs;
    else result.push({ startMs, endMs });
  };

  for (let i = 0; i < sortedTimes.length - 1; i++) {
    const t = sortedTimes[i];
    const next = sortedTimes[i + 1];

    // 先应用 t 时刻的全部事件，再评估 [t, next)。
    const pEvents = policyEventTimes.get(t);
    if (pEvents) {
      for (const ev of pEvents) {
        if (ev.enter) tracker.add(ev.policy);
        else tracker.remove(ev.policy);
      }
    }
    const gEvents = grantEventTimes.get(t);
    if (gEvents) {
      for (const ev of gEvents) {
        if (ev.enter) activate(ev.index);
        else deactivate(ev.index);
      }
    }

    const segStart = Math.max(t, fromMs);
    const segEnd = Math.min(next, toMs);
    if (segStart >= segEnd) continue;
    if (activeCount === 0) continue;

    const decision = tracker.decision();
    let driftFrom = -1;
    if (!decision.allowed) {
      driftFrom = segStart;
    } else {
      const top = decision.requiresApproval
        ? topStart(approvedHeap)
        : topStart(anyHeap);
      const compliantEnd = top === undefined ? -1 : top + decision.maxSessionMs;
      if (compliantEnd < segEnd) driftFrom = Math.max(compliantEnd, segStart);
    }
    if (driftFrom >= 0 && driftFrom < segEnd) pushDrift(driftFrom, segEnd);
  }

  return result;
}
