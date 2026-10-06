"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultScoreFn = void 0;
exports.scoreProfiles = scoreProfiles;
const STRING_FIELDS = ["businessName", "address", "phone"];
function hoursEqual(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
function scoreProfiles(canonical, listing) {
    const diffs = [];
    for (const field of STRING_FIELDS) {
        if (canonical[field] !== listing[field]) {
            diffs.push({ field, canonical: canonical[field], listing: listing[field] });
        }
    }
    if (!hoursEqual(canonical.hours, listing.hours)) {
        diffs.push({ field: "hours", canonical: [...canonical.hours], listing: [...listing.hours] });
    }
    return { score: 25 * (4 - diffs.length), diffs };
}
const defaultScoreFn = async (input) => {
    const { score, diffs } = scoreProfiles(input.canonical, input.listing);
    return { directory: input.directory, score, diffs };
};
exports.defaultScoreFn = defaultScoreFn;
