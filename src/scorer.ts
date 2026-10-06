import { FieldDiff, Profile, ScoreFn } from "./types";

const STRING_FIELDS = ["businessName", "address", "phone"] as const;

function hoursEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function scoreProfiles(canonical: Profile, listing: Profile): { score: number; diffs: FieldDiff[] } {
  const diffs: FieldDiff[] = [];
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

export const defaultScoreFn: ScoreFn = async (input) => {
  const { score, diffs } = scoreProfiles(input.canonical, input.listing);
  return { directory: input.directory, score, diffs };
};
