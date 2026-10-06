import { defaultScoreFn } from "./scorer";
import { DirectoryResult, Profile, ReadyReport, Report, ScoreFn } from "./types";

export interface LocalPulseOptions {
  scoreFn?: ScoreFn;
  maxConcurrent?: number;
}

function cloneProfile(profile: Profile): Profile {
  return {
    businessName: profile.businessName,
    address: profile.address,
    phone: profile.phone,
    hours: [...profile.hours],
  };
}

function cloneReport(report: ReadyReport): ReadyReport {
  const listings: Record<string, Profile> = {};
  for (const [directory, profile] of Object.entries(report.listings)) {
    listings[directory] = cloneProfile(profile);
  }
  return {
    status: "ready",
    locationId: report.locationId,
    revision: report.revision,
    canonical: cloneProfile(report.canonical),
    listings,
    directories: report.directories.map((d) => ({
      directory: d.directory,
      score: d.score,
      diffs: d.diffs.map((diff) => ({
        field: diff.field,
        canonical: Array.isArray(diff.canonical) ? [...diff.canonical] : diff.canonical,
        listing: Array.isArray(diff.listing) ? [...diff.listing] : diff.listing,
      })),
    })),
  };
}

interface ScoringPass {
  revision: number;
  canonical: Profile;
  listings: Map<string, Profile>;
  results: Map<string, DirectoryResult>;
  remaining: number;
}

interface LocationState {
  revision: number;
  canonical: Profile;
  listings: Map<string, Profile>;
  published: ReadyReport | null;
  pass: ScoringPass | null;
}

export class LocalPulse {
  private readonly scoreFn: ScoreFn;
  private readonly maxConcurrent: number;
  private readonly locations = new Map<string, LocationState>();
  private readonly queue: Array<() => Promise<void>> = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(options: LocalPulseOptions = {}) {
    this.scoreFn = options.scoreFn ?? defaultScoreFn;
    this.maxConcurrent = options.maxConcurrent ?? 4;
  }

  putCanonical(locationId: string, profile: Profile): number {
    const state = this.getOrCreate(locationId);
    state.canonical = cloneProfile(profile);
    return this.commitWrite(locationId, state);
  }

  putListing(locationId: string, directory: string, profile: Profile): number {
    const state = this.locations.get(locationId);
    if (!state) {
      throw new Error(`unknown location: ${locationId}`);
    }
    state.listings.set(directory, cloneProfile(profile));
    return this.commitWrite(locationId, state);
  }

  getReport(locationId: string): Report {
    const state = this.locations.get(locationId);
    if (!state) {
      return { status: "pending", locationId, revision: 0 };
    }
    if (state.published && state.published.revision === state.revision) {
      return cloneReport(state.published);
    }
    return { status: "pending", locationId, revision: state.revision };
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private getOrCreate(locationId: string): LocationState {
    let state = this.locations.get(locationId);
    if (!state) {
      state = {
        revision: 0,
        canonical: { businessName: "", address: "", phone: "", hours: [] },
        listings: new Map(),
        published: null,
        pass: null,
      };
      this.locations.set(locationId, state);
    }
    return state;
  }

  private commitWrite(locationId: string, state: LocationState): number {
    state.revision += 1;
    if (state.published && state.published.revision !== state.revision) {
      state.published = null;
    }
    if (!state.pass) {
      this.startPass(locationId, state);
    }
    return state.revision;
  }

  private startPass(locationId: string, state: LocationState): void {
    const pass: ScoringPass = {
      revision: state.revision,
      canonical: cloneProfile(state.canonical),
      listings: new Map([...state.listings].map(([d, p]) => [d, cloneProfile(p)])),
      results: new Map(),
      remaining: state.listings.size,
    };
    state.pass = pass;
    if (pass.remaining === 0) {
      this.finishPass(locationId, state, pass);
      return;
    }
    for (const [directory, listing] of pass.listings) {
      const canonical = pass.canonical;
      this.schedule(async () => {
        const result = await this.scoreFn({
          locationId,
          directory,
          revision: pass.revision,
          canonical: cloneProfile(canonical),
          listing: cloneProfile(listing),
        });
        pass.results.set(directory, {
          directory,
          score: result.score,
          diffs: result.diffs,
        });
        pass.remaining -= 1;
        if (pass.remaining === 0) {
          this.finishPass(locationId, state, pass);
        }
      });
    }
  }

  private finishPass(locationId: string, state: LocationState, pass: ScoringPass): void {
    if (state.pass !== pass) {
      return;
    }
    state.pass = null;
    if (state.revision === pass.revision) {
      const listings: Record<string, Profile> = {};
      for (const [directory, profile] of pass.listings) {
        listings[directory] = cloneProfile(profile);
      }
      state.published = {
        status: "ready",
        locationId,
        revision: pass.revision,
        canonical: cloneProfile(pass.canonical),
        listings,
        directories: [...pass.results.values()],
      };
    }
    if (state.revision !== pass.revision || !state.published) {
      this.startPass(locationId, state);
    }
    this.checkIdle();
  }

  private schedule(task: () => Promise<void>): void {
    this.queue.push(task);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running += 1;
      task()
        .catch(() => {})
        .then(() => {
          this.running -= 1;
          this.pump();
          this.checkIdle();
        });
    }
  }

  private isIdle(): boolean {
    if (this.running > 0 || this.queue.length > 0) {
      return false;
    }
    for (const state of this.locations.values()) {
      if (!state.published || state.published.revision !== state.revision) {
        return false;
      }
    }
    return true;
  }

  private checkIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
