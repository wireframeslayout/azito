import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HUB_SERVICE,
  LaunchdServiceManager,
  SystemdServiceManager,
  createServiceManager,
  isServiceManagerKind,
  serviceManagerOfKind,
  type CommandResult,
  type CommandRunner,
} from '../serviceManager';
import { MISAO_SERVICE } from '../misao/misaoPaths';

function recorder(results: Record<string, Partial<CommandResult>> = {}): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = async (file, args) => {
    const line = `${file} ${args.join(' ')}`;
    calls.push(line);
    return { code: 0, stdout: '', stderr: '', ...results[line] };
  };
  return { run, calls };
}

describe('isServiceManagerKind', () => {
  it('rejects anything that is not a known service manager', () => {
    expect(isServiceManagerKind('systemd')).toBe(true);
    expect(isServiceManagerKind('launchd')).toBe(true);
    expect(isServiceManagerKind('source')).toBe(false);
    expect(isServiceManagerKind('')).toBe(false);
  });
});

describe('createServiceManager', () => {
  const run = recorder().run;

  it('picks systemd on Linux and launchd on macOS', () => {
    expect(createServiceManager({ platform: 'linux', homeDir: '/h' }, HUB_SERVICE, run)).toMatchObject({ manager: { kind: 'systemd' } });
    expect(createServiceManager({ platform: 'darwin', homeDir: '/h' }, HUB_SERVICE, run)).toMatchObject({ manager: { kind: 'launchd' } });
  });

  it('refuses Windows with unsupported_os and says why, instead of falling back to another manager', () => {
    const result = createServiceManager({ platform: 'win32', homeDir: 'C:\\Users\\u' }, HUB_SERVICE, run);
    expect(result).toMatchObject({ error: { code: 'unsupported_os', message: expect.stringContaining('Windows') } });
  });

  it('refuses an OS AZITO does not know with unsupported_host', () => {
    expect(createServiceManager({ platform: 'freebsd', homeDir: '/h' }, HUB_SERVICE, run)).toMatchObject({ error: { code: 'unsupported_host' } });
  });
});

describe('SystemdServiceManager', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('installs the unit, reloads and enables it, and does not start it', async () => {
    const { run, calls } = recorder();
    const manager = new SystemdServiceManager(run, MISAO_SERVICE, home);
    expect(manager.isInstalled()).toBe(false);

    await manager.install('[Unit]\n');

    expect(fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'azito-misao.service'), 'utf-8')).toBe('[Unit]\n');
    expect(manager.isInstalled()).toBe(true);
    expect(manager.readDefinition()).toBe('[Unit]\n');
    expect(calls.slice(0, 2)).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable azito-misao']);
    expect(calls.some((c) => c.includes('start'))).toBe(false);
  });

  it('puts a previous definition back exactly as it was by installing it again', async () => {
    const manager = new SystemdServiceManager(recorder().run, MISAO_SERVICE, home);
    await manager.install('[Service]\nExecStart=/old\n');
    const previous = manager.readDefinition()!;
    await manager.install('[Service]\nExecStart=/new\n');
    await manager.install(previous);
    expect(manager.readDefinition()).toBe('[Service]\nExecStart=/old\n');
  });

  it('runs the same systemctl commands for the hub as for misao, with the hub unit', async () => {
    const { run, calls } = recorder();
    const manager = new SystemdServiceManager(run, HUB_SERVICE, home);
    await manager.start();
    await manager.stop();
    await manager.restart();
    expect(calls).toEqual(['systemctl --user start azito', 'systemctl --user stop azito', 'systemctl --user restart azito']);
    expect(manager.templateName).toBe('azito-release.service');
    expect(await manager.loadedDomain()).toBeUndefined();
  });

  it('reports a failing systemctl with its output instead of carrying on', async () => {
    const { run } = recorder({ 'systemctl --user start azito-misao': { code: 1, stderr: 'Unit not found.' } });
    await expect(new SystemdServiceManager(run, MISAO_SERVICE, home).start()).rejects.toThrow(/systemctl start failed \(exit 1\): Unit not found\./);
  });

  it.each([['active\n', 'active'], ['failed\n', 'failed'], ['inactive\n', 'inactive'], ['weird\n', 'unknown']])('maps is-active output %j to %s', async (stdout, expected) => {
    const { run } = recorder({ 'systemctl --user is-active azito-misao': { code: 3, stdout } });
    expect(await new SystemdServiceManager(run, MISAO_SERVICE, home).state()).toBe(expected);
  });
});

describe('LaunchdServiceManager', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const plist = (label: string): string => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const gui = 'gui/501/com.azito.hub';
  const user = 'user/501/com.azito.hub';
  /** What launchctl does on a Mac where nobody is logged in on the screen: the gui domain is not there. */
  const noGui = {
    'launchctl print gui/501': { code: 125, stderr: 'Domain does not support specified action' },
    [`launchctl print ${gui}`]: { code: 125, stderr: 'Domain does not support specified action' },
  };
  const notLoaded = { [`launchctl print ${gui}`]: { code: 113 }, [`launchctl print ${user}`]: { code: 113 } };
  const manager = (run: CommandRunner): LaunchdServiceManager => new LaunchdServiceManager(run, HUB_SERVICE, home, 501);

  it('writes the plist and starts nothing on install', async () => {
    const { run, calls } = recorder();
    await new LaunchdServiceManager(run, MISAO_SERVICE, home, 501).install('<plist/>');
    expect(fs.readFileSync(plist('com.azito.misao'), 'utf-8')).toBe('<plist/>');
    expect(calls).toEqual([]);
  });

  describe('start', () => {
    it('bootstraps an unloaded job into the gui domain when it exists', async () => {
      const { run, calls } = recorder(notLoaded);
      await manager(run).start();
      expect(calls).toEqual([`launchctl print ${gui}`, `launchctl print ${user}`, 'launchctl print gui/501', `launchctl bootstrap gui/501 ${plist('com.azito.hub')}`]);
    });

    it('bootstraps into the user domain when there is no gui domain (nobody is logged in on the screen)', async () => {
      const { run, calls } = recorder({ ...noGui, [`launchctl print ${user}`]: { code: 113 } });
      await manager(run).start();
      expect(calls).toEqual([`launchctl print ${gui}`, `launchctl print ${user}`, 'launchctl print gui/501', `launchctl bootstrap user/501 ${plist('com.azito.hub')}`]);
    });

    it('also reads "could not find domain" (113) as no gui domain', async () => {
      const { run, calls } = recorder({ ...notLoaded, 'launchctl print gui/501': { code: 113 } });
      await manager(run).start();
      expect(calls.at(-1)).toBe(`launchctl bootstrap user/501 ${plist('com.azito.hub')}`);
    });

    it('only kickstarts a job that is already loaded, in the domain it is loaded into, and never bootstraps a second copy', async () => {
      const inGui = recorder();
      await manager(inGui.run).start();
      expect(inGui.calls).toEqual([`launchctl print ${gui}`, `launchctl kickstart ${gui}`]);

      const inUser = recorder({ [`launchctl print ${gui}`]: { code: 125 } });
      await manager(inUser.run).start();
      expect(inUser.calls).toEqual([`launchctl print ${gui}`, `launchctl print ${user}`, `launchctl kickstart ${user}`]);
    });

    it('keeps a job loaded into user/ there even when the gui domain appears later (a later login)', async () => {
      const { run, calls } = recorder({ [`launchctl print ${gui}`]: { code: 113 } });
      await manager(run).start();
      expect(calls).not.toContainEqual(expect.stringContaining('bootstrap'));
      expect(calls.at(-1)).toBe(`launchctl kickstart ${user}`);
    });

    it('fails with launchctl output when bootstrap fails, naming the domain', async () => {
      const { run } = recorder({ ...noGui, [`launchctl print ${user}`]: { code: 113 }, [`launchctl bootstrap user/501 ${plist('com.azito.hub')}`]: { code: 125, stderr: 'Bootstrap failed: 125: Domain does not support specified action' } });
      await expect(manager(run).start()).rejects.toThrow(/launchctl bootstrap user\/501 failed \(exit 125\): Bootstrap failed: 125/);
    });

    it('does not guess a domain when print gui/<uid> fails for another reason', async () => {
      const { run, calls } = recorder({ ...notLoaded, 'launchctl print gui/501': { code: 1, stderr: 'boom' } });
      await expect(manager(run).start()).rejects.toThrow(/cannot be told whether gui\/501 exists: boom/);
      expect(calls.some((c) => c.includes('bootstrap'))).toBe(false);
    });
  });

  describe('stop', () => {
    it('boots a loaded job out of the domain it is loaded into, and does nothing for an unloaded one', async () => {
      const inUser = recorder({ [`launchctl print ${gui}`]: { code: 113 } });
      await manager(inUser.run).stop();
      expect(inUser.calls).toEqual([`launchctl print ${gui}`, `launchctl print ${user}`, `launchctl bootout ${user}`]);

      const inGui = recorder({ [`launchctl print ${user}`]: { code: 113 } });
      await manager(inGui.run).stop();
      expect(inGui.calls).toEqual([`launchctl print ${gui}`, `launchctl bootout ${gui}`, `launchctl print ${user}`]);

      const unloaded = recorder(notLoaded);
      await manager(unloaded.run).stop();
      expect(unloaded.calls).toEqual([`launchctl print ${gui}`, `launchctl print ${user}`]);
    });

    it('boots out both copies when the job ended up loaded into both domains', async () => {
      const { run, calls } = recorder();
      await manager(run).stop();
      expect(calls.filter((c) => c.includes('bootout'))).toEqual([`launchctl bootout ${gui}`, `launchctl bootout ${user}`]);
    });
  });

  describe('restart', () => {
    it('kickstarts -k a loaded job in its own domain', async () => {
      const inGui = recorder();
      await manager(inGui.run).restart();
      expect(inGui.calls).toEqual([`launchctl print ${gui}`, `launchctl kickstart -k ${gui}`]);

      const inUser = recorder({ [`launchctl print ${gui}`]: { code: 113 } });
      await manager(inUser.run).restart();
      expect(inUser.calls.at(-1)).toBe(`launchctl kickstart -k ${user}`);
    });

    it('starts a job that is not loaded, as systemctl restart starts a stopped unit', async () => {
      const { run, calls } = recorder(notLoaded);
      await manager(run).restart();
      expect(calls.at(-1)).toBe(`launchctl bootstrap gui/501 ${plist('com.azito.hub')}`);
    });
  });

  describe('state and domain', () => {
    it('reads the job state and the domain from launchctl print', async () => {
      const running = recorder({ [`launchctl print ${gui}`]: { stdout: `${gui} = {\n\tstate = running\n}` } });
      expect(await manager(running.run).state()).toBe('active');
      expect(await manager(running.run).loadedDomain()).toBe('gui');

      const waiting = recorder({ [`launchctl print ${gui}`]: { code: 113 }, [`launchctl print ${user}`]: { stdout: '\tstate = waiting\n' } });
      expect(await manager(waiting.run).state()).toBe('inactive');
      expect(await manager(waiting.run).loadedDomain()).toBe('user');

      const absent = recorder(notLoaded);
      expect(await manager(absent.run).state()).toBe('inactive');
      expect(await manager(absent.run).loadedDomain()).toBeUndefined();
    });
  });

  it('serviceManagerOfKind builds the launchd manager with the given uid', async () => {
    const { run, calls } = recorder();
    await serviceManagerOfKind('launchd', HUB_SERVICE, run, home, () => 777).restart();
    expect(calls).toEqual(['launchctl print gui/777/com.azito.hub', 'launchctl kickstart -k gui/777/com.azito.hub']);
  });
});
