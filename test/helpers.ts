import { isDuplicate } from "../src/index.js";
import type { EntityRecord } from "../src/index.js";

export function mkRecord(
  id: string,
  title: string,
  address: string,
  lat: number,
  lon: number,
): EntityRecord {
  return { id, title, address, lat, lon };
}

/**
 * Independent reference: exhaustive O(n^2) pair enumeration over
 * isDuplicate, then connected components. Returns canonical id-sets.
 */
export function bruteForceClusters(records: readonly EntityRecord[]): string[][] {
  const n = records.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isDuplicate(records[i]!, records[j]!)) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const byRoot = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(records[i]!.id);
    byRoot.set(r, arr);
  }
  return canonicalize([...byRoot.values()]);
}

/** Canonical form of a partition: sorted ids per cluster, sorted clusters. */
export function canonicalize(clusters: string[][]): string[][] {
  return clusters
    .map((c) => [...c].sort())
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
}

export function idsOf(clusters: readonly EntityRecord[][]): string[][] {
  return canonicalize(clusters.map((c) => c.map((r) => r.id)));
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
