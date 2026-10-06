/**
 * Stable counting sort of indices 0..n-1 by key[idx], keys in [0, keyCount).
 * Returns a new Uint32Array of sorted indices.
 */
export function countingSortIndices(
  keys: ArrayLike<number>,
  n: number,
  keyCount: number
): Uint32Array<ArrayBuffer> {
  const counts = new Uint32Array(keyCount + 1);
  for (let i = 0; i < n; i++) counts[keys[i] + 1]++;
  for (let k = 0; k < keyCount; k++) counts[k + 1] += counts[k];
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const key = keys[i];
    out[counts[key]++] = i;
  }
  return out;
}

/** In-place stable counting sort of `indices` by key[indices[i]]. */
export function countingSortIndicesInPlace(
  keys: ArrayLike<number>,
  indices: Uint32Array,
  keyCount: number
): Uint32Array<ArrayBuffer> {
  const n = indices.length;
  const counts = new Uint32Array(keyCount + 1);
  for (let i = 0; i < n; i++) counts[keys[indices[i]] + 1]++;
  for (let k = 0; k < keyCount; k++) counts[k + 1] += counts[k];
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const key = keys[indices[i]];
    out[counts[key]++] = indices[i];
  }
  return out;
}

/**
 * Stable LSD radix sort of `indices` by the IEEE-754 bit pattern of
 * non-negative Float64 keys (bit order equals value order for x >= 0).
 * Returns a new Uint32Array of sorted indices.
 */
export function radixSortIndicesByF64(
  keys: Float64Array,
  indices: Uint32Array
): Uint32Array<ArrayBuffer> {
  const n = indices.length;
  const lo = new Uint32Array(keys.buffer as ArrayBuffer, keys.byteOffset, keys.length * 2);
  let src: Uint32Array<ArrayBuffer> = indices as Uint32Array<ArrayBuffer>;
  let dst: Uint32Array<ArrayBuffer> = new Uint32Array(n);
  const counts = new Uint32Array(65537);
  for (let pass = 0; pass < 4; pass++) {
    const wordOffset = pass >> 1; // 0: lo word, 1: hi word
    const shift = (pass & 1) << 4;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const w = lo[src[i] * 2 + wordOffset];
      counts[((w >>> shift) & 0xffff) + 1]++;
    }
    for (let k = 0; k < 65536; k++) counts[k + 1] += counts[k];
    for (let i = 0; i < n; i++) {
      const idx = src[i];
      const w = lo[idx * 2 + wordOffset];
      dst[counts[(w >>> shift) & 0xffff]++] = idx;
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return src;
}

/** First index i in [0, n) with sorted[i] >= value; n if none. */
export function lowerBoundF64(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
