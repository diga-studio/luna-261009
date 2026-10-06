import { scoreProfiles } from "../src/scorer";
import { DirectoryResult, Profile, ScoreFn, ScoreInput } from "../src/types";

export function makeProfile(tag: string): Profile {
  return {
    businessName: `name-${tag}`,
    address: `addr-${tag}`,
    phone: `phone-${tag}`,
    hours: Array.from({ length: 7 }, (_, i) => `h${i}-${tag}`),
  };
}

interface PendingCall {
  input: ScoreInput;
  resolve: (result: DirectoryResult) => void;
}

export class ScoreGate {
  readonly calls: ScoreInput[] = [];
  private pending: PendingCall[] = [];
  private started = 0;
  private finished = 0;
  maxInFlight = 0;

  readonly fn: ScoreFn = (input) => {
    this.calls.push(input);
    this.started += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.started - this.finished);
    return new Promise<DirectoryResult>((resolve) => {
      this.pending.push({ input, resolve });
    });
  };

  get inFlight(): number {
    return this.started - this.finished;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  releaseNext(result?: DirectoryResult): ScoreInput {
    const call = this.pending.shift();
    if (!call) {
      throw new Error("no pending scoring call to release");
    }
    this.finished += 1;
    const resolved =
      result ??
      (() => {
        const { score, diffs } = scoreProfiles(call.input.canonical, call.input.listing);
        return { directory: call.input.directory, score, diffs };
      })();
    call.resolve(resolved);
    return call.input;
  }

  releaseMatching(pred: (input: ScoreInput) => boolean): ScoreInput {
    const index = this.pending.findIndex((c) => pred(c.input));
    if (index < 0) {
      throw new Error("no matching pending scoring call");
    }
    const [call] = this.pending.splice(index, 1);
    this.finished += 1;
    const { score, diffs } = scoreProfiles(call.input.canonical, call.input.listing);
    call.resolve({ directory: call.input.directory, score, diffs });
    return call.input;
  }

  async releaseAll(): Promise<void> {
    while (this.pending.length > 0) {
      this.releaseNext();
      await Promise.resolve();
    }
  }
}

export async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}
