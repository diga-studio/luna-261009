import type { Role } from "./types.js";

export interface MatchEdge {
  actionIndex: number;
  stepIndex: number;
  /** Integer profit contribution (60*C + 3*T) * R part for this pairing. */
  profit: number;
}

export interface MatchingInput {
  actionCount: number;
  stepCount: number;
  /** Role of each action's participant. */
  actionRoles: Role[];
  /** Bonus profit granted the first time each role is used. */
  roleBonus: Record<Role, number>;
  edges: MatchEdge[];
}

export interface MatchingResult {
  totalProfit: number;
  /** actionIndex -> stepIndex */
  assignment: Map<number, number>;
}

interface Arc {
  to: number;
  rev: number;
  cap: number;
  cost: number;
}

const ROLES: Role[] = ["Director", "Responder"];

/**
 * Max-profit bipartite matching between actions and steps, where the first
 * use of each participant role grants an extra bonus. Solved as a min-cost
 * flow: source -> role -> action -> step -> sink. Each role node is fed by
 * two arcs: a capacity-1 arc carrying the (negated) first-use bonus, and an
 * uncapacitated zero-cost arc. Augmenting proceeds along shortest paths and
 * stops once the cheapest path is non-negative, which yields the maximum
 * total profit over flows of any size.
 */
export function maxProfitMatching(input: MatchingInput): MatchingResult {
  const { actionCount, stepCount, actionRoles, roleBonus, edges } = input;

  const source = 0;
  const roleNode = new Map<Role, number>();
  let next = 1;
  for (const role of ROLES) {
    roleNode.set(role, next++);
  }
  const actionBase = next;
  next += actionCount;
  const stepBase = next;
  next += stepCount;
  const sink = next;
  const nodeCount = next + 1;

  const graph: Arc[][] = Array.from({ length: nodeCount }, () => []);

  const addArc = (from: number, to: number, cap: number, cost: number): void => {
    const fwd: Arc = { to, rev: graph[to]!.length, cap, cost };
    const bwd: Arc = { to: from, rev: graph[from]!.length, cap: 0, cost: -cost };
    graph[from]!.push(fwd);
    graph[to]!.push(bwd);
  };

  for (const role of ROLES) {
    const node = roleNode.get(role)!;
    const bonus = roleBonus[role];
    addArc(source, node, 1, -bonus);
    addArc(source, node, Number.MAX_SAFE_INTEGER, 0);
  }
  for (let a = 0; a < actionCount; a++) {
    const role = actionRoles[a]!;
    addArc(roleNode.get(role)!, actionBase + a, 1, 0);
  }
  for (const edge of edges) {
    addArc(actionBase + edge.actionIndex, stepBase + edge.stepIndex, 1, -edge.profit);
  }
  for (let s = 0; s < stepCount; s++) {
    addArc(stepBase + s, sink, 1, 0);
  }

  // Successive shortest augmenting paths (Bellman-Ford; graphs are tiny).
  // No negative-cost cycles can arise because all costs on forward arcs out
  // of the source and into the sink structure are handled by SSP invariant.
  for (;;) {
    const dist = new Array<number>(nodeCount).fill(Number.POSITIVE_INFINITY);
    const prevNode = new Array<number>(nodeCount).fill(-1);
    const prevArc = new Array<number>(nodeCount).fill(-1);
    dist[source] = 0;
    let updated = true;
    for (let iter = 0; iter < nodeCount && updated; iter++) {
      updated = false;
      for (let v = 0; v < nodeCount; v++) {
        if (dist[v] === Number.POSITIVE_INFINITY) continue;
        const arcs = graph[v]!;
        for (let i = 0; i < arcs.length; i++) {
          const arc = arcs[i]!;
          if (arc.cap <= 0) continue;
          const nd = dist[v]! + arc.cost;
          if (nd < dist[arc.to]!) {
            dist[arc.to] = nd;
            prevNode[arc.to] = v;
            prevArc[arc.to] = i;
            updated = true;
          }
        }
      }
    }
    if (
      dist[sink] === Number.POSITIVE_INFINITY ||
      dist[sink]! >= 0
    ) {
      break;
    }
    let v = sink;
    while (v !== source) {
      const u = prevNode[v]!;
      const arc = graph[u]![prevArc[v]!]!;
      arc.cap -= 1;
      graph[v]![arc.rev]!.cap += 1;
      v = u;
    }
  }

  let totalProfit = 0;
  const assignment = new Map<number, number>();
  for (let a = 0; a < actionCount; a++) {
    const node = actionBase + a;
    for (const arc of graph[node]!) {
      // Forward action->step arcs carry negative cost; flow present means the
      // reverse arc gained capacity.
      if (arc.cost < 0 && arc.cap === 0) {
        const stepIndex = arc.to - stepBase;
        assignment.set(a, stepIndex);
        totalProfit += -arc.cost;
      }
    }
  }
  // Role bonuses: a role counts as used if any of its actions was matched.
  const usedRoles = new Set<Role>();
  for (const actionIndex of assignment.keys()) {
    usedRoles.add(actionRoles[actionIndex]!);
  }
  for (const role of usedRoles) {
    totalProfit += roleBonus[role];
  }

  return { totalProfit, assignment };
}
