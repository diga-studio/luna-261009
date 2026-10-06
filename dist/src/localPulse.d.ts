import { Profile, Report, ScoreFn } from "./types";
export interface LocalPulseOptions {
    scoreFn?: ScoreFn;
    maxConcurrent?: number;
}
export declare class LocalPulse {
    private readonly scoreFn;
    private readonly maxConcurrent;
    private readonly locations;
    private readonly queue;
    private running;
    private idleWaiters;
    constructor(options?: LocalPulseOptions);
    putCanonical(locationId: string, profile: Profile): number;
    putListing(locationId: string, directory: string, profile: Profile): number;
    getReport(locationId: string): Report;
    whenIdle(): Promise<void>;
    private getOrCreate;
    private commitWrite;
    private startPass;
    private finishPass;
    private schedule;
    private pump;
    private isIdle;
    private checkIdle;
}
