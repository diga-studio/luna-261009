export interface Profile {
    businessName: string;
    address: string;
    phone: string;
    hours: string[];
}
export interface ScoreInput {
    locationId: string;
    directory: string;
    revision: number;
    canonical: Profile;
    listing: Profile;
}
export interface FieldDiff {
    field: "businessName" | "address" | "phone" | "hours";
    canonical: string | string[];
    listing: string | string[];
}
export interface DirectoryResult {
    directory: string;
    score: number;
    diffs: FieldDiff[];
}
export type ScoreFn = (input: ScoreInput) => Promise<DirectoryResult>;
export interface ReadyReport {
    status: "ready";
    locationId: string;
    revision: number;
    canonical: Profile;
    listings: Record<string, Profile>;
    directories: DirectoryResult[];
}
export interface PendingReport {
    status: "pending";
    locationId: string;
    revision: number;
}
export type Report = ReadyReport | PendingReport;
