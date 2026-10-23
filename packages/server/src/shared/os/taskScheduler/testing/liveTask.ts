import type { CommandResult, CommandSpec } from '../../../exec/commandSpec';
import type { CommandSpecRunner, SchtasksClient } from '../schtasks';

/** A fake runner that answers with text (UTF-8 bytes); tests that need other bytes write their own `CommandSpecRunner`. */
export function rawFromText(run: (spec: CommandSpec) => Promise<CommandResult>): CommandSpecRunner {
  return async (spec) => {
    const result = await run(spec);
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout, 'utf-8'), stderr: Buffer.from(result.stderr, 'utf-8') };
  };
}

/**
 * Task Scheduler results that say "there is no interactive logon session to run the task in" (the only reason the live tests
 * accept for a task that cannot be started): SCHED_E_USER_NOT_LOGGED_ON (0x8004130F) and ERROR_NO_SUCH_LOGON_SESSION (0x80070520).
 */
const NO_INTERACTIVE_LOGON = new Set([0x8004130f, 0x80070520]);

export interface StartOutcome {
  /** Set when the task could not run only because this machine has no interactive logon session; the live test then skips with it. */
  skipReason?: string;
}

/**
 * Starts the task and waits for it to run. A failure of `/Run` itself, a timeout, or any state other than a missing logon session
 * throws (the test fails): only a result in {@link NO_INTERACTIVE_LOGON} is an environment condition worth a skip.
 */
export async function startAndWaitRunning(client: SchtasksClient, taskName: string, start: () => Promise<void>, timeoutMs = 20_000): Promise<StartOutcome> {
  await start();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await client.query(taskName);
    if (!state.exists) throw new Error(`The task ${taskName} disappeared after /Run`);
    if (state.running) return {};
    if (NO_INTERACTIVE_LOGON.has(state.lastResult)) {
      return { skipReason: `no interactive logon session on this machine (last result 0x${state.lastResult.toString(16)})` };
    }
    if (Date.now() >= deadline) throw new Error(`The task ${taskName} did not report running within ${timeoutMs}ms (last result ${state.lastResult})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Test cleanup: stops and deletes the task if it is still there. "Already gone" is fine; any other failure is thrown. */
export async function removeTaskIfPresent(client: SchtasksClient, taskName: string): Promise<void> {
  const state = await client.query(taskName);
  if (!state.exists) return;
  if (state.running) await client.stop(taskName);
  await client.delete(taskName);
}
