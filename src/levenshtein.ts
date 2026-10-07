/** Split a string into an array of Unicode code points. */
export function toCodePoints(s: string): string[] {
  return Array.from(s);
}

/**
 * Levenshtein distance over code-point arrays, with insert / delete /
 * replace all costing 1.
 *
 * When `maxDistance` is finite the computation may exit early; in that
 * case the returned value is `maxDistance + 1` (i.e. still "> maxDistance"),
 * never a value that could be mistaken for a distance within the threshold.
 *
 * Early-exit correctness: for any row i of the DP matrix, the final
 * distance d(n, m) >= min_j d(i, j). Proof: any edit script transforming
 * a into b reaches a state where exactly the first i code points of a have
 * been consumed and some prefix b[0..j) produced; the cost paid up to that
 * state is at least d(i, j) >= min_j d(i, j), and the remaining cost is
 * non-negative. Hence if a whole row exceeds maxDistance, so does d(n, m).
 */
export function levenshtein(
  a: readonly string[],
  b: readonly string[],
  maxDistance: number = Infinity,
): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  if (Math.abs(n - m) > maxDistance) return maxDistance + 1;

  let prev = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1);
    cur[0] = i;
    let rowMin = i;
    const ai = a[i - 1]!;
    for (let j = 1; j <= m; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    prev = cur;
  }
  return prev[m]!;
}
