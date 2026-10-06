import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, explainGap } from "../src/evaluator";
import type { DrillAction, Role, Spec } from "../src/types";

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLES: Role[] = ["Director", "Responder"];
const TAGS = ["ID", "PR", "RS"];

interface Case {
  spec: Spec;
  actions: DrillAction[];
}

function randomCase(rand: () => number): Case {
  const phaseCount = 1 + Math.floor(rand() * 2);
  const phases = Array.from({ length: phaseCount }, (_, i) => ({
    id: `P${i}`,
    durationMs: 500 + Math.floor(rand() * 1000),
  }));
  const stepCount = 1 + Math.floor(rand() * 4);
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    id: `s${i}`,
    phaseId: phases[Math.floor(rand() * phaseCount)]!.id,
    nistTag: TAGS[Math.floor(rand() * TAGS.length)]!,
    allowedRoles: ROLES.filter(() => rand() < 0.7),
    weight: 1 + Math.floor(rand() * 5),
  })).map((s) => ({
    ...s,
    allowedRoles: s.allowedRoles.length > 0 ? s.allowedRoles : ["Responder" as Role],
  }));
  const participantCount = 1 + Math.floor(rand() * 3);
  const participantRoles: Record<string, Role> = {};
  for (let i = 0; i < participantCount; i++) {
    participantRoles[`p${i}`] = ROLES[Math.floor(rand() * 2)]!;
  }
  const requiredRoles: Role[] =
    rand() < 0.5 ? ["Director"] : rand() < 0.5 ? ["Responder"] : ["Director", "Responder"];
  const actionCount = Math.floor(rand() * 5);
  const actions: DrillAction[] = Array.from({ length: actionCount }, (_, i) => {
    const phase = phases[Math.floor(rand() * phaseCount)]!;
    const candidates = steps
      .filter(() => rand() < 0.5)
      .map((s) => s.id);
    return {
      id: `a${i}`,
      participantId: `p${Math.floor(rand() * participantCount)}`,
      phaseId: phase.id,
      nistTag: TAGS[Math.floor(rand() * TAGS.length)]!,
      elapsedMs: Math.floor(rand() * (phase.durationMs + 200)) - 50,
      candidateStepIds: candidates,
    };
  });
  return { spec: { phases, steps, requiredRoles, participantRoles }, actions };
}

/** Independent brute-force optimum over all legal action->step assignments. */
function bruteForce(spec: Spec, actions: DrillAction[], mustCover?: string): number | null {
  const W = spec.steps.reduce((s, x) => s + x.weight, 0);
  const R = spec.requiredRoles.length;
  const phaseDur = new Map(spec.phases.map((p) => [p.id, p.durationMs]));
  const stepIdx = new Map(spec.steps.map((s, i) => [s.id, i]));

  const valid = (a: DrillAction, si: number): number | null => {
    const s = spec.steps[si]!;
    const dur = phaseDur.get(a.phaseId)!;
    if (a.elapsedMs < 0 || a.elapsedMs >= dur) return null;
    if (!a.candidateStepIds.includes(s.id)) return null;
    if (s.phaseId !== a.phaseId || s.nistTag !== a.nistTag) return null;
    const role = spec.participantRoles[a.participantId]!;
    if (!s.allowedRoles.includes(role)) return null;
    const q = 10 - Math.floor((10 * a.elapsedMs) / dur);
    return s.weight * (60 + 3 * q);
  };

  let best: number | null = null;
  const usedSteps = new Array<boolean>(spec.steps.length).fill(false);
  const chosen: (number | null)[] = new Array(actions.length).fill(null);

  const rec = (ai: number): void => {
    if (ai === actions.length) {
      if (mustCover !== undefined) {
        const mi = stepIdx.get(mustCover)!;
        if (!chosen.includes(mi)) return;
      }
      let C = 0;
      let T = 0;
      const usedRoles = new Set<Role>();
      for (let i = 0; i < actions.length; i++) {
        const si = chosen[i]!;
        if (si === null) continue;
        valid(actions[i]!, si);
        C += spec.steps[si]!.weight;
        const dur = phaseDur.get(actions[i]!.phaseId)!;
        const q = 10 - Math.floor((10 * actions[i]!.elapsedMs) / dur);
        T += spec.steps[si]!.weight * q;
        usedRoles.add(spec.participantRoles[actions[i]!.participantId]!);
      }
      const V = spec.requiredRoles.filter((r) => usedRoles.has(r)).length;
      const Q = (60 * C + 3 * T) * R + 10 * W * V;
      if (best === null || Q > best) best = Q;
      return;
    }
    rec(ai + 1); // action unused
    for (let si = 0; si < spec.steps.length; si++) {
      if (usedSteps[si]) continue;
      if (valid(actions[ai]!, si) === null) continue;
      usedSteps[si] = true;
      chosen[ai] = si;
      rec(ai + 1);
      chosen[ai] = null;
      usedSteps[si] = false;
    }
  };
  rec(0);
  return best;
}

test("evaluate matches brute-force optimum on randomized small cases", () => {
  const rand = mulberry32(26100901);
  for (let iter = 0; iter < 300; iter++) {
    const { spec, actions } = randomCase(rand);
    const expected = bruteForce(spec, actions)!; // empty assignment always legal
    const result = evaluate(spec, actions);
    assert.equal(result.Q, expected, `iteration ${iter}`);
  }
});

test("explainGap matches brute-force constrained optimum", () => {
  const rand = mulberry32(977);
  for (let iter = 0; iter < 300; iter++) {
    const { spec, actions } = randomCase(rand);
    const optimalQ = bruteForce(spec, actions)!;
    for (const s of spec.steps) {
      const forced = bruteForce(spec, actions, s.id);
      const gap = explainGap(spec, actions, s.id);
      if (forced === null) {
        assert.equal(gap.status, "infeasible", `iter ${iter} step ${s.id}`);
      } else if (forced === optimalQ) {
        assert.equal(gap.status, "coverable-in-optimal", `iter ${iter} step ${s.id}`);
        if (gap.status === "coverable-in-optimal") {
          assert.equal(gap.Q, optimalQ);
          assert.ok(Object.values(gap.assignment).includes(s.id));
        }
      } else {
        assert.equal(gap.status, "requires-score-drop", `iter ${iter} step ${s.id}`);
        if (gap.status === "requires-score-drop") assert.equal(gap.maxQ, forced);
      }
    }
  }
});
