import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launchctl = vi.hoisted(() => ({ calls: [] as string[], results: {} as Record<string, number> }));

vi.mock('../modules/system/serviceManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/system/serviceManager')>();
  return {
    ...actual,
    runCommand: async (file: string, args: string[]) => {
      const line = `${file} ${args.join(' ')}`;
      launchctl.calls.push(line);
      return { code: launchctl.results[line] ?? 0, stdout: '\tstate = running\n', stderr: '' };
    },
  };
});

import { serviceCommand, type ServiceCommandContext } from './serviceCommand';
import type { ServiceHost } from '../modules/system/createServiceManager';
import { UnixSecretFileGuard } from '../shared/os/secretFileGuard';

describe('azito service', () => {
  let home: string;
  let out: string[];
  let err: string[];
  const uid = os.userInfo().uid;
  const hostOf = (platform: 'darwin' | 'linux'): ServiceHost => ({ platform, homeDir: home, uid, tmpDir: os.tmpdir(), systemRoot: undefined });
  const context: ServiceCommandContext = { env: {}, bundleRoot: '/opt/azito/hub/v0.0.0', pid: 1, secretFileGuard: new UnixSecretFileGuard() };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'azsc-'));
    launchctl.calls = [];
    launchctl.results = {};
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const plistPath = (): string => path.join(home, 'Library', 'LaunchAgents', 'com.azito.hub.plist');
  const installPlist = (): void => {
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), '<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.azito.hub</string>\n</dict>\n</plist>\n');
  };

  it('prints the usage for an unknown command', async () => {
    await serviceCommand(['bogus'], hostOf('darwin'), context);
    expect(out.join('\n')).toContain('Usage: azito service');
    expect(process.exitCode).toBe(1);
  });

  it('says the service is not installed, and refuses to start it', async () => {
    await serviceCommand(['status'], hostOf('darwin'), context);
    expect(out.join('\n')).toContain('not installed');
    expect(process.exitCode).toBeUndefined();

    await serviceCommand(['start'], hostOf('darwin'), context);
    expect(err.join('\n')).toContain('not installed');
    expect(process.exitCode).toBe(1);
  });

  it('shows the launchd domain the hub is loaded into in status', async () => {
    installPlist();
    launchctl.results[`launchctl print gui/${uid}/com.azito.hub`] = 113;
    await serviceCommand(['status'], hostOf('darwin'), context);
    expect(out).toEqual(['service:   launchd (active)', 'domain:    user']);
  });

  it('reload bootstraps the job into user/<uid>, and fails with the launchctl error', async () => {
    installPlist();
    launchctl.results[`launchctl print gui/${uid}/com.azito.hub`] = 113;
    launchctl.results[`launchctl print user/${uid}/com.azito.hub`] = 113;
    await serviceCommand(['reload'], hostOf('darwin'), context);
    expect(launchctl.calls.filter((c) => /bootstrap|bootout/.test(c))).toEqual([`launchctl bootstrap user/${uid} ${plistPath()}`]);
    expect(process.exitCode).toBeUndefined();

    launchctl.results[`launchctl bootstrap user/${uid} ${plistPath()}`] = 37;
    await serviceCommand(['reload'], hostOf('darwin'), context);
    expect(err.join('\n')).toMatch(/launchctl bootstrap user\/-?\d+ failed \(exit 37\)/);
    expect(process.exitCode).toBe(1);
  });

  it('warns in status about a job loaded into both domains, and start / reload refuse it with the way out', async () => {
    installPlist();
    await serviceCommand(['status'], hostOf('darwin'), context);
    expect(out).toEqual(['service:   launchd (active)', 'domain:    gui + user', expect.stringContaining('two copies')]);
    expect(process.exitCode).toBeUndefined();

    for (const command of ['start', 'reload']) {
      launchctl.calls = [];
      process.exitCode = undefined;
      await serviceCommand([command], hostOf('darwin'), context);
      expect(err.join('\n')).toMatch(/both gui\/-?\d+ and user\/-?\d+.*azito service stop/);
      expect(process.exitCode).toBe(1);
      expect(launchctl.calls.some((c) => /bootstrap|bootout|kickstart/.test(c))).toBe(false);
    }
  });

  it('on Linux, reload runs daemon-reload before the restart so a changed unit is read', async () => {
    const unit = path.join(home, '.config', 'systemd', 'user', 'azito.service');
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Unit]\n');
    await serviceCommand(['reload'], hostOf('linux'), context);
    expect(launchctl.calls.filter((c) => !c.includes('is-active'))).toEqual(['systemctl --user daemon-reload', 'systemctl --user restart azito']);
    expect(process.exitCode).toBeUndefined();
  });

  it('on Windows, a source checkout has no service to operate: it says so instead of guessing a prefix', async () => {
    await serviceCommand(['status'], { platform: 'win32', homeDir: home, uid: -1, tmpDir: home, systemRoot: 'C:\\Windows' }, { ...context, bundleRoot: null });
    expect(err.join('\n')).toContain('not a release install');
    expect(process.exitCode).toBe(1);
  });

  it('install is for Windows: on Linux it points at install.sh and registers nothing', async () => {
    await serviceCommand(['install'], hostOf('linux'), context);
    expect(err.join('\n')).toContain('install.sh');
    expect(process.exitCode).toBe(1);
    expect(launchctl.calls.filter((c) => !c.includes('is-active'))).toEqual([]);
  });
});
