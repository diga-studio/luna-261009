import { FunnelEvent, STAGE_ACTIONS, STAGE_COUNT, StageCounts } from "./types";

/**
 * Independent naive reference: per-journey full computation.
 * Used by tests and benchmark sampling to validate the optimized engine.
 */
export function referenceQuery(
  events: FunnelEvent[],
  startMs: number,
  endMs: number
): StageCounts {
  // Group event indices by journey.
  const byJourney = new Map<string | number, FunnelEvent[]>();
  for (const ev of events) {
    let list = byJourney.get(ev.journey);
    if (list === undefined) {
      list = [];
      byJourney.set(ev.journey, list);
    }
    list.push(ev);
  }
  // Per customer, the max stage reached in any single journey.
  const reached = new Map<string | number, number>();
  for (const list of byJourney.values()) {
    const sorted = list.slice().sort((a, b) => a.time - b.time || a.seq - b.seq);
    // Greedy scan over in-window events reaches the maximal stage.
    let stage = 0;
    for (const ev of sorted) {
      if (ev.time < startMs || ev.time >= endMs) continue;
      if (stage < STAGE_COUNT && ev.action === STAGE_ACTIONS[stage]) stage++;
    }
    if (stage === 0) continue;
    const customer = sorted[0].customer;
    const prev = reached.get(customer) ?? 0;
    if (stage > prev) reached.set(customer, stage);
  }
  const counts: StageCounts = [0, 0, 0, 0];
  for (const stage of reached.values()) {
    for (let k = 0; k < stage; k++) counts[k]++;
  }
  return counts;
}
