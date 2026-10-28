import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { runCommandSpec, runHostOf } from '../../../shared/exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../../../shared/os/hostEnv';
import { SchtasksClient, rawRunnerOf } from '../../../shared/os/taskScheduler/schtasks';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { removeTaskIfPresent } from '../../../shared/os/taskScheduler/testing/liveTask';
import { powershellEncodedArgs } from '../../../shared/os/shellDialect';
import type { CommandSpec } from '../../../shared/exec/commandSpec';
import { buildHubTaskXml, hubWindowsLayout, readWindowsUserId, windowsPowershell, type SpecRunner } from '../windowsHubService';

/**
 * The account the hub's task runs as (#552), read from a real Windows: the same as the process's own identity, and not what the environment
 * says. An OpenSSH session on a workgroup machine has `USERDOMAIN=WORKGROUP`, an account that does not exist, and `schtasks /Create` refuses it.
 */
const SUFFIX = crypto.randomBytes(6).toString('hex');
const REGISTER_TASK = `AzitoCiUserId-${SUFFIX}`;
const RUN_TASK = `AzitoCiUserIdRun-${SUFFIX}`;
const NO_INTERACTIVE_LOGON = new Set([0x8004130f, 0x80070520]);

describe.skipIf(process.platform !== 'win32')('readWindowsUserId on a real Windows', () => {
  let systemRoot: string;
  let client: SchtasksClient;
  let run: SpecRunner;
  let dir: string;
  let expected: string;

  beforeAll(() => {
    const host = resolveCurrentHostEnv();
    systemRoot = host.systemRoot!;
    run = (spec) => runCommandSpec(spec, runHostOf(host));
    client = new SchtasksClient(rawRunnerOf((spec) => runCommandSpec(spec, { ...runHostOf(host), rawOutput: true })), host);
    dir = fs.mkdtempSync(path.join(host.tmpDir, 'azito-userid-'));
    expected = execFileSync(windowsPowershell(systemRoot), ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().Name'], { encoding: 'utf8' }).trim();
  });

  afterAll(async () => {
    // Each cleanup is tried on its own; what failed is reported together at the end.
    const failures: unknown[] = [];
    for (const name of [REGISTER_TASK, RUN_TASK]) {
      try { await removeTaskIfPresent(client, name); } catch (err) { failures.push(err); }
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (err) { failures.push(err); }
    if (failures.length > 0) throw new AggregateError(failures, `Cleanup failed (${failures.length})`);
  });

  it('is the process\'s own identity, which whoami agrees with', async () => {
    const userId = await readWindowsUserId(run, systemRoot);
    expect(userId).toBe(expected);
    expect(userId).toContain('\\');
    const whoami = execFileSync(path.win32.join(systemRoot, 'System32', 'whoami.exe'), { encoding: 'utf8' }).trim();
    expect(userId.toLowerCase()).toBe(whoami.toLowerCase());
  });

  it('is still right when the environment is a workgroup SSH session\'s (USERDOMAIN=WORKGROUP)', async () => {
    const lying: SpecRunner = (spec: CommandSpec) => run({ ...spec, env: { USERDOMAIN: 'WORKGROUP' } });
    expect(await readWindowsUserId(lying, systemRoot)).toBe(expected);
  });

  it('gives a task definition that schtasks accepts and removes', async () => {
    const userId = await readWindowsUserId(run, systemRoot);
    await client.register(REGISTER_TASK, buildHubTaskXml({ userId, systemRoot, layout: hubWindowsLayout(path.win32.join(dir, '.azito')) }));
    expect((await client.query(REGISTER_TASK)).exists).toBe(true);
    await removeTaskIfPresent(client, REGISTER_TASK);
    expect((await client.query(REGISTER_TASK)).exists).toBe(false);
  });

  it('is the same when asked from inside a Task Scheduler task (the in-app update\'s process)', async (ctx) => {
    const out = path.join(dir, 'task-user.txt');
    const script = `[IO.File]::WriteAllText('${out}', [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)`;
    const userId = await readWindowsUserId(run, systemRoot);
    await client.register(RUN_TASK, buildTaskXml({
      userId,
      description: 'AZITO CI test task (safe to delete)',
      executable: path.win32.join(systemRoot, 'System32', 'conhost.exe'),
      args: ['--headless', windowsPowershell(systemRoot), ...powershellEncodedArgs(script)],
      workingDirectory: dir,
      restartOnFailure: { intervalMinutes: 1, count: 1 },
      trigger: 'on-demand',
    }));
    await client.start(RUN_TASK);
    const deadline = Date.now() + 60_000;
    // The task's state is looked at while waiting: a machine with no interactive logon says so at once, and the test skips.
    while (!fs.existsSync(out) && Date.now() < deadline) {
      const state = await client.query(RUN_TASK);
      if (state.exists && NO_INTERACTIVE_LOGON.has(state.lastResult)) ctx.skip(`no interactive logon session on this machine (last result ${state.lastResult})`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!fs.existsSync(out)) throw new Error('The task did not run within 60 s');
    expect(fs.readFileSync(out, 'utf8')).toBe(userId);
  }, 90_000);
});
