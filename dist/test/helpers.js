"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScoreGate = void 0;
exports.makeProfile = makeProfile;
exports.flushMicrotasks = flushMicrotasks;
const scorer_1 = require("../src/scorer");
function makeProfile(tag) {
    return {
        businessName: `name-${tag}`,
        address: `addr-${tag}`,
        phone: `phone-${tag}`,
        hours: Array.from({ length: 7 }, (_, i) => `h${i}-${tag}`),
    };
}
class ScoreGate {
    calls = [];
    pending = [];
    started = 0;
    finished = 0;
    maxInFlight = 0;
    fn = (input) => {
        this.calls.push(input);
        this.started += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.started - this.finished);
        return new Promise((resolve) => {
            this.pending.push({ input, resolve });
        });
    };
    get inFlight() {
        return this.started - this.finished;
    }
    get pendingCount() {
        return this.pending.length;
    }
    releaseNext(result) {
        const call = this.pending.shift();
        if (!call) {
            throw new Error("no pending scoring call to release");
        }
        this.finished += 1;
        const resolved = result ??
            (() => {
                const { score, diffs } = (0, scorer_1.scoreProfiles)(call.input.canonical, call.input.listing);
                return { directory: call.input.directory, score, diffs };
            })();
        call.resolve(resolved);
        return call.input;
    }
    releaseMatching(pred) {
        const index = this.pending.findIndex((c) => pred(c.input));
        if (index < 0) {
            throw new Error("no matching pending scoring call");
        }
        const [call] = this.pending.splice(index, 1);
        this.finished += 1;
        const { score, diffs } = (0, scorer_1.scoreProfiles)(call.input.canonical, call.input.listing);
        call.resolve({ directory: call.input.directory, score, diffs });
        return call.input;
    }
    async releaseAll() {
        while (this.pending.length > 0) {
            this.releaseNext();
            await Promise.resolve();
        }
    }
}
exports.ScoreGate = ScoreGate;
async function flushMicrotasks(times = 20) {
    for (let i = 0; i < times; i += 1) {
        await Promise.resolve();
    }
}
