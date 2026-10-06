import { describe, it, expect } from "vitest";
import { evaluate, explainGap } from "../src/index.js";
import type { DrillAction, DrillSpec, StepSpec } from "../src/index.js";

function makeSpec(overrides: {
  steps: StepSpec[];
  roles?: Record<string, "Director" | "Responder">;
  requiredRoles?: ("Director" | "Responder")[];
  durationMs?: number;
}): DrillSpec {
  return {
    phases: [{ id: "P1", durationMs: overrides.durationMs ?? 1000 }],
    steps: overrides.steps,
    roles: overrides.roles ?? { p1: "Responder", p2: "Responder" },
    requiredRoles: overrides.requiredRoles ?? ["Responder"],
  };
}

function step(id: string, weight: number, allowedRoles: ("Director" | "Responder")[] = ["Responder"]): StepSpec {
  return { id, phaseId: "P1", nist: "identify", allowedRoles, weight };
}

function action(
  id: string,
  participantId: string,
  elapsedMs: number,
  candidateStepIds: string[],
): DrillAction {
  return { id, participantId, phaseId: "P1", nist: "identify", elapsedMs, candidateStepIds };
}

describe("evaluate", () => {
  it("avoids the greedy trap: flexible action yields to the single-purpose one", () => {
    // a_fast can prove either step; a_slow can only prove s1. Picking the
    // fastest action for s1 first would leave s2 uncovered.
    const spec = makeSpec({ steps: [step("s1", 1), step("s2", 1)] });
    const actions = [
      action("a_fast", "p1", 100, ["s1", "s2"]),
      action("a_slow", "p2", 200, ["s1"]),
    ];
    const result = evaluate(spec, actions);
    expect(result.uncoveredStepIds).toEqual([]);
    expect(result.mapping).toEqual({ a_slow: "s1", a_fast: "s2" });
    // W=2, R=1, C=2, T = 1*8 + 1*9 = 17, V=1
    // Q = (60*2 + 3*17) * 1 + 10*2*1 = 171 + 20 = 191
    expect(result.Q).toBe(191);
    expect(result.score).toBeCloseTo(191 / 2);
  });

  it("computes timeliness tiers and role bonus", () => {
    const spec = makeSpec({ steps: [step("s1", 2)] });
    const actions = [action("a1", "p1", 250, ["s1"])];
    const result = evaluate(spec, actions);
    // q = 10 - floor(10*250/1000) = 8; Q = (60*2 + 3*2*8) + 10*2 = 188
    expect(result.Q).toBe(188);
    expect(result.mapping).toEqual({ a1: "s1" });
  });

  it("rejects mismatched phase, nist tag, role, and out-of-window timing", () => {
    const spec = makeSpec({
      steps: [step("s1", 1, ["Director"])],
      roles: { p1: "Responder", p2: "Director" },
      requiredRoles: ["Director"],
    });
    const wrongRole = action("a1", "p1", 0, ["s1"]); // Responder not allowed
    const tooLate = action("a2", "p2", 1000, ["s1"]); // elapsed == duration
    const wrongTag: DrillAction = { ...action("a3", "p2", 0, ["s1"]), nist: "respond" };
    const wrongPhase: DrillAction = { ...action("a4", "p2", 0, ["s1"]), phaseId: "PX" };
    const result = evaluate(spec, [wrongRole, tooLate, wrongTag, wrongPhase]);
    expect(result.mapping).toEqual({});
    expect(result.uncoveredStepIds).toEqual(["s1"]);
    expect(result.Q).toBe(0);
  });

  it("counts distinct roles once even with multiple actions", () => {
    const spec = makeSpec({
      steps: [step("s1", 1), step("s2", 1)],
      roles: { p1: "Responder", p2: "Responder" },
      requiredRoles: ["Responder", "Director"],
    });
    const actions = [action("a1", "p1", 0, ["s1"]), action("a2", "p2", 0, ["s2"])];
    const result = evaluate(spec, actions);
    // W=2, R=2, C=2, T=20, V=1 (only Responder appears)
    // Q = (60*2 + 3*20) * 2 + 10*2*1 = 360 + 20 = 380
    expect(result.Q).toBe(380);
  });
});

describe("explainGap", () => {
  it("does not mistake an arbitrary optimum's omission for a forced gap", () => {
    // One action, two equal steps: every optimum covers exactly one of them.
    const spec = makeSpec({ steps: [step("s1", 1), step("s2", 1)] });
    const actions = [action("a1", "p1", 0, ["s1", "s2"])];
    const result = evaluate(spec, actions);
    expect(result.uncoveredStepIds).toHaveLength(1);
    const omitted = result.uncoveredStepIds[0]!;
    const explanation = explainGap(spec, actions, omitted);
    expect(explanation.kind).toBe("covered-in-optimum");
    if (explanation.kind === "covered-in-optimum") {
      expect(explanation.Q).toBe(result.Q);
      expect(explanation.mapping["a1"]).toBe(omitted);
    }
  });

  it("reports the best achievable Q when forcing coverage is costly", () => {
    // Covering the weight-1 step means giving up the weight-10 step.
    const spec = makeSpec({ steps: [step("s1", 1), step("s2", 10)] });
    const actions = [action("a1", "p1", 0, ["s1", "s2"])];
    const result = evaluate(spec, actions);
    expect(result.mapping).toEqual({ a1: "s2" });
    const explanation = explainGap(spec, actions, "s1");
    expect(explanation.kind).toBe("forced-suboptimal");
    if (explanation.kind === "forced-suboptimal") {
      // W=11, R=1: forced Q = (60*1 + 3*1*10) + 10*11 = 90 + 110 = 200
      expect(explanation.maxQ).toBe(200);
      expect(explanation.maxQ).toBeLessThan(result.Q);
      expect(explanation.mapping["a1"]).toBe("s1");
    }
  });

  it("returns infeasible when no action can ever prove the step", () => {
    const spec = makeSpec({ steps: [step("s1", 1), step("s2", 5)] });
    const actions = [action("a1", "p1", 0, ["s1"])];
    expect(explainGap(spec, actions, "s2").kind).toBe("infeasible");
  });

  it("confirms coverage in an optimum for the greedy-trap scenario", () => {
    const spec = makeSpec({ steps: [step("s1", 1), step("s2", 1)] });
    const actions = [
      action("a_fast", "p1", 100, ["s1", "s2"]),
      action("a_slow", "p2", 200, ["s1"]),
    ];
    for (const stepId of ["s1", "s2"]) {
      const explanation = explainGap(spec, actions, stepId);
      expect(explanation.kind).toBe("covered-in-optimum");
    }
  });
});
