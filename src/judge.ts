import type { VariantStats } from './types.js';

export const MIN_EXPOSURES_PER_VARIANT = 200;
export const Z_THRESHOLD = 1.959963984540054;

function zScore(a: VariantStats, b: VariantStats): number {
  const p = (a.c + b.c) / (a.n + b.n);
  const denominator = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  if (denominator === 0) {
    return 0;
  }
  return (a.c / a.n - b.c / b.n) / denominator;
}

export function computeWinner(stats: VariantStats[]): string | null {
  if (stats.length === 0 || stats.some((s) => s.n < MIN_EXPOSURES_PER_VARIANT)) {
    return null;
  }
  for (const candidate of stats) {
    const beatsAll = stats.every(
      (other) => other.variant === candidate.variant || zScore(candidate, other) >= Z_THRESHOLD,
    );
    if (beatsAll) {
      return candidate.variant;
    }
  }
  return null;
}
