import { haversineMeters } from "./geo.js";
import { levenshtein, toCodePoints } from "./levenshtein.js";
import { normalizeText } from "./normalize.js";
import type { ClusterResult, EntityRecord } from "./types.js";

/** Direct-duplicate thresholds. */
const MAX_GEO_METERS = 100;

/**
 * Similarity threshold: similar iff 20 * d <= 3 * L, where d is the
 * code-point Levenshtein distance and L the max code-point length of the
 * two strings. This is exactly "similarity >= 85%" in integer arithmetic.
 */
const MAX_NORMALIZED_LEN = 64;

/**
 * Any duplicate pair has edit distance d <= floor(3 * L / 20) with
 * L <= 64, hence d <= 9. Splitting a string into K_MAX + 1 = 10 contiguous
 * pieces therefore guarantees (pigeonhole: each edit destroys at most one
 * piece) that at least one piece survives verbatim in the other string.
 */
const K_MAX = Math.floor((3 * MAX_NORMALIZED_LEN) / 20); // 9
const PIECE_COUNT = K_MAX + 1; // 10
const MAX_PIECE_LEN = Math.ceil(MAX_NORMALIZED_LEN / PIECE_COUNT); // 7

/** True iff 20 * d <= 3 * L can hold for the given distance and lengths. */
function withinThreshold(distance: number, lenA: number, lenB: number): boolean {
  return 20 * distance <= 3 * Math.max(lenA, lenB);
}

/** Max edit distance allowed by the 85% threshold for the given lengths. */
function maxDistanceFor(lenA: number, lenB: number): number {
  return Math.floor((3 * Math.max(lenA, lenB)) / 20);
}

/** True iff the two normalized strings (as code points) are >= 85% similar. */
function similar85(a: readonly string[], b: readonly string[]): boolean {
  const d = levenshtein(a, b, maxDistanceFor(a.length, b.length));
  return withinThreshold(d, a.length, b.length);
}

/** True iff records a and b are direct duplicates. */
export function isDuplicate(a: EntityRecord, b: EntityRecord): boolean {
  const titleA = toCodePoints(normalizeText(a.title));
  const titleB = toCodePoints(normalizeText(b.title));
  if (!similar85(titleA, titleB)) return false;
  const addrA = toCodePoints(normalizeText(a.address));
  const addrB = toCodePoints(normalizeText(b.address));
  if (!similar85(addrA, addrB)) return false;
  return haversineMeters(a.lat, a.lon, b.lat, b.lon) <= MAX_GEO_METERS;
}

interface Prepared {
  readonly record: EntityRecord;
  readonly title: readonly string[];
  readonly address: readonly string[];
}

interface PieceHit {
  readonly id: number;
  readonly start: number;
  readonly titleLen: number;
}

/**
 * Partition records into the connected components of the direct-duplicate
 * relation (union-find). Singletons are preserved.
 *
 * Candidate reduction (lossless — see levenshtein.ts and the constants
 * above):
 *
 * 1. Pigeonhole pieces. Every record's normalized title is split into 10
 *    contiguous pieces, indexed in a Map from piece string to postings.
 *    A new record probes the index with every substring of its title of
 *    length 1..7; any duplicate must share at least one intact piece, so
 *    it is always found. A position window (|pieceStart - matchStart| <= 9)
 *    is sound because an intact piece can shift by at most d <= 9 code
 *    points. Records with titles shorter than 10 code points have empty
 *    pieces, which trivially occur anywhere; they are tracked separately
 *    with the same position window.
 *
 * 2. Length filter. A duplicate pair must satisfy
 *    |lenA - lenB| <= floor(3 * max(lenA, lenB) / 20); checked before any
 *    edit-distance computation.
 *
 * 3. Geo filter. The haversine check is cheap and is not an edit-distance
 *    evaluation, so it runs before the title/address comparisons.
 *
 * 4. Connected-component skip. If two candidate records are already in the
 *    same union-find component, adding an edge between them cannot change
 *    the final partition, so the pair is skipped without any evaluation.
 *    This keeps degenerate inputs (e.g. all titles identical) exact while
 *    avoiding quadratic evaluation counts.
 *
 * No all-pairs enumeration, no distance matrix, no sampling, no cap on
 * neighbor counts, no representative-only comparison: every pair that can
 * still affect the partition is evaluated exactly.
 *
 * distanceEvaluations counts every edit-distance computation initiated,
 * including ones that exit early via the threshold.
 */
export function cluster(records: readonly EntityRecord[]): ClusterResult {
  const n = records.length;
  const prepared: Prepared[] = records.map((record) => ({
    record,
    title: toCodePoints(normalizeText(record.title)),
    address: toCodePoints(normalizeText(record.address)),
  }));

  const parent: number[] = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root]! !== root) root = parent[root]!;
    while (parent[x]! !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  let distanceEvaluations = 0;
  const similar85Counted = (a: readonly string[], b: readonly string[]): boolean => {
    distanceEvaluations++;
    const d = levenshtein(a, b, maxDistanceFor(a.length, b.length));
    return withinThreshold(d, a.length, b.length);
  };

  const pieceIndex = new Map<string, PieceHit[]>();
  const emptyPieceHits: PieceHit[] = [];

  const lengthFilter = (lenA: number, lenB: number): boolean =>
    Math.abs(lenA - lenB) <= maxDistanceFor(lenA, lenB);

  for (let t = 0; t < n; t++) {
    const ct = prepared[t]!;
    const m = ct.title.length;

    // --- Probe: gather candidate partner ids (lossless). ---
    const candidates = new Set<number>();
    const consider = (hit: PieceHit, matchStart: number): void => {
      if (candidates.has(hit.id)) return;
      if (Math.abs(hit.start - matchStart) > K_MAX) return;
      if (!lengthFilter(hit.titleLen, m)) return;
      candidates.add(hit.id);
    };
    for (let len = 1; len <= MAX_PIECE_LEN && len <= m; len++) {
      for (let j = 0; j + len <= m; j++) {
        const hits = pieceIndex.get(ct.title.slice(j, j + len).join(""));
        if (hits !== undefined) {
          for (const hit of hits) consider(hit, j);
        }
      }
    }
    for (const hit of emptyPieceHits) {
      // An empty piece at offset `start` occurs in the probe title at some
      // position j in [0, m]; the window |start - j| <= K_MAX is satisfiable
      // iff start <= m + K_MAX.
      if (hit.start <= m + K_MAX) consider(hit, Math.min(hit.start, m));
    }

    // --- Evaluate candidates exactly. ---
    for (const s of candidates) {
      if (find(s) === find(t)) continue;
      const cs = prepared[s]!;
      if (
        haversineMeters(
          cs.record.lat,
          cs.record.lon,
          ct.record.lat,
          ct.record.lon,
        ) > MAX_GEO_METERS
      ) {
        continue;
      }
      if (!similar85Counted(cs.title, ct.title)) continue;
      if (!similar85Counted(cs.address, ct.address)) continue;
      union(s, t);
    }

    // --- Index this record's title pieces. ---
    for (let p = 0; p < PIECE_COUNT; p++) {
      const start = Math.floor((p * m) / PIECE_COUNT);
      const end = Math.floor(((p + 1) * m) / PIECE_COUNT);
      if (end > start) {
        const key = ct.title.slice(start, end).join("");
        let hits = pieceIndex.get(key);
        if (hits === undefined) {
          hits = [];
          pieceIndex.set(key, hits);
        }
        hits.push({ id: t, start, titleLen: m });
      } else {
        emptyPieceHits.push({ id: t, start, titleLen: m });
      }
    }
  }

  // --- Collect components; order deterministically so the result does not
  // --- depend on input order. ---
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let members = byRoot.get(root);
    if (members === undefined) {
      members = [];
      byRoot.set(root, members);
    }
    members.push(i);
  }
  const clusters: EntityRecord[][] = [];
  for (const members of byRoot.values()) {
    const recs = members
      .map((i) => prepared[i]!.record)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    clusters.push(recs);
  }
  clusters.sort((a, b) => (a[0]!.id < b[0]!.id ? -1 : a[0]!.id > b[0]!.id ? 1 : 0));

  return { clusters, distanceEvaluations };
}
