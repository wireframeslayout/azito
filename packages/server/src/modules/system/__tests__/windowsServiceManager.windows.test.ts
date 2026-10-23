import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommandSpec, runHostOf } from '../../../shared/exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../../../shared/os/hostEnv';
import { SchtasksClient, rawRunnerOf } from '../../../shared/os/taskScheduler/schtasks';
import { removeTaskIfPresent, startAndWaitRunning } from '../../../shared/os/taskScheduler/testing/liveTask';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { HUB_SERVICE, type ServiceManager } from '../serviceManager';
import { DEFAULT_TASK_SCHEDULER_TIMING, createWindowsServiceManager } from '../windowsServiceManager';

/**
 * The Task Scheduler ServiceManager against the real schtasks.exe, on Windows only. Only "no interactive logon session" (reported by
 * the Task Scheduler itself) skips the start steps, with that reason; any other failure fails the test.
 */
const TASK = `AzitoCiTest-${crypto.randomBytes(6).toString('hex')}`;

describe.skipIf(process.platform !== 'win32')('TaskSchedulerServiceManager on a real Task Scheduler', () => {
  let home: string;
  let manager: ServiceManager;
  let client: SchtasksClient;
  let xml: string;
  let runnable = false;

  beforeAll(() => {
    const host = resolveCurrentHostEnv();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-winsvc-ci-'));
    const run = rawRunnerOf((spec) => runCommandSpec(spec, { ...runHostOf(host), rawOutput: true }));
    client = new SchtasksClient(run, host);
    manager = createWindowsServiceManager({ homeDir: home, tmpDir: host.tmpDir, systemRoot: host.systemRoot }, { ...HUB_SERVICE, windowsTaskName: TASK }, run, DEFAULT_TASK_SCHEDULER_TIMING);
    xml = buildTaskXml({
      userId: `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`,
      description: 'AZITO CI test task (safe to delete)',
      executable: host.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      workingDirectory: host.tmpDir,
      restartOnFailure: { intervalMinutes: 1, count: 3 },
    });
  });

  afterAll(async () => {
    try {
      // "Already gone" is fine; a task that cannot be removed fails the suite.
      await removeTaskIfPresent(client, TASK);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('installs the definition and reports a stopped service', async () => {
    expect(manager.isInstalled()).toBe(false);
    await manager.install(xml);
    expect(manager.isInstalled()).toBe(true);
    expect(manager.readDefinition()).toBe(xml);
    expect(await manager.state()).toBe('inactive');
  });

  it('starts, restarts and stops the service', async (ctx) => {
    const outcome = await startAndWaitRunning(client, TASK, () => manager.start());
    if (outcome.skipReason) {
      console.warn(`[windowsServiceManager.windows.test] SKIPPED start/restart/stop: ${outcome.skipReason}`);
      ctx.skip(outcome.skipReason);
    }
    runnable = true;
    await manager.start();
    expect(await manager.state()).toBe('active');
    await manager.restart();
    expect(await manager.state()).toBe('active');
    await manager.stop();
    expect(await manager.state()).not.toBe('active');
  }, 90_000);

  it('stop on a stopped service does nothing', async () => {
    if (runnable) await manager.stop();
    await manager.stop();
    expect(await manager.state()).not.toBe('active');
  }, 30_000);
});
