import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeRunTransport, failed, ok } from '../../../shared/exec/testing/commandTesting';
import type { CommandResult, CommandSpec } from '../../../shared/exec/commandSpec';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { HUB_SERVICE, createServiceManager } from '../serviceManager';
import { createWindowsServiceManager } from '../windowsServiceManager';

const TIMING = { stopTimeoutMs: 200, pollIntervalMs: 5 };
const xml = (description: string): string => buildTaskXml({
  userId: 'PC\\me', description, executable: 'C:\\azito\\run.exe', args: ['serve'], workingDirectory: 'C:\\azito', restartOnFailure: { intervalMinutes: 1, count: 3 },
});

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-winsvc-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A Task Scheduler that answers schtasks from a small state: registered, running. */
function fakeScheduler(initial: { registered: boolean; running: boolean; lastResult?: string }) {
  const state = { ...initial, lastResult: initial.lastResult ?? '0', endIgnored: false, createFails: false };
  const verbs: string[] = [];
  const respond = (spec: CommandSpec): CommandResult => {
    const verb = spec.args[0]!;
    verbs.push(verb);
    if (verb === '/Create') {
      if (state.createFails) return failed(1, 'ERROR: The task XML is malformed.');
      state.registered = true;
      return ok();
    }
    if (verb === '/Run') {
      if (!state.registered) return failed(1, 'ERROR: The system cannot find the file specified.');
      state.running = true; state.lastResult = '267009'; return ok(); }
    if (verb === '/End') {
      if (!state.endIgnored) { state.running = false; state.lastResult = '267014'; }
      return ok();
    }
    if (verb === '/Query' && spec.args.includes('/TN')) {
      if (!state.registered) return failed(1, 'ERROR: not found');
      return ok(`"PC","\\AzitoHub","N/A","?","Interactive only","N/A","${state.running ? '267009' : state.lastResult}"\r\n`);
    }
    if (verb === '/Query') return ok(state.registered ? '"\\AzitoHub","N/A","Ready"\r\n' : '"\\Other","N/A","Ready"\r\n');
    return failed(1, `unexpected ${verb}`);
  };
  const transport = fakeRunTransport(respond);
  const manager = createWindowsServiceManager({ homeDir: home, tmpDir: home, systemRoot: 'C:\\Windows' }, HUB_SERVICE, transport.run, TIMING);
  return { manager, state, verbs, specs: transport.specs };
}

describe('TaskSchedulerServiceManager', () => {
  it('is a Task Scheduler manager without a unit template', () => {
    const { manager } = fakeScheduler({ registered: false, running: false });
    expect(manager.kind).toBe('taskscheduler');
    expect(manager.templateName).toBeUndefined();
  });

  it('is not what createServiceManager returns yet: Windows stays unsupported there until #380 B3', () => {
    expect(createServiceManager({ platform: 'win32', homeDir: home, uid: -1 }, HUB_SERVICE, async () => ({ code: 0, stdout: '', stderr: '' })))
      .toMatchObject({ error: { code: 'unsupported_os' } });
  });

  it('install registers the XML and keeps a UTF-16 copy that readDefinition returns', async () => {
    const { manager, state, verbs } = fakeScheduler({ registered: false, running: false });
    expect(manager.isInstalled()).toBe(false);
    expect(manager.readDefinition()).toBeUndefined();
    await manager.install(xml('日本語'));
    expect(state.registered).toBe(true);
    expect(verbs).toEqual(['/Create']);
    expect(manager.isInstalled()).toBe(true);
    expect(manager.readDefinition()).toBe(xml('日本語'));
  });

  it('a failed update leaves the previous definition as it was, and putting it back registers it again', async () => {
    const { manager, state, specs } = fakeScheduler({ registered: false, running: false });
    await manager.install(xml('old'));
    state.createFails = true;
    await expect(manager.install(xml('new'))).rejects.toThrow(/malformed/);
    expect(manager.readDefinition()).toBe(xml('old'));

    state.createFails = false;
    const before = specs.length;
    await manager.install(manager.readDefinition()!);
    expect(specs.length).toBeGreaterThan(before);
    expect(manager.readDefinition()).toBe(xml('old'));
  });

  it('a failed first install leaves no definition behind', async () => {
    const { manager, state } = fakeScheduler({ registered: false, running: false });
    state.createFails = true;
    await expect(manager.install(xml('new'))).rejects.toThrow();
    expect(manager.isInstalled()).toBe(false);
    expect(fs.readdirSync(home).filter((f) => f.startsWith('azito-schtasks-'))).toEqual([]);
  });

  it('start runs a stopped task and does nothing for a running one', async () => {
    const stopped = fakeScheduler({ registered: true, running: false });
    await stopped.manager.start();
    expect(stopped.verbs).toEqual(['/Query', '/Run']);

    const running = fakeScheduler({ registered: true, running: true });
    await running.manager.start();
    expect(running.verbs).toEqual(['/Query']);
  });

  it('stop ends a running task and waits until it is gone; a stopped one is left alone', async () => {
    const running = fakeScheduler({ registered: true, running: true });
    await running.manager.stop();
    expect(running.verbs).toEqual(['/Query', '/End', '/Query']);
    expect(running.state.running).toBe(false);

    const stopped = fakeScheduler({ registered: true, running: false });
    await stopped.manager.stop();
    expect(stopped.verbs).toEqual(['/Query']);
  });

  it('stop fails with a reason when the task is still running after the timeout', async () => {
    const { manager, state } = fakeScheduler({ registered: true, running: true });
    state.endIgnored = true;
    await expect(manager.stop()).rejects.toThrow(/still running 200ms after \/End/);
  });

  it('restart stops, then starts; reload is a restart', async () => {
    const { manager, verbs } = fakeScheduler({ registered: true, running: true });
    await manager.restart();
    expect(verbs).toEqual(['/Query', '/End', '/Query', '/Run']);
    verbs.length = 0;
    await manager.reload();
    expect(verbs).toEqual(['/Query', '/End', '/Query', '/Run']);

    const stopped = fakeScheduler({ registered: true, running: false });
    await stopped.manager.restart();
    expect(stopped.verbs).toEqual(['/Query', '/Run']);
  });

  it('state: active when running, failed after a bad exit, inactive when stopped on purpose or not registered', async () => {
    expect((await fakeScheduler({ registered: true, running: true }).manager.inspect())).toEqual({ state: 'active', domains: [] });
    expect(await fakeScheduler({ registered: true, running: false, lastResult: '1' }).manager.state()).toBe('failed');
    expect(await fakeScheduler({ registered: true, running: false, lastResult: '267014' }).manager.state()).toBe('inactive');
    expect(await fakeScheduler({ registered: false, running: false }).manager.state()).toBe('inactive');
    expect(await fakeScheduler({ registered: true, running: false }).manager.loadedDomain()).toBeUndefined();
  });

  it('start of an unregistered task fails with the schtasks reason', async () => {
    const { manager } = fakeScheduler({ registered: false, running: false });
    await expect(manager.start()).rejects.toThrow(/schtasks \/run of the task "AzitoHub" failed/);
  });
});
