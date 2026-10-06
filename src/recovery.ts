import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from './db';

export interface StorageLayout {
  dir: string;
  tmpDir: string;
  chunksDir: string;
  filesDir: string;
  stagingDir: string;
  dbPath: string;
}

export function layoutOf(dir: string): StorageLayout {
  const root = path.resolve(dir);
  return {
    dir: root,
    tmpDir: path.join(root, 'tmp'),
    chunksDir: path.join(root, 'chunks'),
    filesDir: path.join(root, 'files'),
    stagingDir: path.join(root, 'staging'),
    dbPath: path.join(root, 'upload.db'),
  };
}

/** Directory name holding the confirmed chunks of one session. */
export function sessionChunkDirName(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

/** Ensure the storage directory tree exists. */
export function ensureLayout(layout: StorageLayout): void {
  fs.mkdirSync(layout.tmpDir, { recursive: true });
  fs.mkdirSync(layout.chunksDir, { recursive: true });
  fs.mkdirSync(layout.filesDir, { recursive: true });
  fs.mkdirSync(layout.stagingDir, { recursive: true });
}

function removeContents(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Reconcile the filesystem with the database after (re)opening:
 * remove interrupted temp/staging writes, orphan chunk files, chunk copies
 * of completed sessions and complete files no session references.
 */
export function recover(layout: StorageLayout, db: Database): void {
  // Interrupted writes never produced a success response: drop them.
  removeContents(layout.tmpDir);
  removeContents(layout.stagingDir);

  const sessions = db.listSessions();
  const sessionByDirName = new Map(sessions.map((s) => [sessionChunkDirName(s.sessionId), s]));

  // Chunk directories belonging to completed sessions must be gone; chunk
  // files of incomplete sessions must match the confirmed rows exactly.
  if (fs.existsSync(layout.chunksDir)) {
    for (const entry of fs.readdirSync(layout.chunksDir)) {
      const sessionDir = path.join(layout.chunksDir, entry);
      const session = sessionByDirName.get(entry);
      if (!session || session.completed) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        continue;
      }
      const confirmed = new Set(db.listChunks(session.sessionId).map((c) => String(c.index)));
      for (const file of fs.readdirSync(sessionDir)) {
        if (!confirmed.has(file)) {
          fs.rmSync(path.join(sessionDir, file), { force: true });
        }
      }
    }
  }

  // Complete files not referenced by any completed session are unowned.
  const referenced = new Set(
    db.listCompletedSessions()
      .map((s) => s.fileRef)
      .filter((ref): ref is string => ref !== null)
      .map((ref) => path.basename(ref)),
  );
  if (fs.existsSync(layout.filesDir)) {
    for (const entry of fs.readdirSync(layout.filesDir)) {
      if (!referenced.has(entry)) {
        fs.rmSync(path.join(layout.filesDir, entry), { force: true });
      }
    }
  }
}
