/** A single knowledge chunk supplied by the caller. */
export interface ChunkInput {
  /** Original text of the chunk, stored and returned verbatim. */
  text: string;
  /** Normalized term sequence; duplicates are kept and counted for tf. */
  terms: string[];
}

/** One search hit: a chunk of the current version of some document. */
export interface SearchHit {
  kbId: string;
  docId: string;
  /** Per-document version number (1-based, increases on every submit). */
  versionNo: number;
  /** 0-based position of the chunk inside its version. */
  chunkSeq: number;
  text: string;
  score: number;
}
