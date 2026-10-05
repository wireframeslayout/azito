import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchdMisaoController, SystemdMisaoController, type CommandResult, type CommandRunner } from './MisaoServiceController';
import { buildServicePath, hasMisaoToRelyOn, resolveInstallPrefix, resolveMisaoPaths } from './misaoPaths';
import { readEnvValue, upsertEnvValue } from '../../../shared/envFile';

function recorder(results: Record<string, Partial<CommandResult>> = {}): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = async (file, args) => {
    const line = `${file} ${args.join(' ')}`;
    calls.push(line);
    return { code: 0, stdout: '', stderr: '', ...results[line] };
  };
  return { run, calls };
}

describe('SystemdMisaoController', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('installs the unit, reloads and enables it, and does not start it', async () => {
    const { run, calls } = recorder();
    const controller = new SystemdMisaoController(run, home);
    expect(controller.isInstalled()).toBe(false);

    await controller.install('[Unit]\n');

    expect(fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'azito-misao.service'), 'utf-8')).toBe('[Unit]\n');
    expect(controller.isInstalled()).toBe(true);
    expect(calls.slice(0, 2)).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable azito-misao']);
    expect(calls.some((c) => c.includes('start'))).toBe(false);
  });

  it('reports a failing systemctl with its output instead of carrying on', async () => {
    const { run } = recorder({ 'systemctl --user start azito-misao': { code: 1, stderr: 'Unit not found.' } });
    await expect(new SystemdMisaoController(run, home).start()).rejects.toThrow(/systemctl start failed \(exit 1\): Unit not found\./);
  });

  it.each([['active\n', 'active'], ['failed\n', 'failed'], ['inactive\n', 'inactive'], ['weird\n', 'unknown']])('maps is-active output %j to %s', async (stdout, expected) => {
    const { run } = recorder({ 'systemctl --user is-active azito-misao': { code: 3, stdout } });
    expect(await new SystemdMisaoController(run, home).state()).toBe(expected);
  });
});

describe('LaunchdMisaoController', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const target = 'gui/501/com.azito.misao';

  it('writes the plist and starts nothing on install', async () => {
    const { run, calls } = recorder();
    const controller = new LaunchdMisaoController(run, home, 501);
    await controller.install('<plist/>');
    expect(fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.azito.misao.plist'), 'utf-8')).toBe('<plist/>');
    expect(calls).toEqual([]);
  });

  it('bootstraps an unloaded job (re-reading the plist) and only kickstarts a loaded one', async () => {
    const unloaded = recorder({ [`launchctl print ${target}`]: { code: 113 } });
    await new LaunchdMisaoController(unloaded.run, home, 501).start();
    expect(unloaded.calls).toEqual([`launchctl print ${target}`, `launchctl bootstrap gui/501 ${path.join(home, 'Library', 'LaunchAgents', 'com.azito.misao.plist')}`]);

    const loaded = recorder();
    await new LaunchdMisaoController(loaded.run, home, 501).start();
    expect(loaded.calls).toEqual([`launchctl print ${target}`, `launchctl kickstart ${target}`]);
  });

  it('boots out a loaded job on stop and does nothing for an unloaded one', async () => {
    const loaded = recorder();
    await new LaunchdMisaoController(loaded.run, home, 501).stop();
    expect(loaded.calls).toEqual([`launchctl print ${target}`, `launchctl bootout ${target}`]);

    const unloaded = recorder({ [`launchctl print ${target}`]: { code: 113 } });
    await new LaunchdMisaoController(unloaded.run, home, 501).stop();
    expect(unloaded.calls).toEqual([`launchctl print ${target}`]);
  });

  it('reads the job state from launchctl print', async () => {
    const running = recorder({ [`launchctl print ${target}`]: { stdout: `${target} = {\n\tstate = running\n}` } });
    expect(await new LaunchdMisaoController(running.run, home, 501).state()).toBe('active');
    const waiting = recorder({ [`launchctl print ${target}`]: { stdout: '\tstate = waiting\n' } });
    expect(await new LaunchdMisaoController(waiting.run, home, 501).state()).toBe('inactive');
    const absent = recorder({ [`launchctl print ${target}`]: { code: 113 } });
    expect(await new LaunchdMisaoController(absent.run, home, 501).state()).toBe('inactive');
  });
});

describe('misaoPaths', () => {
  it('keeps the misao directory beside hub/, not inside it, so a hub update cannot touch it', () => {
    const paths = resolveMisaoPaths('/home/u/.azito');
    expect(paths).toMatchObject({ root: '/home/u/.azito/misao', current: '/home/u/.azito/misao/current', socket: '/home/u/.azito/misao/misao.sock', hubEnvFile: '/home/u/.azito/hub/.env' });
  });

  it('rejects a prefix whose socket path would exceed the unix socket limit', () => {
    expect(() => resolveMisaoPaths(`/${'a'.repeat(100)}`)).toThrow(/107-byte limit/);
  });

  it.each(['/home/my user/.azito', '/home/u/50%/.azito', '/home/u/a&b', '/home/u/<x>', '/home/u/it\'s', '/home/u/"q"', '/home/u/a\\b', '/home/u/$HOME'])('rejects the prefix %s (it would be re-interpreted in the unit / plist)', (prefix) => {
    expect(() => resolveMisaoPaths(prefix)).toThrow(/must not contain/);
  });

  it('rejects a relative prefix', () => {
    expect(() => resolveMisaoPaths('azito')).toThrow(/absolute/);
  });

  it('derives the prefix from where the hub bundle lives (AZITO_PREFIX is the harness prefix, not the install location)', () => {
    expect(resolveInstallPrefix('/home/u/.azito/hub/current')).toBe('/home/u/.azito');
    expect(resolveInstallPrefix('/home/u/.azito/hub/v0.11.0')).toBe('/home/u/.azito');
    expect(resolveInstallPrefix('/repo/packages/server')).toBeNull();
    expect(resolveInstallPrefix(null)).toBeNull();
  });

  it('builds a PATH with the existing tool locations first, without duplicates', () => {
    const result = buildServicePath({ PATH: '/usr/bin:/opt/x/bin' }, '/home/u', (dir) => dir === '/home/u/.local/bin' || dir === '/usr/local/bin');
    expect(result).toBe('/home/u/.local/bin:/usr/local/bin:/usr/bin:/opt/x/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('hasMisaoToRelyOn', () => {
  const none = (): boolean => false;
  it('is false with neither a service definition nor MISAO_SOCKET, so a fresh install without misao starts on tmux', () => {
    expect(hasMisaoToRelyOn({}, '/home/u', none)).toBe(false);
  });
  it('is true once MISAO_SOCKET is set or either service definition exists', () => {
    expect(hasMisaoToRelyOn({ MISAO_SOCKET: '/s' }, '/home/u', none)).toBe(true);
    expect(hasMisaoToRelyOn({}, '/home/u', (f) => f === '/home/u/.config/systemd/user/azito-misao.service')).toBe(true);
    expect(hasMisaoToRelyOn({}, '/home/u', (f) => f === '/home/u/Library/LaunchAgents/com.azito.misao.plist')).toBe(true);
  });
});

describe('upsertEnvValue', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aze-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('tightens an existing file that was more permissive to mode 600', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'A=1\n', { mode: 0o644 });
    upsertEnvValue(file, 'MISAO_SOCKET', '/s');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('creates a missing file with mode 600', () => {
    const file = path.join(dir, 'hub', '.env');
    upsertEnvValue(file, 'MISAO_SOCKET', '/s');
    expect(fs.readFileSync(file, 'utf-8')).toBe('MISAO_SOCKET=/s\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('replaces an existing assignment in place and appends otherwise, keeping other lines and comments', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '# c\nA=1\nMISAO_SOCKET=/old\nB=2\n');
    upsertEnvValue(file, 'MISAO_SOCKET', '/new');
    expect(fs.readFileSync(file, 'utf-8')).toBe('# c\nA=1\nMISAO_SOCKET=/new\nB=2\n');

    upsertEnvValue(file, 'C', '3');
    expect(fs.readFileSync(file, 'utf-8')).toBe('# c\nA=1\nMISAO_SOCKET=/new\nB=2\nC=3\n');
    expect(readEnvValue(file, 'C')).toBe('3');
  });
});
