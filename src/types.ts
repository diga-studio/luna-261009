export type Role = "Director" | "Responder";

export interface PhaseSpec {
  id: string;
  durationMs: number;
}

export interface StepSpec {
  id: string;
  phaseId: string;
  nist: string;
  allowedRoles: Role[];
  weight: number;
}

export interface DrillSpec {
  phases: PhaseSpec[];
  steps: StepSpec[];
  /** participantId -> role (trusted mapping) */
  roles: Record<string, Role>;
  requiredRoles: Role[];
}

export interface DrillAction {
  id: string;
  participantId: string;
  phaseId: string;
  nist: string;
  elapsedMs: number;
  candidateStepIds: string[];
}

export interface EvaluationResult {
  /** Maximized integer objective. */
  Q: number;
  /** Q / (W * R) */
  score: number;
  /** actionId -> stepId for matched evidence. */
  mapping: Record<string, string>;
  /** Steps left uncovered by this optimal assignment. */
  uncoveredStepIds: string[];
}

export type GapExplanation =
  | {
      kind: "covered-in-optimum";
      Q: number;
      score: number;
      /** An optimal mapping (same Q as evaluate) that covers the step. */
      mapping: Record<string, string>;
    }
  | {
      kind: "forced-suboptimal";
      /** Best Q achievable when the step is forced to be covered. */
      maxQ: number;
      maxScore: number;
      mapping: Record<string, string>;
    }
  | { kind: "infeasible" };
