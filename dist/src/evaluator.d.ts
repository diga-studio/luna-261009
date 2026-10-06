import type { DrillAction, EvaluationResult, GapExplanation, Spec } from "./types";
export declare function evaluate(spec: Spec, actions: DrillAction[]): EvaluationResult;
export declare function explainGap(spec: Spec, actions: DrillAction[], stepId: string): GapExplanation;
