# Planned Switchover Library

Recoverable planned switchover (A→B failover / B→A failback) for protection
groups of 1–50 VMs. Orchestration state lives in SQLite; VM power operations
are executed by a separate executor process with its own independent SQLite
persistence.

## Layout

- `src/orchestrator.ts` — `CreateGroup` / `SwitchGroup` / `Recover` / `Inspect`
  and the resumable request state machine
  (`stopping_source → starting_target → done`, rollback path
  `stopping_target → starting_source → failed`).
- `src/executor-process.ts` — VM executor child process. Only accepts
  single-replica start/stop instructions. Idempotent by stable instruction id;
  success and permanent rejection are both persisted and replayed without
  re-applying. Test pause points: `beforeApply` and `afterPersist`
  (data-driven via `pause_rules` / `reject_rules` tables in the executor DB).
- `src/executor-client.ts` — parent-side IPC handle (fork/pipe only, no
  listening ports).
- `src/switch-runner.ts` — child-process runner used by tests to kill a
  switch/recover mid-flight.
- `test/switchover.test.ts` — kill-and-recover scenarios.

## Invariants

- A VM never runs on both sites: the whole source side is stopped before any
  target replica starts (group-level, not per-VM).
- Success means every target replica runs and every source replica is stopped;
  the active site flips only after the whole group completed.
- A permanently rejected target start rolls the group back: all target
  replicas stop, then all source replicas start, only then the failure is
  recorded. Failure never changes the active site.
- The orchestrator never holds a database transaction while waiting for the
  executor; each instruction is marked `sent` before the call and its result
  is committed after. After a kill, `Recover` replays the same stable
  instruction ids — the executor returns the persisted result without
  re-applying, so every issued instruction converges.
- `requestId` permanently identifies a request within a group: replaying a
  finished id returns its recorded terminal result without side effects.

## Build & test

Requires Node.js >= 24 (uses `node:sqlite`). No services, no Docker, no
network ports.

```sh
npm install
npm test
```
