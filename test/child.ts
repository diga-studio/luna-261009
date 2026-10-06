/**
 * Child-process driver used by crash tests. Reads a JSON program path from
 * argv[2], executes the actions against an UploadStore and prints one JSON
 * result line per action. When the program sets `killAfterAction`, the child
 * SIGKILLs itself right after reporting that action's result, simulating a
 * forced termination just after the call returned. The library's own
 * UPLOAD_STORE_CRASH_AT hook simulates termination before a call returns.
 */
import * as fs from 'node:fs';
import { UploadStore } from '../src/index';

interface Action {
  op: 'start' | 'submit' | 'complete' | 'progress';
  sessionId: string;
  totalSize?: number;
  sha256?: string;
  index?: number;
  dataPath?: string;
}

interface Program {
  dir: string;
  crashAt?: string;
  killAfterAction?: number;
  actions: Action[];
}

function report(value: unknown): void {
  fs.writeSync(1, `${JSON.stringify(value)}\n`);
}

function main(): void {
  const program: Program = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (program.crashAt) {
    process.env.UPLOAD_STORE_CRASH_AT = program.crashAt;
  }
  const store = new UploadStore({ dir: program.dir });

  program.actions.forEach((action, i) => {
    try {
      let result: unknown;
      switch (action.op) {
        case 'start':
          result = store.startSession({
            sessionId: action.sessionId,
            totalSize: action.totalSize!,
            sha256: action.sha256!,
          });
          break;
        case 'submit':
          result = store.submitChunk(action.sessionId, action.index!, fs.readFileSync(action.dataPath!));
          break;
        case 'complete':
          result = store.complete(action.sessionId);
          break;
        case 'progress':
          result = store.getProgress(action.sessionId);
          break;
      }
      report({ ok: true, result });
    } catch (err) {
      report({ ok: false, error: (err as { code?: string; message: string }).code ?? 'ERROR' });
    }
    if (program.killAfterAction === i) {
      process.kill(process.pid, 'SIGKILL');
    }
  });
  store.close();
  report({ done: true });
}

if (require.main === module) {
  main();
}
