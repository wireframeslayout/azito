import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/exec/runCommandSpec', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/exec/runCommandSpec')>()), runCommandSpec: vi.fn() }));

import type { ServiceManager } from '../serviceManager';
import { powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { buildHubTaskXml, buildSingleRunLauncherScript, hubWindowsLayout } from '../windowsHubService';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import { runCommandSpec } from '../../../shared/exec/runCommandSpec';
import { installWindowsTask, requireOwnTask, uninstallWindowsTask, type ServiceCommandContext, type WindowsHub } from '../windowsHubOperations';

const MINE = 'C:\\Users\\me\\.azito';
const OTHER = 'C:\\Users\\other\\.azito';
const xmlFor = (prefix: string): string => buildHubTaskXml({ userId: 'PC\\me', systemRoot: 'C:\\Windows', layout: hubWindowsLayout(prefix) });
/** The task as the first 0.12 builds registered it: the launcher that ran the hub once. */
const singleRunXmlFor = (prefix: string): string => xmlFor(prefix).replace(/-EncodedCommand [A-Za-z0-9+/=]+/, `-EncodedCommand ${powershellEncodedArgs(buildSingleRunLauncherScript(hubWindowsLayout(prefix))).at(-1)}`);
const context: ServiceCommandContext = { bundleRoot: `${MINE}\\hub\\v1.0.0`, pid: 1, secretFileGuard: new UnixSecretFileGuard() };

/** `registered` is what the Task Scheduler holds (undefined: no task); `copy` is our definition copy; they may disagree. */
function setup(registered: string | undefined, copy: string | undefined, running = false) {
  const hub = {
    layout: hubWindowsLayout(MINE),
    hubRoots: [`${MINE}\\hub`],
    systemRoot: 'C:\\Windows',
    client: {
      query: vi.fn(async () => (registered === undefined ? { exists: false } : { exists: true, running, failed: false, lastResult: 0 })),
      exportXml: vi.fn(async () => registered as string),
    },
  } as unknown as WindowsHub;
  const manager = {
    readDefinition: vi.fn(() => copy),
    state: vi.fn(async () => (running ? 'active' : 'inactive')),
    install: vi.fn(async () => undefined),
  } as unknown as ServiceManager;
  return { hub, manager };
}

describe('requireOwnTask', () => {
  it('asks the task itself: a copy that says "mine" does not make another install\'s task mine', async () => {
    const { hub, manager } = setup(xmlFor(OTHER), xmlFor(MINE));
    await expect(requireOwnTask(manager, hub)).rejects.toThrow(/belongs to another install \(C:\\Users\\other\\\.azito\)/);
  });

  it('accepts this install\'s task', async () => {
    const { hub, manager } = setup(xmlFor(MINE), xmlFor(MINE));
    await expect(requireOwnTask(manager, hub)).resolves.toBeUndefined();
  });

  it('still operates this install\'s task from the first 0.12 builds (it is replaced by service install, not locked out)', async () => {
    const { hub, manager } = setup(singleRunXmlFor(MINE), singleRunXmlFor(MINE));
    await expect(requireOwnTask(manager, hub)).resolves.toBeUndefined();
  });

  it('refuses a task it does not recognise', async () => {
    const { hub, manager } = setup('<Task></Task>', xmlFor(MINE));
    await expect(requireOwnTask(manager, hub)).rejects.toThrow(/not one this version of AZITO recognises/);
  });

  it('tells a deleted task (copy left) from a service that was never installed', async () => {
    await expect(requireOwnTask(setup(undefined, xmlFor(MINE)).manager, setup(undefined, xmlFor(MINE)).hub)).rejects.toThrow(/deleted/);
    const none = setup(undefined, undefined);
    await expect(requireOwnTask(none.manager, none.hub)).rejects.toThrow(/not installed/);
  });
});

describe('uninstallWindowsTask', () => {
  beforeEach(() => {
    vi.mocked(runCommandSpec).mockReset().mockResolvedValueOnce({ exitCode: 0, stdout: Buffer.from('PC\\me').toString('base64'), stderr: '' } as never).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
  });

  it('deletes the stopped task owned by this install', async () => {
    const { hub, manager } = setup(xmlFor(MINE), xmlFor(MINE));
    const remove = vi.fn(async () => undefined);
    hub.client.delete = remove;
    vi.mocked(hub.client.query).mockImplementation(async (name) => name === 'AzitoHubUpdate' ? { exists: false } : { exists: true, running: false, failed: false, lastResult: 0 });
    await uninstallWindowsTask(manager, hub, context);
    expect(remove).toHaveBeenCalledWith('AzitoHub');
  });

  it('leaves the task when a hub process is running', async () => {
    const { hub, manager } = setup(xmlFor(MINE), xmlFor(MINE));
    const remove = vi.fn();
    hub.client.delete = remove;
    vi.mocked(hub.client.query).mockImplementation(async (name) => name === 'AzitoHubUpdate' ? { exists: false } : { exists: true, running: false, failed: false, lastResult: 0 });
    vi.mocked(runCommandSpec).mockResolvedValue({ exitCode: 0, stdout: '42 1234\n', stderr: '' } as never);
    await expect(uninstallWindowsTask(manager, hub, context)).rejects.toThrow(/hub process is still running/);
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses a running foreground hub even when no task is registered', async () => {
    const { hub, manager } = setup(undefined, undefined);
    vi.mocked(runCommandSpec).mockReset().mockResolvedValue({ exitCode: 0, stdout: '42 1234\n', stderr: '' } as never);
    await expect(uninstallWindowsTask(manager, hub, context)).rejects.toThrow(/hub process is still running/);
  });

  it('does not delete another install’s task', async () => {
    const { hub, manager } = setup(xmlFor(OTHER), xmlFor(MINE));
    const remove = vi.fn();
    hub.client.delete = remove;
    vi.mocked(hub.client.query).mockImplementation(async (name) => name === 'AzitoHubUpdate' ? { exists: false } : { exists: true, running: false, failed: false, lastResult: 0 });
    await expect(uninstallWindowsTask(manager, hub, context)).rejects.toThrow(/another install/);
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not delete a task running as another account', async () => {
    const foreign = xmlFor(MINE).replaceAll('<UserId>PC\\me</UserId>', '<UserId>PC\\other</UserId>');
    const { hub, manager } = setup(foreign, xmlFor(MINE));
    const remove = vi.fn();
    hub.client.delete = remove;
    vi.mocked(hub.client.query).mockImplementation(async (name) => name === 'AzitoHubUpdate' ? { exists: false } : { exists: true, running: false, failed: false, lastResult: 0 });
    await expect(uninstallWindowsTask(manager, hub, context)).rejects.toThrow(/different or unrecognised Windows account/);
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses while an update task exists', async () => {
    const { hub, manager } = setup(xmlFor(MINE), xmlFor(MINE));
    const remove = vi.fn();
    hub.client.delete = remove;
    await expect(uninstallWindowsTask(manager, hub, context)).rejects.toThrow(/AzitoHubUpdate/);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('installWindowsTask', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(runCommandSpec).mockReset().mockResolvedValue({ exitCode: 0, stdout: `${Buffer.from('PC\\me').toString('base64')}\r\n`, stderr: '' } as never);
  });
  afterEach(() => { log.mockRestore(); });

  it('registers when there is no task, even though a copy is left', async () => {
    const { hub, manager } = setup(undefined, xmlFor(MINE));
    await installWindowsTask(manager, hub, false);
    expect(manager.install).toHaveBeenCalledTimes(1);
  });

  it('does nothing for this install\'s task with the same definition', async () => {
    const { hub, manager } = setup(xmlFor(MINE), xmlFor(MINE));
    await installWindowsTask(manager, hub, false);
    expect(manager.install).not.toHaveBeenCalled();
  });

  it('takes the account from Windows, not from the environment: a session whose USERDOMAIN is WORKGROUP still registers PC\\me', async () => {
    vi.stubEnv('USERDOMAIN', 'WORKGROUP');
    try {
      const { hub, manager } = setup(undefined, undefined);
      await installWindowsTask(manager, hub, false);
      expect(manager.install).toHaveBeenCalledWith(xmlFor(MINE));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not touch the task when the account cannot be read', async () => {
    vi.mocked(runCommandSpec).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' } as never);
    const { hub, manager } = setup(undefined, undefined);
    await expect(installWindowsTask(manager, hub, false)).rejects.toThrow(/Reading the account.*boom/);
    expect(manager.install).not.toHaveBeenCalled();
  });

  it('counts a registered definition that differs only in the case of the account as the same one (also while it runs)', async () => {
    const lower = xmlFor(MINE).replace('PC\\me', 'pc\\ME');
    const idle = setup(lower, lower);
    await installWindowsTask(idle.manager, idle.hub, false);
    expect(idle.manager.install).not.toHaveBeenCalled();
    const running = setup(lower, lower, true);
    await installWindowsTask(running.manager, running.hub, false);
    expect(running.manager.install).not.toHaveBeenCalled();
  });

  it('replaces this install\'s task from the first 0.12 builds (one that does not start the hub again) with the new launcher, without --yes, once it is stopped', async () => {
    const { hub, manager } = setup(singleRunXmlFor(MINE), singleRunXmlFor(MINE));
    await installWindowsTask(manager, hub, false);
    expect(manager.install).toHaveBeenCalledWith(xmlFor(MINE));
    // The registered task decides, not the copy: a copy that already is the new definition does not make an old task current.
    const stale = setup(singleRunXmlFor(MINE), xmlFor(MINE));
    await installWindowsTask(stale.manager, stale.hub, false);
    expect(stale.manager.install).toHaveBeenCalledWith(xmlFor(MINE));
    const running = setup(singleRunXmlFor(MINE), singleRunXmlFor(MINE), true);
    await expect(installWindowsTask(running.manager, running.hub, false)).rejects.toThrow(/is running\. Stop it first/);
    expect(running.manager.install).not.toHaveBeenCalled();
  });

  it('judges by the task, not the copy: another install\'s stopped task needs --yes even when the copy is missing or looks like ours', async () => {
    for (const copy of [undefined, xmlFor(MINE)]) {
      const { hub, manager } = setup(xmlFor(OTHER), copy);
      await expect(installWindowsTask(manager, hub, false)).rejects.toThrow(/--yes/);
      expect(manager.install).not.toHaveBeenCalled();
    }
    const { hub, manager } = setup(xmlFor(OTHER), undefined);
    await installWindowsTask(manager, hub, true);
    expect(manager.install).toHaveBeenCalledTimes(1);
  });

  it('treats a definition it does not recognise as somebody else\'s: --yes to replace it', async () => {
    const stopped = setup('<Task>edited</Task>', xmlFor(MINE));
    await expect(installWindowsTask(stopped.manager, stopped.hub, false)).rejects.toThrow(/does not recognise.*--yes/);
    await installWindowsTask(stopped.manager, stopped.hub, true);
    expect(stopped.manager.install).toHaveBeenCalledTimes(1);
  });

  it('never replaces a running task, with --yes either, and with or without a copy', async () => {
    for (const registered of [xmlFor(OTHER), '<Task>edited</Task>']) {
      for (const copy of [undefined, xmlFor(MINE)]) {
        const { hub, manager } = setup(registered, copy, true);
        await expect(installWindowsTask(manager, hub, true)).rejects.toThrow(/is running/);
        expect(manager.install).not.toHaveBeenCalled();
      }
    }
  });
});
