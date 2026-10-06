export type Role = "Director" | "Responder";

export interface Phase {
  id: string;
  durationMs: number;
}

export interface Step {
  id: string;
  phaseId: string;
  nistTag: string;
  allowedRoles: Role[];
  weight: number;
}

export interface Spec {
  phases: Phase[];
  steps: Step[];
  requiredRoles: Role[];
  participantRoles: Record<string, Role>;
}

export interface DrillAction {
  id: string;
  participantId: string;
  phaseId: string;
  nistTag: string;
  elapsedMs: number;
  candidateStepIds: string[];
}

export interface EvaluationResult {
  /** actionId -> stepId */
  assignment: Record<string, string>;
  uncoveredStepIds: string[];
  /** optimal integer objective Q */
  Q: number;
  /** Q / (W * R) */
  score: number;
}

export type GapExplanation =
  | {
      status: "coverable-in-optimal";
      assignment: Record<string, string>;
      Q: number;
      score: number;
    }
  | { status: "requires-score-drop"; maxQ: number; maxScore: number }
  | { status: "infeasible" };
