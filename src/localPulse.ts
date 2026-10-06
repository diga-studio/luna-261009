import { cloneProfile } from './scorer';
import type {
  DirectoryReport,
  DirectoryScore,
  FieldDiff,
  Profile,
  ReadyReport,
  Report,
  ScoreFn,
} from './types';
import { defaultScoreFn } from './scorer';

export interface LocalPulseOptions {
  scoreFn?: ScoreFn;
  /** 全局并发评分上限，默认 4。 */
  maxConcurrency?: number;
}

interface Computation {
  revision: number;
  canonical: Profile;
  listings: Map<string, Profile>;
  results: Map<string, DirectoryScore>;
  remaining: number;
  superseded: boolean;
}

interface QueuedJob {
  computation: Computation;
  locationId: string;
  directory: string;
}

interface LocationState {
  revision: number;
  canonical: Profile | null;
  listings: Map<string, Profile>;
  computation: Computation | null;
  readyReport: ReadyReport | null;
}

function cloneDiffs(diffs: FieldDiff[]): FieldDiff[] {
  return diffs.map((d) => ({
    field: d.field,
    canonicalValue: Array.isArray(d.canonicalValue) ? [...d.canonicalValue] : d.canonicalValue,
    listingValue: Array.isArray(d.listingValue) ? [...d.listingValue] : d.listingValue,
  }));
}

function cloneScore(score: DirectoryScore): DirectoryScore {
  return { score: score.score, diffs: cloneDiffs(score.diffs) };
}

function cloneReport(report: ReadyReport): ReadyReport {
  const listings: Record<string, Profile> = {};
  for (const [dir, profile] of Object.entries(report.listings)) {
    listings[dir] = cloneProfile(profile);
  }
  return {
    status: 'ready',
    locationId: report.locationId,
    revision: report.revision,
    canonical: cloneProfile(report.canonical),
    listings,
    directories: report.directories.map((d) => ({
      directory: d.directory,
      score: d.score,
      diffs: cloneDiffs(d.diffs),
    })),
  };
}

export class LocalPulse {
  private readonly scoreFn: ScoreFn;
  private readonly maxConcurrency: number;
  private readonly locations = new Map<string, LocationState>();
  private readonly queue: QueuedJob[] = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(options: LocalPulseOptions = {}) {
    this.scoreFn = options.scoreFn ?? defaultScoreFn;
    this.maxConcurrency = options.maxConcurrency ?? 4;
  }

  putCanonical(locationId: string, profile: Profile): number {
    const state = this.ensureLocation(locationId);
    state.canonical = cloneProfile(profile);
    return this.bumpRevision(locationId, state);
  }

  putListing(locationId: string, directory: string, profile: Profile): number {
    const state = this.locations.get(locationId);
    if (!state || state.canonical === null) {
      throw new Error(`putListing requires existing canonical for location "${locationId}"`);
    }
    state.listings.set(directory, cloneProfile(profile));
    return this.bumpRevision(locationId, state);
  }

  getReport(locationId: string): Report {
    const state = this.locations.get(locationId);
    if (!state) {
      return { status: 'pending', locationId, revision: 0 };
    }
    if (state.readyReport && state.readyReport.revision === state.revision) {
      return cloneReport(state.readyReport);
    }
    return { status: 'pending', locationId, revision: state.revision };
  }

  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.maybeResolveIdle();
    });
  }

  private ensureLocation(locationId: string): LocationState {
    let state = this.locations.get(locationId);
    if (!state) {
      state = {
        revision: 0,
        canonical: null,
        listings: new Map(),
        computation: null,
        readyReport: null,
      };
      this.locations.set(locationId, state);
    }
    return state;
  }

  /** 递增修订号，使旧报告与未完成的计算失效，并为新修订建立计算任务。 */
  private bumpRevision(locationId: string, state: LocationState): number {
    state.revision += 1;
    const revision = state.revision;

    if (state.computation && !state.computation.superseded) {
      state.computation.superseded = true;
      // 未启动的历史任务直接从队列移除，避免随修改次数无限堆积。
      for (let i = this.queue.length - 1; i >= 0; i -= 1) {
        if (this.queue[i]!.computation === state.computation) {
          this.queue.splice(i, 1);
        }
      }
    }
    state.readyReport = null;

    // 到达此处时 canonical 必然存在（putCanonical 已写入，putListing 有前置校验）。
    const canonical = cloneProfile(state.canonical!);
    const listings = new Map<string, Profile>();
    for (const [dir, profile] of state.listings) {
      listings.set(dir, cloneProfile(profile));
    }

    const computation: Computation = {
      revision,
      canonical,
      listings,
      results: new Map(),
      remaining: listings.size,
      superseded: false,
    };
    state.computation = computation;

    if (listings.size === 0) {
      // 无目录时立即就绪，目录集合为空。
      this.publish(locationId, state, computation);
      return revision;
    }

    for (const directory of listings.keys()) {
      this.queue.push({ computation, locationId, directory });
    }
    this.pump();
    return revision;
  }

  private pump(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.computation.superseded) {
        continue;
      }
      this.running += 1;
      const canonical = cloneProfile(job.computation.canonical);
      const listing = cloneProfile(job.computation.listings.get(job.directory)!);
      const input = {
        locationId: job.locationId,
        directory: job.directory,
        revision: job.computation.revision,
        canonical,
        listing,
      };
      const settle = () => {
        this.running -= 1;
        this.pump();
        this.maybeResolveIdle();
      };
      Promise.resolve()
        .then(() => this.scoreFn(input))
        .then(
          (score) => {
            this.onScoreDone(job, score);
            settle();
          },
          () => {
            // 评分按约定最终成功；失败时仅释放名额，不影响其他门店。
            settle();
          },
        );
    }
  }

  private onScoreDone(job: QueuedJob, score: DirectoryScore): void {
    const computation = job.computation;
    if (computation.superseded) {
      return;
    }
    const state = this.locations.get(job.locationId);
    if (!state || state.computation !== computation || state.revision !== computation.revision) {
      return;
    }
    computation.results.set(job.directory, cloneScore(score));
    computation.remaining -= 1;
    if (computation.remaining === 0) {
      this.publish(job.locationId, state, computation);
    }
  }

  /** 同一修订的全部目录比较完成后，一次性发布 ready 报告。 */
  private publish(locationId: string, state: LocationState, computation: Computation): void {
    if (computation.superseded || state.revision !== computation.revision) {
      return;
    }
    const listings: Record<string, Profile> = {};
    const directories: DirectoryReport[] = [];
    for (const [dir, profile] of computation.listings) {
      listings[dir] = cloneProfile(profile);
      const score = computation.results.get(dir);
      directories.push({
        directory: dir,
        score: score ? score.score : 0,
        diffs: score ? cloneDiffs(score.diffs) : [],
      });
    }
    state.readyReport = {
      status: 'ready',
      locationId,
      revision: computation.revision,
      canonical: cloneProfile(computation.canonical),
      listings,
      directories,
    };
    this.maybeResolveIdle();
  }

  private isIdle(): boolean {
    if (this.running !== 0 || this.queue.length !== 0) {
      return false;
    }
    for (const state of this.locations.values()) {
      if (!state.readyReport || state.readyReport.revision !== state.revision) {
        return false;
      }
    }
    return true;
  }

  private maybeResolveIdle(): void {
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
