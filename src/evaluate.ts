import type {
  DrillAction,
  DrillSpec,
  EvaluationResult,
  GapExplanation,
  Role,
} from "./types.js";
import { maxProfitMatching } from "./matching.js";
import type { MatchEdge, MatchingInput } from "./matching.js";

interface Prepared {
  W: number;
  R: number;
  /** Per action: participant role, or null when the participant is unknown. */
  actionRoles: (Role | null)[];
  /** Valid (actionIndex, stepIndex) pairs with their timeliness tier q. */
  pairs: { actionIndex: number; stepIndex: number; q: number }[];
}

function prepare(spec: DrillSpec, actions: DrillAction[]): Prepared {
  const phaseDuration = new Map<string, number>();
  for (const phase of spec.phases) {
    phaseDuration.set(phase.id, phase.durationMs);
  }
  const steps = spec.steps;
  const stepIndexById = new Map<string, number>();
  steps.forEach((step, index) => stepIndexById.set(step.id, index));

  const actionRoles = actions.map(
    (action) => spec.roles[action.participantId] ?? null,
  );

  const pairs: Prepared["pairs"] = [];
  actions.forEach((action, actionIndex) => {
    const role = actionRoles[actionIndex];
    if (role == null) return;
    const durationMs = phaseDuration.get(action.phaseId);
    if (durationMs === undefined) return;
    if (action.elapsedMs < 0 || action.elapsedMs >= durationMs) return;
    const q = 10 - Math.floor((10 * action.elapsedMs) / durationMs);
    for (const stepId of action.candidateStepIds) {
      const stepIndex = stepIndexById.get(stepId);
      if (stepIndex === undefined) continue;
      const step = steps[stepIndex]!;
      if (step.phaseId !== action.phaseId) continue;
      if (step.nist !== action.nist) continue;
      if (!step.allowedRoles.includes(role)) continue;
      pairs.push({ actionIndex, stepIndex, q });
    }
  });

  const W = steps.reduce((sum, step) => sum + step.weight, 0);
  const R = spec.requiredRoles.length;
  return { W, R, actionRoles, pairs };
}

function pairProfit(spec: DrillSpec, stepIndex: number, q: number, R: number): number {
  const weight = spec.steps[stepIndex]!.weight;
  return weight * R * (60 + 3 * q);
}

interface SolveOptions {
  /** Action index forced out of the pool (already committed elsewhere). */
  excludeAction?: number;
  /** Step index forced out of the pool. */
  excludeStep?: number;
  /** Role whose first-use bonus has already been collected. */
  spentRole?: Role;
}

function solve(
  spec: DrillSpec,
  actions: DrillAction[],
  prepared: Prepared,
  options: SolveOptions = {},
): { Q: number; mapping: Record<string, string> } {
  const { W, R, actionRoles, pairs } = prepared;
  const required = new Set<Role>(spec.requiredRoles);
  const roleBonus: Record<Role, number> = {
    Director: required.has("Director") && options.spentRole !== "Director" ? 10 * W : 0,
    Responder: required.has("Responder") && options.spentRole !== "Responder" ? 10 * W : 0,
  };

  const edges: MatchEdge[] = [];
  for (const pair of pairs) {
    if (pair.actionIndex === options.excludeAction) continue;
    if (pair.stepIndex === options.excludeStep) continue;
    edges.push({
      actionIndex: pair.actionIndex,
      stepIndex: pair.stepIndex,
      profit: pairProfit(spec, pair.stepIndex, pair.q, R),
    });
  }

  const input: MatchingInput = {
    actionCount: actions.length,
    stepCount: spec.steps.length,
    actionRoles: actionRoles.map((role) => role ?? "Director"),
    roleBonus,
    edges,
  };
  // Actions with unknown roles can never form valid pairs (they have no
  // edges), so the placeholder role above is harmless.
  const result = maxProfitMatching(input);

  const mapping: Record<string, string> = {};
  for (const [actionIndex, stepIndex] of result.assignment) {
    mapping[actions[actionIndex]!.id] = spec.steps[stepIndex]!.id;
  }
  return { Q: result.totalProfit, mapping };
}

export function evaluate(
  spec: DrillSpec,
  actions: DrillAction[],
): EvaluationResult {
  const prepared = prepare(spec, actions);
  const { Q, mapping } = solve(spec, actions, prepared);
  const covered = new Set(Object.values(mapping));
  return {
    Q,
    score: Q / (prepared.W * prepared.R),
    mapping,
    uncoveredStepIds: spec.steps
      .filter((step) => !covered.has(step.id))
      .map((step) => step.id),
  };
}

export function explainGap(
  spec: DrillSpec,
  actions: DrillAction[],
  stepId: string,
): GapExplanation {
  const stepIndex = spec.steps.findIndex((step) => step.id === stepId);
  if (stepIndex === -1) {
    throw new Error(`unknown step id: ${stepId}`);
  }
  const prepared = prepare(spec, actions);
  const { W, R } = prepared;
  const required = new Set<Role>(spec.requiredRoles);

  const optimal = solve(spec, actions, prepared);

  let bestQ = Number.NEGATIVE_INFINITY;
  let bestMapping: Record<string, string> | null = null;
  for (const pair of prepared.pairs) {
    if (pair.stepIndex !== stepIndex) continue;
    const role = prepared.actionRoles[pair.actionIndex]!;
    const fixed =
      pairProfit(spec, stepIndex, pair.q, R) + (required.has(role) ? 10 * W : 0);
    const rest = solve(spec, actions, prepared, {
      excludeAction: pair.actionIndex,
      excludeStep: stepIndex,
      spentRole: role,
    });
    const totalQ = fixed + rest.Q;
    if (totalQ > bestQ) {
      bestQ = totalQ;
      bestMapping = {
        ...rest.mapping,
        [actions[pair.actionIndex]!.id]: stepId,
      };
    }
  }

  if (bestMapping === null) {
    return { kind: "infeasible" };
  }
  if (bestQ === optimal.Q) {
    return {
      kind: "covered-in-optimum",
      Q: bestQ,
      score: bestQ / (W * R),
      mapping: bestMapping,
    };
  }
  return {
    kind: "forced-suboptimal",
    maxQ: bestQ,
    maxScore: bestQ / (W * R),
    mapping: bestMapping,
  };
}
