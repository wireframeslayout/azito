import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateLoadError,
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
    expect(createServiceManager({ platform: 'linux', homeDir: '/h', uid: 501 }, HUB_SERVICE, run)).toMatchObject({ manager: { kind: 'systemd' } });
    expect(createServiceManager({ platform: 'darwin', homeDir: '/h', uid: 501 }, HUB_SERVICE, run)).toMatchObject({ manager: { kind: 'launchd' } });
  });

  it('refuses Windows with unsupported_os and says why, instead of falling back to another manager', () => {
    const result = createServiceManager({ platform: 'win32', homeDir: 'C:\\Users\\u', uid: -1 }, HUB_SERVICE, run);
    expect(result).toMatchObject({ error: { code: 'unsupported_os', message: expect.stringContaining('Windows') } });
  });

  it('refuses an OS AZITO does not know with unsupported_host', () => {
    expect(createServiceManager({ platform: 'freebsd', homeDir: '/h', uid: 501 }, HUB_SERVICE, run)).toMatchObject({ error: { code: 'unsupported_host' } });
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

  it('runs the same systemctl commands for the hub as for misao, with the hub unit; reload is daemon-reload then restart', async () => {
    const { run, calls } = recorder();
    const manager = new SystemdServiceManager(run, HUB_SERVICE, home);
    await manager.start();
    await manager.stop();
    await manager.restart();
    await manager.reload();
    expect(calls).toEqual([
      'systemctl --user start azito',
      'systemctl --user stop azito',
      'systemctl --user restart azito',
      'systemctl --user daemon-reload',
      'systemctl --user restart azito',
    ]);
    expect(manager.templateName).toBe('azito-release.service');
    expect(await manager.loadedDomain()).toBeUndefined();
  });

  it('does not restart when daemon-reload fails', async () => {
    const { run, calls } = recorder({ 'systemctl --user daemon-reload': { code: 1, stderr: 'Failed to connect to bus' } });
    await expect(new SystemdServiceManager(run, HUB_SERVICE, home).reload()).rejects.toThrow(/systemctl daemon-reload failed \(exit 1\)/);
    expect(calls).toEqual(['systemctl --user daemon-reload']);
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
  const printGui = `launchctl print ${gui}`;
  const printUser = `launchctl print ${user}`;
  /** What launchctl does on a Mac where nobody is logged in on the screen: the gui domain is not there. */
  const noGui = {
    'launchctl print gui/501': { code: 125, stderr: 'Domain does not support specified action' },
    [printGui]: { code: 125, stderr: 'Domain does not support specified action' },
  };
  const notLoaded = { [printGui]: { code: 113 }, [printUser]: { code: 113 } };
  /** Loaded into one domain only. */
  const onlyIn = (domain: 'gui' | 'user'): Record<string, Partial<CommandResult>> => ({ [domain === 'gui' ? printUser : printGui]: { code: 113 } });
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
      expect(calls).toEqual([printGui, printUser, 'launchctl print gui/501', `launchctl bootstrap gui/501 ${plist('com.azito.hub')}`]);
    });

    it('bootstraps into the user domain when there is no gui domain (nobody is logged in on the screen)', async () => {
      const { run, calls } = recorder({ ...noGui, [printUser]: { code: 113 } });
      await manager(run).start();
      expect(calls).toEqual([printGui, printUser, 'launchctl print gui/501', `launchctl bootstrap user/501 ${plist('com.azito.hub')}`]);
    });

    it('also reads "could not find domain" (113) as no gui domain', async () => {
      const { run, calls } = recorder({ ...notLoaded, 'launchctl print gui/501': { code: 113 } });
      await manager(run).start();
      expect(calls.at(-1)).toBe(`launchctl bootstrap user/501 ${plist('com.azito.hub')}`);
    });

    it('bootstraps into the domain it is told to, even when the gui domain exists (putting a job back where it was)', async () => {
      const { run, calls } = recorder(notLoaded);
      await manager(run).start('user');
      expect(calls).toEqual([printGui, printUser, `launchctl bootstrap user/501 ${plist('com.azito.hub')}`]);
    });

    it('only kickstarts a job that is already loaded, in the domain it is loaded into, and never bootstraps a second copy', async () => {
      const inGui = recorder(onlyIn('gui'));
      await manager(inGui.run).start();
      expect(inGui.calls).toEqual([printGui, printUser, `launchctl kickstart ${gui}`]);

      // Loaded into user/ while gui/ exists (someone logged in later): it stays in user/.
      const inUser = recorder(onlyIn('user'));
      await manager(inUser.run).start('gui');
      expect(inUser.calls).toEqual([printGui, printUser, `launchctl kickstart ${user}`]);
    });

    it('refuses a job loaded into both domains instead of picking one', async () => {
      const { run, calls } = recorder();
      await expect(manager(run).start()).rejects.toThrow(DuplicateLoadError);
      await expect(manager(run).start()).rejects.toThrow(/both gui\/501 and user\/501.*azito service stop/);
      expect(calls.some((c) => /kickstart|bootstrap|bootout/.test(c))).toBe(false);
    });

    it('fails with launchctl output when bootstrap fails, naming the domain', async () => {
      const { run } = recorder({ ...noGui, [printUser]: { code: 113 }, [`launchctl bootstrap user/501 ${plist('com.azito.hub')}`]: { code: 125, stderr: 'Bootstrap failed: 125: Domain does not support specified action' } });
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
      const inUser = recorder(onlyIn('user'));
      await manager(inUser.run).stop();
      expect(inUser.calls).toEqual([printGui, printUser, `launchctl bootout ${user}`]);

      const inGui = recorder(onlyIn('gui'));
      await manager(inGui.run).stop();
      expect(inGui.calls).toEqual([printGui, printUser, `launchctl bootout ${gui}`]);

      const unloaded = recorder(notLoaded);
      await manager(unloaded.run).stop();
      expect(unloaded.calls).toEqual([printGui, printUser]);
    });

    it('boots out both copies when the job ended up loaded into both domains', async () => {
      const { run, calls } = recorder();
      await manager(run).stop();
      expect(calls.filter((c) => c.includes('bootout'))).toEqual([`launchctl bootout ${gui}`, `launchctl bootout ${user}`]);
    });
  });

  describe('restart', () => {
    it('kickstarts -k a loaded job in its own domain', async () => {
      const inGui = recorder(onlyIn('gui'));
      await manager(inGui.run).restart();
      expect(inGui.calls).toEqual([printGui, printUser, `launchctl kickstart -k ${gui}`]);

      const inUser = recorder(onlyIn('user'));
      await manager(inUser.run).restart();
      expect(inUser.calls.at(-1)).toBe(`launchctl kickstart -k ${user}`);
    });

    it('starts a job that is not loaded, as systemctl restart starts a stopped unit', async () => {
      const { run, calls } = recorder(notLoaded);
      await manager(run).restart();
      expect(calls.at(-1)).toBe(`launchctl bootstrap gui/501 ${plist('com.azito.hub')}`);
    });

    it('refuses a job loaded into both domains', async () => {
      await expect(manager(recorder().run).restart()).rejects.toThrow(DuplicateLoadError);
    });
  });

  describe('reload', () => {
    it('boots the job out and bootstraps it again into the domain it was in, even when the gui domain exists', async () => {
      const { run, calls } = recorder(onlyIn('user'));
      await manager(run).reload();
      expect(calls).toEqual([printGui, printUser, `launchctl bootout ${user}`, `launchctl bootstrap user/501 ${plist('com.azito.hub')}`]);
    });

    it('starts a job that is not loaded, and refuses one loaded into both domains', async () => {
      const unloaded = recorder(notLoaded);
      await manager(unloaded.run).reload();
      expect(unloaded.calls.at(-1)).toBe(`launchctl bootstrap gui/501 ${plist('com.azito.hub')}`);
      await expect(manager(recorder().run).reload()).rejects.toThrow(DuplicateLoadError);
    });
  });

  describe('inspect', () => {
    it('returns the state and the domains from one pair of launchctl print calls', async () => {
      const running = recorder({ ...onlyIn('gui'), [printGui]: { stdout: `${gui} = {\n\tstate = running\n}` } });
      expect(await manager(running.run).inspect()).toEqual({ state: 'active', domains: ['gui'] });
      expect(running.calls).toEqual([printGui, printUser]);

      const waiting = recorder({ ...onlyIn('user'), [printUser]: { stdout: '\tstate = waiting\n' } });
      expect(await manager(waiting.run).inspect()).toEqual({ state: 'inactive', domains: ['user'] });

      const absent = recorder(notLoaded);
      expect(await manager(absent.run).inspect()).toEqual({ state: 'inactive', domains: [] });

      const both = recorder({ [printGui]: { stdout: '\tstate = waiting\n' }, [printUser]: { stdout: '\tstate = running\n' } });
      expect(await manager(both.run).inspect()).toEqual({ state: 'active', domains: ['gui', 'user'] });
    });

    it('loadedDomain gives the one domain, none, or refuses a double load', async () => {
      expect(await manager(recorder(onlyIn('user')).run).loadedDomain()).toBe('user');
      expect(await manager(recorder(notLoaded).run).loadedDomain()).toBeUndefined();
      await expect(manager(recorder().run).loadedDomain()).rejects.toThrow(DuplicateLoadError);
    });
  });

  it('serviceManagerOfKind builds the launchd manager with the given uid', async () => {
    const { run, calls } = recorder({ 'launchctl print gui/777/com.azito.hub': { code: 113 } });
    await serviceManagerOfKind('launchd', HUB_SERVICE, run, { homeDir: home, uid: 777 }).restart();
    expect(calls).toEqual(['launchctl print gui/777/com.azito.hub', 'launchctl print user/777/com.azito.hub', 'launchctl kickstart -k user/777/com.azito.hub']);
  });
});
