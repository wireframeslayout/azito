import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceManager } from '../serviceManager';
import { powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { buildHubTaskXml, buildSingleRunLauncherScript, hubWindowsLayout } from '../windowsHubService';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import { installWindowsTask, requireOwnTask, type ServiceCommandContext, type WindowsHub } from '../windowsHubOperations';

const MINE = 'C:\\Users\\me\\.azito';
const OTHER = 'C:\\Users\\other\\.azito';
const xmlFor = (prefix: string): string => buildHubTaskXml({ userId: 'PC\\me', systemRoot: 'C:\\Windows', layout: hubWindowsLayout(prefix) });
/** The task as the first 0.12 builds registered it: the launcher that ran the hub once. */
const singleRunXmlFor = (prefix: string): string => xmlFor(prefix).replace(/-EncodedCommand [A-Za-z0-9+/=]+/, `-EncodedCommand ${powershellEncodedArgs(buildSingleRunLauncherScript(hubWindowsLayout(prefix))).at(-1)}`);
const context: ServiceCommandContext = { env: { USERDOMAIN: 'PC', USERNAME: 'me' }, bundleRoot: `${MINE}\\hub\\v1.0.0`, pid: 1, secretFileGuard: new UnixSecretFileGuard() };

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

describe('installWindowsTask', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });

  it('registers when there is no task, even though a copy is left', async () => {
    const { hub, manager } = setup(undefined, xmlFor(MINE));
    await installWindowsTask(manager, hub, context, false);
    expect(manager.install).toHaveBeenCalledTimes(1);
  });

  it('does nothing for this install\'s task with the same definition', async () => {
    const { hub, manager } = setup(xmlFor(MINE), xmlFor(MINE));
    await installWindowsTask(manager, hub, context, false);
    expect(manager.install).not.toHaveBeenCalled();
  });

  it('replaces this install\'s task from the first 0.12 builds (one that does not start the hub again) with the new launcher, without --yes, once it is stopped', async () => {
    const { hub, manager } = setup(singleRunXmlFor(MINE), singleRunXmlFor(MINE));
    await installWindowsTask(manager, hub, context, false);
    expect(manager.install).toHaveBeenCalledWith(xmlFor(MINE));
    // The registered task decides, not the copy: a copy that already is the new definition does not make an old task current.
    const stale = setup(singleRunXmlFor(MINE), xmlFor(MINE));
    await installWindowsTask(stale.manager, stale.hub, context, false);
    expect(stale.manager.install).toHaveBeenCalledWith(xmlFor(MINE));
    const running = setup(singleRunXmlFor(MINE), singleRunXmlFor(MINE), true);
    await expect(installWindowsTask(running.manager, running.hub, context, false)).rejects.toThrow(/is running\. Stop it first/);
    expect(running.manager.install).not.toHaveBeenCalled();
  });

  it('judges by the task, not the copy: another install\'s stopped task needs --yes even when the copy is missing or looks like ours', async () => {
    for (const copy of [undefined, xmlFor(MINE)]) {
      const { hub, manager } = setup(xmlFor(OTHER), copy);
      await expect(installWindowsTask(manager, hub, context, false)).rejects.toThrow(/--yes/);
      expect(manager.install).not.toHaveBeenCalled();
    }
    const { hub, manager } = setup(xmlFor(OTHER), undefined);
    await installWindowsTask(manager, hub, context, true);
    expect(manager.install).toHaveBeenCalledTimes(1);
  });

  it('treats a definition it does not recognise as somebody else\'s: --yes to replace it', async () => {
    const stopped = setup('<Task>edited</Task>', xmlFor(MINE));
    await expect(installWindowsTask(stopped.manager, stopped.hub, context, false)).rejects.toThrow(/does not recognise.*--yes/);
    await installWindowsTask(stopped.manager, stopped.hub, context, true);
    expect(stopped.manager.install).toHaveBeenCalledTimes(1);
  });

  it('never replaces a running task, with --yes either, and with or without a copy', async () => {
    for (const registered of [xmlFor(OTHER), '<Task>edited</Task>']) {
      for (const copy of [undefined, xmlFor(MINE)]) {
        const { hub, manager } = setup(registered, copy, true);
        await expect(installWindowsTask(manager, hub, context, true)).rejects.toThrow(/is running/);
        expect(manager.install).not.toHaveBeenCalled();
      }
    }
  });
});
