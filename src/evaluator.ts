import { maxWeightMatching } from "./matching";
import type {
  DrillAction,
  EvaluationResult,
  GapExplanation,
  Role,
  Spec,
  Step,
} from "./types";

interface Edge {
  stepIndex: number;
  weight: number; // w_s * (60 + 3q), the per-edge contribution to 60C + 3T
}

interface Ctx {
  steps: Step[];
  actions: DrillAction[];
  actionRoles: Role[];
  /** edges[actionIndex] = valid provable steps with weights */
  edges: Edge[][];
  W: number; // total step weight
  R: number; // |requiredRoles|
  requiredRoles: Role[];
}

interface ConstrainedResult {
  weight: number; // max 60C + 3T under the constraints
  pairs: Map<number, number>; // actionIndex -> stepIndex
}

function validateSpec(spec: Spec): void {
  if (spec.steps.length === 0) throw new Error("spec must contain at least one step");
  if (spec.requiredRoles.length === 0)
    throw new Error("spec.requiredRoles must be non-empty");
  for (const p of spec.phases) {
    if (!Number.isFinite(p.durationMs) || p.durationMs <= 0)
      throw new Error(`phase ${p.id} must have a positive durationMs`);
  }
  for (const s of spec.steps) {
    if (!Number.isFinite(s.weight) || s.weight <= 0)
      throw new Error(`step ${s.id} must have a positive weight`);
    if (!spec.phases.some((p) => p.id === s.phaseId))
      throw new Error(`step ${s.id} references unknown phase ${s.phaseId}`);
  }
}

function buildContext(spec: Spec, actions: DrillAction[]): Ctx {
  validateSpec(spec);
  const phaseDuration = new Map(spec.phases.map((p) => [p.id, p.durationMs]));
  const stepIndexById = new Map(spec.steps.map((s, i) => [s.id, i]));

  const actionRoles: Role[] = actions.map((a) => {
    const role = spec.participantRoles[a.participantId];
    if (role === undefined)
      throw new Error(`no trusted role mapping for participant ${a.participantId}`);
    return role;
  });

  const edges: Edge[][] = actions.map((a, ai) => {
    const duration = phaseDuration.get(a.phaseId);
    if (duration === undefined)
      throw new Error(`action ${a.id} references unknown phase ${a.phaseId}`);
    const inWindow = a.elapsedMs >= 0 && a.elapsedMs < duration;
    const out: Edge[] = [];
    if (!inWindow) return out;
    const q = 10 - Math.floor((10 * a.elapsedMs) / duration);
    const seen = new Set<number>();
    for (const stepId of a.candidateStepIds) {
      const si = stepIndexById.get(stepId);
      if (si === undefined)
        throw new Error(`action ${a.id} declares unknown candidate step ${stepId}`);
      if (seen.has(si)) continue;
      seen.add(si);
      const s = spec.steps[si]!;
      if (s.phaseId !== a.phaseId) continue;
      if (s.nistTag !== a.nistTag) continue;
      if (!s.allowedRoles.includes(actionRoles[ai]!)) continue;
      out.push({ stepIndex: si, weight: s.weight * (60 + 3 * q) });
    }
    return out;
  });

  return {
    steps: spec.steps,
    actions,
    actionRoles,
    edges,
    W: spec.steps.reduce((sum, s) => sum + s.weight, 0),
    R: spec.requiredRoles.length,
    requiredRoles: [...spec.requiredRoles],
  };
}

/**
 * Max 60C+3T over matchings that use only allowed (non-forbidden-role,
 * available) actions and use every role in `forced` at least once.
 * Returns null when the forced roles cannot all appear.
 */
function bestConstrained(
  ctx: Ctx,
  availActions: boolean[],
  availSteps: boolean[],
  forbidden: ReadonlySet<Role>,
  forced: readonly Role[],
): ConstrainedResult | null {
  if (forced.length > 0) {
    const role = forced[0]!;
    const rest = forced.slice(1);
    let best: ConstrainedResult | null = null;
    for (let ai = 0; ai < ctx.actions.length; ai++) {
      if (!availActions[ai]) continue;
      if (ctx.actionRoles[ai] !== role) continue;
      if (forbidden.has(role)) continue;
      for (const e of ctx.edges[ai]!) {
        if (!availSteps[e.stepIndex]) continue;
        const nextActions = availActions.slice();
        const nextSteps = availSteps.slice();
        nextActions[ai] = false;
        nextSteps[e.stepIndex] = false;
        const sub = bestConstrained(ctx, nextActions, nextSteps, forbidden, rest);
        if (sub === null) continue;
        const weight = e.weight + sub.weight;
        if (best === null || weight > best.weight) {
          best = { weight, pairs: new Map([[ai, e.stepIndex], ...sub.pairs]) };
        }
      }
    }
    return best;
  }

  const actionIdxMap = new Map<number, number>();
  const stepIdxMap = new Map<number, number>();
  const keptActions: number[] = [];
  const keptSteps: number[] = [];
  for (let ai = 0; ai < ctx.actions.length; ai++) {
    if (!availActions[ai]) continue;
    if (forbidden.has(ctx.actionRoles[ai]!)) continue;
    actionIdxMap.set(keptActions.length, ai);
    keptActions.push(ai);
  }
  for (let si = 0; si < ctx.steps.length; si++) {
    if (!availSteps[si]) continue;
    stepIdxMap.set(keptSteps.length, si);
    keptSteps.push(si);
  }
  const mEdges = [];
  for (let ka = 0; ka < keptActions.length; ka++) {
    for (const e of ctx.edges[keptActions[ka]!]!) {
      const ks = keptSteps.indexOf(e.stepIndex);
      if (ks === -1) continue;
      mEdges.push({ actionIndex: ka, stepIndex: ks, weight: e.weight });
    }
  }
  const r = maxWeightMatching(keptActions.length, keptSteps.length, mEdges);
  const pairs = new Map<number, number>();
  for (const [ka, ks] of r.pairs) {
    pairs.set(actionIdxMap.get(ka)!, stepIdxMap.get(ks)!);
  }
  return { weight: r.totalWeight, pairs };
}

function subsets<T>(items: T[]): T[][] {
  const out: T[][] = [[]];
  for (const item of items) {
    const n = out.length;
    for (let i = 0; i < n; i++) out.push([...out[i]!, item]);
  }
  return out;
}

interface ScoredSolution {
  Q: number;
  pairs: Map<number, number>;
}

/**
 * Best solution whose set of used required roles is exactly `usedSet`:
 * required roles outside the set are forbidden, roles inside must appear.
 */
function bestForUsedRoleSet(ctx: Ctx, usedSet: Role[]): ScoredSolution | null {
  const forbidden = new Set(ctx.requiredRoles.filter((r) => !usedSet.includes(r)));
  const res = bestConstrained(
    ctx,
    new Array(ctx.actions.length).fill(true),
    new Array(ctx.steps.length).fill(true),
    forbidden,
    usedSet,
  );
  if (res === null) return null;
  return { Q: res.weight * ctx.R + 10 * ctx.W * usedSet.length, pairs: res.pairs };
}

function bestOverall(ctx: Ctx): ScoredSolution {
  let best: ScoredSolution | null = null;
  for (const usedSet of subsets(ctx.requiredRoles)) {
    const sol = bestForUsedRoleSet(ctx, usedSet);
    if (sol !== null && (best === null || sol.Q > best.Q)) best = sol;
  }
  // The empty used-set is always feasible, so best is never null here.
  return best!;
}

function toEvaluationResult(ctx: Ctx, sol: ScoredSolution): EvaluationResult {
  const assignment: Record<string, string> = {};
  const covered = new Set<number>();
  for (const [ai, si] of sol.pairs) {
    assignment[ctx.actions[ai]!.id] = ctx.steps[si]!.id;
    covered.add(si);
  }
  return {
    assignment,
    uncoveredStepIds: ctx.steps
      .filter((_, i) => !covered.has(i))
      .map((s) => s.id),
    Q: sol.Q,
    score: sol.Q / (ctx.W * ctx.R),
  };
}

export function evaluate(spec: Spec, actions: DrillAction[]): EvaluationResult {
  const ctx = buildContext(spec, actions);
  return toEvaluationResult(ctx, bestOverall(ctx));
}

export function explainGap(
  spec: Spec,
  actions: DrillAction[],
  stepId: string,
): GapExplanation {
  const ctx = buildContext(spec, actions);
  const stepIndex = ctx.steps.findIndex((s) => s.id === stepId);
  if (stepIndex === -1) throw new Error(`unknown step ${stepId}`);

  const optimal = bestOverall(ctx);

  // Best Q among solutions that cover stepIndex: force each possible
  // witness edge (action -> stepIndex) in turn, then complete optimally
  // under every exact used-required-role set compatible with the witness.
  let bestCovering: ScoredSolution | null = null;
  for (let ai = 0; ai < ctx.actions.length; ai++) {
    const witness = ctx.edges[ai]!.find((e) => e.stepIndex === stepIndex);
    if (witness === undefined) continue;
    const witnessRole = ctx.actionRoles[ai]!;
    for (const usedSet of subsets(ctx.requiredRoles)) {
      if (ctx.requiredRoles.includes(witnessRole) && !usedSet.includes(witnessRole))
        continue; // witness uses a required role outside the exact set
      const forbidden = new Set(
        ctx.requiredRoles.filter((r) => !usedSet.includes(r)),
      );
      const remainingForced = usedSet.filter((r) => r !== witnessRole);
      const availActions = new Array(ctx.actions.length).fill(true);
      const availSteps = new Array(ctx.steps.length).fill(true);
      availActions[ai] = false;
      availSteps[stepIndex] = false;
      const sub = bestConstrained(
        ctx,
        availActions,
        availSteps,
        forbidden,
        remainingForced,
      );
      if (sub === null) continue;
      const weight = witness.weight + sub.weight;
      const Q = weight * ctx.R + 10 * ctx.W * usedSet.length;
      if (bestCovering === null || Q > bestCovering.Q) {
        bestCovering = {
          Q,
          pairs: new Map([[ai, stepIndex], ...sub.pairs]),
        };
      }
    }
  }

  if (bestCovering === null) return { status: "infeasible" };
  if (bestCovering.Q === optimal.Q) {
    const result = toEvaluationResult(ctx, bestCovering);
    return {
      status: "coverable-in-optimal",
      assignment: result.assignment,
      Q: result.Q,
      score: result.score,
    };
  }
  return {
    status: "requires-score-drop",
    maxQ: bestCovering.Q,
    maxScore: bestCovering.Q / (ctx.W * ctx.R),
  };
}
