import { describe, it, expect } from "vitest";
import { evaluate, explainGap } from "../src/index.js";
import type { DrillAction, DrillSpec, Role } from "../src/index.js";

const ROLES: Role[] = ["Director", "Responder"];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(rand: () => number): { spec: DrillSpec; actions: DrillAction[] } {
  const phases = [
    { id: "P1", durationMs: 1000 },
    { id: "P2", durationMs: 2000 },
  ];
  const tags = ["identify", "respond"];
  const stepCount = 1 + Math.floor(rand() * 4);
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    id: `s${i}`,
    phaseId: phases[Math.floor(rand() * phases.length)]!.id,
    nist: tags[Math.floor(rand() * tags.length)]!,
    allowedRoles: rand() < 0.5 ? [...ROLES] : [ROLES[Math.floor(rand() * 2)]!],
    weight: 1 + Math.floor(rand() * 5),
  }));
  const roles: Record<string, Role> = { p1: "Director", p2: "Responder", p3: "Responder" };
  const actionCount = Math.floor(rand() * 6);
  const actions: DrillAction[] = Array.from({ length: actionCount }, (_, i) => {
    const phase = phases[Math.floor(rand() * phases.length)]!;
    const candidates = steps.filter(() => rand() < 0.5).map((s) => s.id);
    return {
      id: `a${i}`,
      participantId: `p${1 + Math.floor(rand() * 3)}`,
      phaseId: phase.id,
      nist: tags[Math.floor(rand() * tags.length)]!,
      elapsedMs: Math.floor(rand() * phase.durationMs * 1.2),
      candidateStepIds: candidates,
    };
  });
  const requiredRoles = rand() < 0.5 ? [...ROLES] : [ROLES[Math.floor(rand() * 2)]!];
  return { spec: { phases, steps, roles, requiredRoles }, actions };
}

function isValid(spec: DrillSpec, action: DrillAction, stepId: string): boolean {
  const step = spec.steps.find((s) => s.id === stepId);
  if (!step) return false;
  const role = spec.roles[action.participantId];
  if (!role) return false;
  const phase = spec.phases.find((p) => p.id === action.phaseId);
  if (!phase) return false;
  return (
    action.candidateStepIds.includes(stepId) &&
    step.phaseId === action.phaseId &&
    step.nist === action.nist &&
    step.allowedRoles.includes(role) &&
    action.elapsedMs >= 0 &&
    action.elapsedMs < phase.durationMs
  );
}

function qOf(spec: DrillSpec, action: DrillAction): number {
  const phase = spec.phases.find((p) => p.id === action.phaseId)!;
  return 10 - Math.floor((10 * action.elapsedMs) / phase.durationMs);
}

/** Exhaustive search over all matchings; optionally force a step to be covered. */
function bruteForce(spec: DrillSpec, actions: DrillAction[], forcedStepId?: string): number | null {
  const W = spec.steps.reduce((sum, s) => sum + s.weight, 0);
  const R = spec.requiredRoles.length;
  let best: number | null = null;

  const usedSteps = new Set<string>();
  const usedRoles = new Set<Role>();
  let base = 0;

  const finish = (): void => {
    if (forcedStepId !== undefined && !usedSteps.has(forcedStepId)) return;
    const V = [...usedRoles].filter((r) => spec.requiredRoles.includes(r)).length;
    const Q = base * R + 10 * W * V;
    if (best === null || Q > best) best = Q;
  };

  const roleUse = new Map<Role, number>(ROLES.map((r) => [r, 0]));
  const walk = (actionIndex: number): void => {
    if (actionIndex === actions.length) {
      finish();
      return;
    }
    walk(actionIndex + 1); // leave action unused
    const action = actions[actionIndex]!;
    for (const stepId of action.candidateStepIds) {
      if (usedSteps.has(stepId)) continue;
      if (!isValid(spec, action, stepId)) continue;
      const step = spec.steps.find((s) => s.id === stepId)!;
      const role = spec.roles[action.participantId]!;
      usedSteps.add(stepId);
      usedRoles.add(role);
      roleUse.set(role, roleUse.get(role)! + 1);
      base += step.weight * (60 + 3 * qOf(spec, action));
      walk(actionIndex + 1);
      base -= step.weight * (60 + 3 * qOf(spec, action));
      roleUse.set(role, roleUse.get(role)! - 1);
      if (roleUse.get(role) === 0) usedRoles.delete(role);
      usedSteps.delete(stepId);
    }
  };
  walk(0);
  return best;
}

describe("brute-force cross-check", () => {
  it("matches exhaustive search on random small cases", () => {
    const rand = rng(42);
    for (let trial = 0; trial < 150; trial++) {
      const { spec, actions } = randomCase(rand);
      const result = evaluate(spec, actions);
      expect(result.Q).toBe(bruteForce(spec, actions));

      for (const step of spec.steps) {
        const explanation = explainGap(spec, actions, step.id);
        const forced = bruteForce(spec, actions, step.id);
        if (forced === null) {
          expect(explanation.kind).toBe("infeasible");
        } else if (forced === result.Q) {
          expect(explanation.kind).toBe("covered-in-optimum");
          if (explanation.kind === "covered-in-optimum") {
            expect(explanation.Q).toBe(forced);
            expect(Object.values(explanation.mapping)).toContain(step.id);
          }
        } else {
          expect(explanation.kind).toBe("forced-suboptimal");
          if (explanation.kind === "forced-suboptimal") {
            expect(explanation.maxQ).toBe(forced);
            expect(Object.values(explanation.mapping)).toContain(step.id);
          }
        }
      }
    }
  });
});
