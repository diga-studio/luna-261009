/**
 * Local knowledge retrieval store. Single-process, sequential usage.
 * Persists documents, versions, chunks and term indexes in SQLite.
 */
export class KnowledgeStore {
    constructor(_path) {
        throw new Error("not implemented");
    }
    /** Submit a full new version of a document; returns its version number. */
    submitVersion(_kbId, _docId, _chunks) {
        throw new Error("not implemented");
    }
    /** Make a historical version the current one. History is not rewritten. */
    rollback(_kbId, _docId, _versionNo) {
        throw new Error("not implemented");
    }
    /**
     * Search the current versions of documents inside the given bound
     * knowledge bases (at most 10). Duplicate query terms count once.
     */
    search(_kbIds, _terms) {
        throw new Error("not implemented");
    }
    close() {
        throw new Error("not implemented");
    }
}
