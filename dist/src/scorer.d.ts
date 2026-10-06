import { FieldDiff, Profile, ScoreFn } from "./types";
export declare function scoreProfiles(canonical: Profile, listing: Profile): {
    score: number;
    diffs: FieldDiff[];
};
export declare const defaultScoreFn: ScoreFn;
