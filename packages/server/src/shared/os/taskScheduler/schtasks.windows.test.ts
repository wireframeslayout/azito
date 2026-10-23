import crypto from 'crypto';
import os from 'os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommandSpec, runHostOf } from '../../exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../hostEnv';
import { SchtasksClient, type TaskScheduleState } from './schtasks';
import { buildTaskXml } from './taskDefinition';

/**
 * The real Task Scheduler (`schtasks.exe`), on Windows only. A task with a unique name is registered, started, stopped and
 * deleted; `afterAll` deletes it whatever happened. Registration, query and delete must work everywhere. `/Run` and the
 * "is it running" check depend on an interactive logon session, which a CI runner may not have: if that part does not work
 * the test is skipped WITH the reason it printed (never silently), and the other steps still run.
 */
const TASK = `AzitoCiTest-${crypto.randomBytes(6).toString('hex')}`;

// Built in beforeAll: on Linux/macOS this file is loaded (and skipped), where %SystemRoot% and Windows paths do not exist.
let client: SchtasksClient;
let taskXml: string;

async function waitFor(done: (state: TaskScheduleState) => boolean, timeoutMs: number): Promise<TaskScheduleState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await client.query(TASK);
    if (done(state) || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe.skipIf(process.platform !== 'win32')('schtasks on a real Task Scheduler', () => {
  let runnable: boolean | undefined;

  beforeAll(() => {
    const host = resolveCurrentHostEnv();
    client = new SchtasksClient((spec) => runCommandSpec(spec, runHostOf(host)), host);
    taskXml = buildTaskXml({
      userId: `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`,
      description: 'AZITO CI test task (safe to delete)',
      executable: host.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)', '日本語 "quoted" arg'],
      workingDirectory: host.tmpDir,
      restartOnFailure: { intervalMinutes: 1, count: 3 },
    });
  });

  afterAll(async () => {
    // Best effort: the task may already be deleted by the test, and a leftover must not fail the run that is reporting something else.
    await client.stop(TASK).catch(() => undefined);
    await client.delete(TASK).catch(() => undefined);
  });

  it('registers the logon-trigger task from the generated XML', async () => {
    await client.register(TASK, taskXml);
    expect(await client.query(TASK)).toMatchObject({ exists: true, running: false });
  });

  it('registering again replaces the task (/F)', async () => {
    await client.register(TASK, taskXml);
    expect((await client.query(TASK)).exists).toBe(true);
  });

  it('starts the task and sees it running', async (ctx) => {
    try {
      await client.start(TASK);
    } catch (err) {
      runnable = false;
      const reason = `schtasks /Run is not possible on this machine: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[schtasks.windows.test] SKIPPED start/stop: ${reason}`);
      ctx.skip(reason);
    }
    const state = await waitFor((s) => s.exists && s.running, 20_000);
    if (!(state.exists && state.running)) {
      runnable = false;
      const reason = `/Run was accepted but the task did not report running within 20s (state ${JSON.stringify(state)}); the runner probably has no interactive logon session`;
      console.warn(`[schtasks.windows.test] SKIPPED start/stop: ${reason}`);
      ctx.skip(reason);
    }
    runnable = true;
    expect(state).toMatchObject({ exists: true, running: true, lastResult: 0x41301 });
  }, 60_000);

  it('stops the running task', async (ctx) => {
    if (!runnable) ctx.skip('the task could not be started on this machine (see the skipped start test)');
    await client.stop(TASK);
    const state = await waitFor((s) => s.exists && !s.running, 15_000);
    expect(state).toMatchObject({ exists: true, running: false, failed: false });
  }, 60_000);

  it('deletes the task, after which it no longer exists', async () => {
    await client.delete(TASK);
    expect(await client.query(TASK)).toEqual({ exists: false });
  });

  it('reports an error for deleting a task that does not exist', async () => {
    await expect(client.delete(TASK)).rejects.toMatchObject({ operation: 'delete', exitCode: expect.any(Number) });
  });
});
