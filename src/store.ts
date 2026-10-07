import type { ChunkInput, SearchHit } from "./types.js";

/**
 * Local knowledge retrieval store. Single-process, sequential usage.
 * Persists documents, versions, chunks and term indexes in SQLite.
 */
export class KnowledgeStore {
  constructor(_path: string) {
    throw new Error("not implemented");
  }

  /** Submit a full new version of a document; returns its version number. */
  submitVersion(_kbId: string, _docId: string, _chunks: ChunkInput[]): number {
    throw new Error("not implemented");
  }

  /** Make a historical version the current one. History is not rewritten. */
  rollback(_kbId: string, _docId: string, _versionNo: number): void {
    throw new Error("not implemented");
  }

  /**
   * Search the current versions of documents inside the given bound
   * knowledge bases (at most 10). Duplicate query terms count once.
   */
  search(_kbIds: string[], _terms: string[]): SearchHit[] {
    throw new Error("not implemented");
  }

  close(): void {
    throw new Error("not implemented");
  }
}
