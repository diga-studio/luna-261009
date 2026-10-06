"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const evaluator_1 = require("../src/evaluator");
const PHASE = { id: "P1", durationMs: 1000 };
function makeSpec(steps, requiredRoles, participantRoles) {
    return { phases: [PHASE], steps, requiredRoles, participantRoles };
}
function step(id, weight, allowedRoles = ["Responder"], nistTag = "ID") {
    return { id, phaseId: PHASE.id, nistTag, allowedRoles, weight };
}
function action(id, participantId, elapsedMs, candidateStepIds, nistTag = "ID") {
    return { id, participantId, phaseId: PHASE.id, nistTag, elapsedMs, candidateStepIds };
}
// q for elapsed 0 in a 1000ms phase is 10, so a weight-1 step edge is 90.
const Q10_EDGE = 1 * (60 + 3 * 10);
(0, node_test_1.default)("global optimum beats fastest-action-first greedy (flexible action must yield)", () => {
    const spec = makeSpec([step("s1", 1), step("s2", 1)], ["Responder"], { pFast: "Responder", pSlow: "Responder" });
    const actions = [
        action("a_fast", "pFast", 0, ["s1", "s2"]),
        action("a_slow", "pSlow", 900, ["s1"]), // q = 1 -> edge weight 63
    ];
    // Greedy on the fastest action grabs s1 and strands s2 (a_slow cannot prove s2).
    // Optimum: a_fast -> s2 (90), a_slow -> s1 (63), total 153.
    const result = (0, evaluator_1.evaluate)(spec, actions);
    strict_1.default.deepEqual(result.uncoveredStepIds, []);
    strict_1.default.equal(result.assignment.a_fast, "s2");
    strict_1.default.equal(result.assignment.a_slow, "s1");
    strict_1.default.equal(result.Q, 153 * 1 + 10 * 2 * 1);
    strict_1.default.equal(result.score, 173 / 2);
});
(0, node_test_1.default)("tied optima swap the omitted step: no omission is a necessary gap", () => {
    const spec = makeSpec([step("s1", 1), step("s2", 1), step("s3", 1)], ["Responder"], { p1: "Responder", p2: "Responder" });
    const actions = [
        action("a1", "p1", 0, ["s1", "s2"]),
        action("a2", "p2", 0, ["s2", "s3"]),
    ];
    // Every optimum covers exactly 2 of 3 steps (weight 180); which step is
    // left out depends on the tie-broken mapping.
    const result = (0, evaluator_1.evaluate)(spec, actions);
    strict_1.default.equal(result.Q, 2 * Q10_EDGE + 10 * 3 * 1);
    strict_1.default.equal(result.uncoveredStepIds.length, 1);
    // Whichever step evaluate happened to drop, each step is coverable in
    // some equally-scored optimal mapping.
    for (const stepId of ["s1", "s2", "s3"]) {
        const gap = (0, evaluator_1.explainGap)(spec, actions, stepId);
        strict_1.default.equal(gap.status, "coverable-in-optimal", `step ${stepId}`);
        if (gap.status !== "coverable-in-optimal")
            continue;
        strict_1.default.equal(gap.Q, result.Q);
        strict_1.default.ok(Object.values(gap.assignment).includes(stepId));
        strict_1.default.equal(Object.keys(gap.assignment).length, 2);
    }
});
(0, node_test_1.default)("role bonus counts distinct required roles, shared across the drill", () => {
    const spec = makeSpec([step("s1", 1, ["Director"]), step("s2", 1, ["Responder"])], ["Director", "Responder"], { pDir: "Director", pRes: "Responder" });
    const actions = [
        action("a1", "pDir", 0, ["s1"]),
        action("a2", "pRes", 0, ["s2"]),
    ];
    const result = (0, evaluator_1.evaluate)(spec, actions);
    // (60C+3T)=180, R=2, V=2, W=2 -> Q = 180*2 + 10*2*2 = 400
    strict_1.default.equal(result.Q, 400);
    strict_1.default.equal(result.score, 100);
});
(0, node_test_1.default)("role bonus counts roles, not actions or people", () => {
    const spec = makeSpec([step("s1", 1), step("s2", 1)], ["Director", "Responder"], { p1: "Responder", p2: "Responder" });
    const actions = [
        action("a1", "p1", 0, ["s1"]),
        action("a2", "p2", 0, ["s2"]),
    ];
    const result = (0, evaluator_1.evaluate)(spec, actions);
    // Both steps covered but only Responder appears: V=1.
    // Q = 180*2 + 10*2*1 = 380
    strict_1.default.equal(result.Q, 380);
    strict_1.default.deepEqual(result.uncoveredStepIds, []);
});
(0, node_test_1.default)("explainGap reports requires-score-drop when covering costs score", () => {
    const spec = makeSpec([step("s1", 1), step("s2", 10)], ["Responder"], { p1: "Responder" });
    const actions = [action("a1", "p1", 0, ["s1", "s2"])];
    const result = (0, evaluator_1.evaluate)(spec, actions);
    // Optimum spends the single action on the heavy step: Q = 900 + 10*11 = 1010.
    strict_1.default.equal(result.Q, 900 + 10 * 11);
    strict_1.default.deepEqual(result.uncoveredStepIds, ["s1"]);
    const gap = (0, evaluator_1.explainGap)(spec, actions, "s1");
    strict_1.default.equal(gap.status, "requires-score-drop");
    if (gap.status !== "requires-score-drop")
        return;
    // Forcing s1 means a1 -> s1: Q = 90 + 10*11 = 200.
    strict_1.default.equal(gap.maxQ, 200);
    strict_1.default.equal(gap.maxScore, 200 / 11);
});
(0, node_test_1.default)("explainGap reports infeasible when no action can ever prove the step", () => {
    const spec = makeSpec([step("s1", 1, ["Director"]), step("s2", 1)], ["Responder"], { p1: "Responder" });
    const actions = [action("a1", "p1", 0, ["s2"])];
    const gap = (0, evaluator_1.explainGap)(spec, actions, "s1"); // needs a Director, none exists
    strict_1.default.equal(gap.status, "infeasible");
});
(0, node_test_1.default)("matching respects phase, NIST tag, role, and timing window", () => {
    const spec = makeSpec([
        step("wrongPhase", 1),
        step("wrongTag", 1),
        step("wrongRole", 1, ["Director"]),
        step("late", 1),
        step("ok", 1),
    ], ["Responder"], { p1: "Responder" });
    spec.phases.push({ id: "P2", durationMs: 500 });
    const okStep = spec.steps.find((s) => s.id === "ok");
    okStep.phaseId = "P2";
    const actions = [
        action("a1", "p1", 0, ["wrongPhase"], "ID"), // candidate step is in P1... ok
        action("a2", "p1", 0, ["wrongTag"], "RS"), // tag mismatch
        action("a3", "p1", 0, ["wrongRole"]), // role not allowed
        action("a4", "p1", 1000, ["late"]), // elapsed == duration -> outside window
        action("a5", "p1", 100, ["ok"]), // wrong phase: action in P1, step in P2
    ];
    // Fix a1: it is in P1 and wrongPhase is in P1, so it actually matches.
    // Make a1's step unreachable instead by moving the action to P2.
    actions[0] = { ...actions[0], phaseId: "P2" };
    const result = (0, evaluator_1.evaluate)(spec, actions);
    strict_1.default.deepEqual(result.uncoveredStepIds.sort(), [
        "late",
        "ok",
        "wrongPhase",
        "wrongRole",
        "wrongTag",
    ]);
    strict_1.default.equal(result.Q, 0);
});
(0, node_test_1.default)("negative or out-of-window elapsedMs yields no evidence", () => {
    const spec = makeSpec([step("s1", 1)], ["Responder"], { p1: "Responder" });
    const result = (0, evaluator_1.evaluate)(spec, [
        action("a1", "p1", -5, ["s1"]),
        action("a2", "p1", 1000, ["s1"]),
    ]);
    strict_1.default.deepEqual(result.uncoveredStepIds, ["s1"]);
    strict_1.default.equal(result.Q, 0);
});
(0, node_test_1.default)("timeliness tier q scales the 3T term", () => {
    const spec = makeSpec([step("s1", 2)], ["Responder"], { p1: "Responder" });
    // elapsed 250/1000 -> floor(2.5)=2 -> q=8 -> edge = 2*(60+24)=168
    const result = (0, evaluator_1.evaluate)(spec, [action("a1", "p1", 250, ["s1"])]);
    strict_1.default.equal(result.Q, 168 + 10 * 2 * 1);
});
(0, node_test_1.default)("unknown references are rejected", () => {
    const spec = makeSpec([step("s1", 1)], ["Responder"], { p1: "Responder" });
    strict_1.default.throws(() => (0, evaluator_1.evaluate)(spec, [action("a1", "ghost", 0, ["s1"])]));
    strict_1.default.throws(() => (0, evaluator_1.evaluate)(spec, [action("a1", "p1", 0, ["nope"])]));
    strict_1.default.throws(() => (0, evaluator_1.explainGap)(spec, [], "nope"));
});
