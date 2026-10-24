import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommandSpec, runHostOf } from '../../exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../hostEnv';
import { SchtasksClient, rawRunnerOf } from './schtasks';
import { buildTaskXml } from './taskDefinition';
import { removeTaskIfPresent } from './testing/liveTask';

/**
 * Why the hub, not the Task Scheduler, starts a dead Windows agent / misao again (`AgentRecoveryWatchdog`): on a real Task Scheduler,
 * (1) `conhost.exe --headless` reports exit code 0 for a child that exited with 7 (the form every AZITO task runs), and
 * (2) RestartOnFailure does not restart a task whose program exited with a non-zero code at all (here `cmd.exe /c exit 7`, run
 * directly, whose Last Result is 7). Both are measured, so that a later reader can check the premise instead of trusting it. The
 * second one waits past the restart interval (one minute) to see that nothing starts again.
 */
const SUFFIX = crypto.randomBytes(6).toString('hex');
const VIA_CONHOST = `AzitoCiExit7Conhost-${SUFFIX}`;
const DIRECT = `AzitoCiExit7Direct-${SUFFIX}`;
/** SCHED_E_USER_NOT_LOGGED_ON and ERROR_NO_SUCH_LOGON_SESSION: the same two results the other live Task Scheduler tests accept as "no logon session". */
const NO_INTERACTIVE_LOGON = new Set([0x8004130f, 0x80070520]);
const WAIT_PAST_RESTART_INTERVAL_MS = 90_000;

let client: SchtasksClient;
let dir: string;

function runsOf(name: string): number {
  const file = path.join(dir, `${name}.count`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter((line) => line.trim() === 'x').length : 0;
}

describe.skipIf(process.platform !== 'win32')('what the Task Scheduler does with a program that exits with 7', () => {
  beforeAll(async () => {
    const host = resolveCurrentHostEnv();
    client = new SchtasksClient(rawRunnerOf((spec) => runCommandSpec(spec, { ...runHostOf(host), rawOutput: true })), host);
    dir = fs.mkdtempSync(path.join(host.tmpDir, 'azito-exit7-'));
    expect(dir).not.toMatch(/\s/); // the cmd.exe line below is not quoted for a path with a space
    const userId = `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`;
    const cmd = path.win32.join(host.systemRoot!, 'System32', 'cmd.exe');
    const conhost = path.win32.join(host.systemRoot!, 'System32', 'conhost.exe');
    const line = (name: string): string => `/d /c "echo x>>${path.join(dir, `${name}.count`)} & exit 7"`;
    const base = { userId, description: 'AZITO CI test task (safe to delete)', workingDirectory: host.tmpDir, restartOnFailure: { intervalMinutes: 1, count: 3 } };
    await client.register(VIA_CONHOST, buildTaskXml({ ...base, executable: conhost, argumentsLine: `--headless ${cmd} ${line(VIA_CONHOST)}` }));
    await client.register(DIRECT, buildTaskXml({ ...base, executable: cmd, argumentsLine: line(DIRECT) }));
  });

  afterAll(async () => {
    for (const name of [VIA_CONHOST, DIRECT]) await removeTaskIfPresent(client, name);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('conhost --headless reports 0 for the child, cmd.exe run directly reports 7, and neither is started again', async (ctx) => {
    await client.start(VIA_CONHOST);
    await client.start(DIRECT);
    const deadline = Date.now() + 30_000;
    while ((runsOf(VIA_CONHOST) === 0 || runsOf(DIRECT) === 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
    if (runsOf(VIA_CONHOST) === 0 || runsOf(DIRECT) === 0) {
      // Only a machine with no interactive logon session may skip; a task that did not run for any other reason fails the test.
      const results = [await client.query(VIA_CONHOST), await client.query(DIRECT)].map((state) => (state.exists ? state.lastResult : -1));
      if (!results.some((r) => NO_INTERACTIVE_LOGON.has(r))) throw new Error(`The tasks did not run within 30 s (last results ${results.join(', ')})`);
      const reason = `no interactive logon session on this machine (last results ${results.join(', ')})`;
      console.warn(`[restartOnFailure.windows.test] SKIPPED: ${reason}`);
      ctx.skip(reason);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await client.query(VIA_CONHOST)).toMatchObject({ exists: true, lastResult: 0 });
    expect(await client.query(DIRECT)).toMatchObject({ exists: true, lastResult: 7 });

    await new Promise((resolve) => setTimeout(resolve, WAIT_PAST_RESTART_INTERVAL_MS));
    expect(runsOf(VIA_CONHOST)).toBe(1);
    expect(runsOf(DIRECT)).toBe(1); // RestartOnFailure (every minute, 3 times) did not fire for exit code 7
  }, WAIT_PAST_RESTART_INTERVAL_MS + 90_000);
});
