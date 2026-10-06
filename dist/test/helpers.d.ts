import { DirectoryResult, Profile, ScoreFn, ScoreInput } from "../src/types";
export declare function makeProfile(tag: string): Profile;
export declare class ScoreGate {
    readonly calls: ScoreInput[];
    private pending;
    private started;
    private finished;
    maxInFlight: number;
    readonly fn: ScoreFn;
    get inFlight(): number;
    get pendingCount(): number;
    releaseNext(result?: DirectoryResult): ScoreInput;
    releaseMatching(pred: (input: ScoreInput) => boolean): ScoreInput;
    releaseAll(): Promise<void>;
}
export declare function flushMicrotasks(times?: number): Promise<void>;
