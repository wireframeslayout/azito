import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateLoadError,
  HUB_SERVICE,
  LaunchdServiceManager,
  SystemdServiceManager,
  isServiceManagerKind,
  limitToBackgroundSession,
  serviceManagerOfKind,
  type CommandResult,
  type CommandRunner,
  type LaunchdTiming,
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

const LEGACY_PLIST = '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.azito.hub</string>\n</dict>\n</plist>\n';
const TIMING: LaunchdTiming = { settleTimeoutMs: 200, pollIntervalMs: 1, bootstrapRetries: 2, retryDelayMs: 1 };

type Domain = 'gui' | 'user';

/**
 * launchctl as far as it matters here, with what was found on a real Mac (#366): `bootstrap user/` only takes a plist
 * limited to the Background session type, `bootstrap gui/` only takes one that is not, and for a moment after a
 * `bootout` the job is still reported by `print` and a bootstrap answers 5.
 */
class FakeLaunchctl {
  readonly loaded = new Set<Domain>();
  readonly calls: string[] = [];
  /** How many `print` / `bootstrap` answers still see a job that was just booted out. */
  lingerAfterBootout = 0;
  /** The next N bootstraps fail with exit 5 whatever the plist. */
  failBootstraps = 0;
  /** Every bootstrap into this domain fails with this exit code. */
  alwaysFail: Partial<Record<Domain, number>> = {};
  private lingering = new Map<Domain, number>();

  constructor(private readonly plistPath: string) {}

  readonly run: CommandRunner = async (_file, args) => {
    this.calls.push(args.join(' '));
    const [sub, ...rest] = args;
    if (sub === 'print') {
      const domain = rest[0].split('/')[0] as Domain;
      if (this.loaded.has(domain)) return { code: 0, stdout: '\tstate = running\n', stderr: '' };
      const left = this.lingering.get(domain) ?? 0;
      if (left > 0 && rest[0].includes('com.azito')) {
        this.lingering.set(domain, left - 1);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 113, stdout: '', stderr: '' };
    }
    if (sub === 'bootstrap') {
      const domain = rest[0].split('/')[0] as Domain;
      const forced = this.alwaysFail[domain];
      if (forced !== undefined) return { code: forced, stdout: '', stderr: `forced ${forced}` };
      if (this.failBootstraps > 0) {
        this.failBootstraps--;
        return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      }
      const limited = fs.readFileSync(rest[1], 'utf-8').includes('LimitLoadToSessionType');
      if ((domain === 'user') !== limited) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      const left = this.lingering.get(domain) ?? 0;
      if (left > 0) {
        this.lingering.set(domain, left - 1);
        return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      }
      this.loaded.add(domain);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'bootout') {
      const domain = rest[0].split('/')[0] as Domain;
      this.loaded.delete(domain);
      this.lingering.set(domain, this.lingerAfterBootout);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'kickstart') {
      const target = rest[rest.length - 1];
      return this.loaded.has(target.split('/')[0] as Domain) ? { code: 0, stdout: '', stderr: '' } : { code: 113, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${sub}` };
  };

  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

describe('limitToBackgroundSession', () => {
  it('adds the session limit to a plist from an older install, once', () => {
    const limited = limitToBackgroundSession(LEGACY_PLIST);
    expect(limited).toContain('<key>LimitLoadToSessionType</key>\n  <string>Background</string>\n</dict>');
    expect(limitToBackgroundSession(limited)).toBe(limited);
  });

  it('refuses text that is not a plist instead of guessing', () => {
    expect(() => limitToBackgroundSession('not a plist')).toThrow(/no top-level <dict>/);
  });

  it('is already in both shipped templates (install.sh and the misao installer write them)', () => {
    for (const name of ['com.azito.hub.plist', 'com.azito.misao.plist']) {
      const template = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'deploy', name), 'utf-8');
      expect(template).toMatch(/<key>LimitLoadToSessionType<\/key>\s*<string>Background<\/string>/);
    }
  });
});

describe('LaunchdServiceManager', () => {
  let home: string;
  let plistPath: string;
  let launchctl: FakeLaunchctl;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-'));
    plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.azito.hub.plist');
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, LEGACY_PLIST);
    launchctl = new FakeLaunchctl(plistPath);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const manager = (run: CommandRunner = launchctl.run): LaunchdServiceManager => new LaunchdServiceManager(run, HUB_SERVICE, home, 501, TIMING);
  const onDisk = (): string => fs.readFileSync(plistPath, 'utf-8');

  it('writes the plist and starts nothing on install', async () => {
    const { run, calls } = recorder();
    await new LaunchdServiceManager(run, MISAO_SERVICE, home, 501, TIMING).install('<plist/>');
    expect(fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.azito.misao.plist'), 'utf-8')).toBe('<plist/>');
    expect(calls).toEqual([]);
  });

  describe('start', () => {
    it('bootstraps an unloaded job into user/<uid>, whether or not anyone is logged in, with the session limit added to an old plist', async () => {
      await manager().start();
      expect([...launchctl.loaded]).toEqual(['user']);
      expect(onDisk()).toContain('LimitLoadToSessionType');
      expect(launchctl.calls.filter((c) => c.startsWith('bootstrap'))).toEqual([`bootstrap user/501 ${plistPath}`]);
      expect(launchctl.calls.some((c) => c === 'print gui/501')).toBe(false);
    });

    it('only kickstarts a job that is loaded into user/<uid>', async () => {
      launchctl.loaded.add('user');
      await manager().start();
      expect(launchctl.calls).toEqual(['print gui/501/com.azito.hub', 'print user/501/com.azito.hub', 'kickstart user/501/com.azito.hub']);
    });

    it('moves a job an older install loaded into gui/<uid>: boot it out, limit the plist, bootstrap into user/<uid>', async () => {
      launchctl.loaded.add('gui');
      await manager().start();
      expect([...launchctl.loaded]).toEqual(['user']);
      expect(onDisk()).toContain('LimitLoadToSessionType');
      expect(launchctl.calls.filter((c) => /^(bootout|bootstrap)/.test(c))).toEqual(['bootout gui/501/com.azito.hub', `bootstrap user/501 ${plistPath}`]);
    });

    it('puts the original plist back into gui/<uid> when the move fails', async () => {
      launchctl.loaded.add('gui');
      launchctl.alwaysFail.user = 5;
      await expect(manager().start()).rejects.toThrow(/Moving com\.azito\.hub from gui\/501 to user\/501 failed .*loaded back into gui\/501 as it was/);
      expect(onDisk()).toBe(LEGACY_PLIST);
      expect([...launchctl.loaded]).toEqual(['gui']);
    });

    it('says so when the move and the way back both fail', async () => {
      launchctl.loaded.add('gui');
      launchctl.alwaysFail.user = 5;
      launchctl.alwaysFail.gui = 5;
      await expect(manager().start()).rejects.toThrow(/loading it back into gui\/501 failed too .*It is not running/);
      expect(onDisk()).toBe(LEGACY_PLIST);
    });

    it('refuses a job loaded into both domains instead of picking one', async () => {
      launchctl.loaded.add('gui');
      launchctl.loaded.add('user');
      await expect(manager().start()).rejects.toThrow(DuplicateLoadError);
      await expect(manager().start()).rejects.toThrow(/both gui\/501 and user\/501.*azito service stop/);
      expect(launchctl.calls.some((c) => /^(kickstart|bootstrap|bootout)/.test(c))).toBe(false);
    });

    it('tries a bootstrap again when launchd answers 5, a few times at most', async () => {
      launchctl.failBootstraps = 2;
      await manager().start();
      expect(launchctl.count('bootstrap')).toBe(3);
      expect([...launchctl.loaded]).toEqual(['user']);

      launchctl.loaded.clear();
      launchctl.calls.length = 0;
      launchctl.failBootstraps = 3;
      await expect(manager().start()).rejects.toThrow(/launchctl bootstrap user\/501 failed \(exit 5\): Bootstrap failed: 5/);
      expect(launchctl.count('bootstrap')).toBe(3);
    });

    it('does not try a bootstrap again for any other failure', async () => {
      launchctl.alwaysFail.user = 37;
      await expect(manager().start()).rejects.toThrow(/exit 37/);
      expect(launchctl.count('bootstrap')).toBe(1);
    });
  });

  describe('stop', () => {
    it('boots a loaded job out and waits until launchd stops reporting it', async () => {
      launchctl.loaded.add('user');
      launchctl.lingerAfterBootout = 3;
      await manager().stop();
      const afterBootout = launchctl.calls.slice(launchctl.calls.indexOf('bootout user/501/com.azito.hub') + 1);
      expect(afterBootout).toEqual(Array(4).fill('print user/501/com.azito.hub'));
    });

    it('does nothing for an unloaded job, and boots both copies out of a job loaded twice', async () => {
      await manager().stop();
      expect(launchctl.count('bootout')).toBe(0);

      launchctl.loaded.add('gui');
      launchctl.loaded.add('user');
      await manager().stop();
      expect(launchctl.calls.filter((c) => c.startsWith('bootout'))).toEqual(['bootout gui/501/com.azito.hub', 'bootout user/501/com.azito.hub']);
    });

    it('a stop followed by a start works although launchd is slow to forget the job (an update, or putting the old version back)', async () => {
      launchctl.loaded.add('user');
      launchctl.lingerAfterBootout = 6;
      await manager().stop();
      await manager().start();
      expect([...launchctl.loaded]).toEqual(['user']);
    });
  });

  describe('restart', () => {
    it('kickstarts -k a job loaded into user/<uid>, starts one that is not loaded, moves one from gui/<uid>, and refuses a double load', async () => {
      launchctl.loaded.add('user');
      await manager().restart();
      expect(launchctl.calls.at(-1)).toBe('kickstart -k user/501/com.azito.hub');

      launchctl.loaded.clear();
      await manager().restart();
      expect([...launchctl.loaded]).toEqual(['user']);

      launchctl.loaded.clear();
      launchctl.loaded.add('gui');
      await manager().restart();
      expect([...launchctl.loaded]).toEqual(['user']);

      launchctl.loaded.add('gui');
      await expect(manager().restart()).rejects.toThrow(DuplicateLoadError);
    });
  });

  describe('reload', () => {
    it('boots the job out, waits, and bootstraps it again: the loaded job stays running even when launchd is slow (3 of 3 on a real Mac failed 2 times before)', async () => {
      launchctl.loaded.add('user');
      launchctl.lingerAfterBootout = 4;
      fs.writeFileSync(plistPath, limitToBackgroundSession(LEGACY_PLIST));
      await manager().reload();
      expect([...launchctl.loaded]).toEqual(['user']);
      expect(launchctl.count('bootstrap')).toBe(1);
    });

    it('starts a job that is not loaded, moves one from gui/<uid>, and refuses a double load', async () => {
      await manager().reload();
      expect([...launchctl.loaded]).toEqual(['user']);

      launchctl.loaded.clear();
      launchctl.loaded.add('gui');
      await manager().reload();
      expect([...launchctl.loaded]).toEqual(['user']);

      launchctl.loaded.add('gui');
      await expect(manager().reload()).rejects.toThrow(DuplicateLoadError);
    });
  });

  describe('inspect', () => {
    it('returns the state and the domains from one pair of launchctl print calls', async () => {
      launchctl.loaded.add('gui');
      expect(await manager().inspect()).toEqual({ state: 'active', domains: ['gui'] });
      expect(launchctl.calls).toEqual(['print gui/501/com.azito.hub', 'print user/501/com.azito.hub']);

      launchctl.loaded.clear();
      expect(await manager().inspect()).toEqual({ state: 'inactive', domains: [] });

      launchctl.loaded.add('gui');
      launchctl.loaded.add('user');
      expect(await manager().inspect()).toEqual({ state: 'active', domains: ['gui', 'user'] });
    });

    it('loadedDomain gives the one domain, none, or refuses a double load', async () => {
      launchctl.loaded.add('user');
      expect(await manager().loadedDomain()).toBe('user');
      launchctl.loaded.clear();
      expect(await manager().loadedDomain()).toBeUndefined();
      launchctl.loaded.add('gui');
      launchctl.loaded.add('user');
      await expect(manager().loadedDomain()).rejects.toThrow(DuplicateLoadError);
    });

    it('reads a loaded job that prints no state as unknown, not inactive', async () => {
      const run: CommandRunner = async () => ({ code: 0, stdout: 'no state line', stderr: '' });
      expect((await manager(run).inspect()).state).toBe('unknown');
    });
  });

  it('serviceManagerOfKind builds the launchd manager with the given uid', async () => {
    const { run, calls } = recorder({ 'launchctl print gui/777/com.azito.hub': { code: 113 } });
    await serviceManagerOfKind('launchd', HUB_SERVICE, run, { homeDir: home, uid: 777 }).restart();
    expect(calls).toEqual(['launchctl print gui/777/com.azito.hub', 'launchctl print user/777/com.azito.hub', 'launchctl kickstart -k user/777/com.azito.hub']);
  });
});
