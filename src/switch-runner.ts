// Standalone runner used by tests: executes a single SwitchGroup call or a
// Recover pass in a dedicated child process so the test can kill it mid-flight.
//
// usage:
//   switch-runner switch  <orchDbPath> <execDbPath> <groupId> <requestId>
//   switch-runner recover <orchDbPath> <execDbPath>
//
// stdout protocol (line based):
//   EXECUTOR_PID:<pid>   emitted once the executor process is up
//   RESULT:<json>        emitted with the SwitchResult before exiting (switch)
//   RESULTS:<json>       emitted with the SwitchResult[] array (recover)

import { ExecutorClient } from './executor-client';
import { Orchestrator } from './orchestrator';

export async function runSwitchCommand(argv: string[]): Promise<void> {
  const [command, orchDbPath, execDbPath, groupId, requestId] = argv;
  if (!command || !orchDbPath || !execDbPath) {
    throw new Error('usage: switch-runner <switch|recover> <orchDbPath> <execDbPath> ...');
  }
  const executor = new ExecutorClient(execDbPath);
  await executor.start();
  console.log(`EXECUTOR_PID:${executor.pid()}`);
  const orchestrator = new Orchestrator(orchDbPath, executor);
  try {
    if (command === 'switch') {
      if (!groupId || !requestId) throw new Error('switch needs <groupId> <requestId>');
      const result = await orchestrator.switchGroup(groupId, requestId);
      console.log(`RESULT:${JSON.stringify(result)}`);
    } else if (command === 'recover') {
      const results = await orchestrator.recover();
      console.log(`RESULTS:${JSON.stringify(results)}`);
    } else {
      throw new Error(`unknown command ${command}`);
    }
  } finally {
    orchestrator.close();
    await executor.stop();
  }
}

if (require.main === module) {
  runSwitchCommand(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
