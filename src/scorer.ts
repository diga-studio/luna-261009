import type { FieldDiff, Profile, ProfileField, ScoreFn } from './types';

const SCORE_PER_FIELD = 25;

function hoursEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function diffField(
  field: ProfileField,
  canonicalValue: string | string[],
  listingValue: string | string[],
): FieldDiff {
  return {
    field,
    canonicalValue: Array.isArray(canonicalValue) ? [...canonicalValue] : canonicalValue,
    listingValue: Array.isArray(listingValue) ? [...listingValue] : listingValue,
  };
}

/** 默认评分：businessName/address/phone/hours 各 25 分，完全相等得分。 */
export const defaultScoreFn: ScoreFn = async (input) => {
  const { canonical, listing } = input;
  const diffs: FieldDiff[] = [];

  if (canonical.businessName !== listing.businessName) {
    diffs.push(diffField('businessName', canonical.businessName, listing.businessName));
  }
  if (canonical.address !== listing.address) {
    diffs.push(diffField('address', canonical.address, listing.address));
  }
  if (canonical.phone !== listing.phone) {
    diffs.push(diffField('phone', canonical.phone, listing.phone));
  }
  if (!hoursEqual(canonical.hours, listing.hours)) {
    diffs.push(diffField('hours', canonical.hours, listing.hours));
  }

  return { score: SCORE_PER_FIELD * (4 - diffs.length), diffs };
};

export function cloneProfile(p: Profile): Profile {
  return {
    businessName: p.businessName,
    address: p.address,
    phone: p.phone,
    hours: [...p.hours],
  };
}
