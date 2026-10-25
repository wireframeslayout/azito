import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCleanupGuardScript, buildCleanupScript, buildNohupSightingScript, nohupManualSteps, parseCleanupOutcome, parseNohupSighting } from './unixAgentCleanup';

// The script is run for real, with `sh -e` (the strictest a login shell can be), in a temporary HOME, against a `systemctl` that answers
// like the real one: `is-active` prints the state and exits 3 for anything but active.
describe.skipIf(process.platform === 'win32')('systemd agent cleanup script', () => {
  let home: string;
  let bin: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-cleanup-'));
    bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(home, '.azito', 'agent'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'systemd', 'user'), { recursive: true });
    fs.writeFileSync(path.join(home, '.azito', 'agent', 'install.id'), 'abc123');
    fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'azito-agent.service'), '[Unit]\n');
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  /** A systemctl whose `stop` exits `stopCode` and whose `is-active` prints `state` (exit 0 for active, 3 otherwise). */
  const fakeSystemctl = (state: string, stopCode = 0): void => {
    const file = path.join(bin, 'systemctl');
    fs.writeFileSync(file, [
      '#!/bin/sh',
      'shift # --user',
      'case "$1" in',
      `  stop) exit ${stopCode};;`,
      `  is-active) echo ${state}; [ "${state}" = active ] && exit 0; exit 3;;`,
      '  *) exit 0;;',
      'esac',
    ].join('\n'));
    fs.chmodSync(file, 0o755);
  };
  const run = (installId = 'abc123') => {
    const out = spawnSync('sh', ['-e', '-c', buildCleanupScript(installId)], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home }, encoding: 'utf8' });
    return parseCleanupOutcome(out.stdout);
  };
  const folder = (): boolean => fs.existsSync(path.join(home, '.azito', 'agent'));
  const unit = (): boolean => fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'azito-agent.service'));

  it('removes the unit file and the folder when the unit is inactive (is-active exits 3, which sh -e must not mistake for a failure)', () => {
    fakeSystemctl('inactive');
    expect(run()).toEqual({ kind: 'removed' });
    expect(folder()).toBe(false);
    expect(unit()).toBe(false);
  });

  it('treats a failed unit as stopped', () => {
    fakeSystemctl('failed');
    expect(run()).toEqual({ kind: 'removed' });
  });

  it.each(['active', 'activating', 'deactivating'])('keeps everything when the unit is still %s', (state) => {
    fakeSystemctl(state);
    expect(run()).toEqual({ kind: 'not_stopped', reason: `the unit is still ${state} after it was stopped` });
    expect(folder()).toBe(true);
    expect(unit()).toBe(true);
  });

  it('keeps everything when the stop itself fails', () => {
    fakeSystemctl('inactive', 1);
    expect(run()).toMatchObject({ kind: 'not_stopped' });
    expect(folder()).toBe(true);
  });

  it('touches nothing when the folder holds another install\'s id', () => {
    fakeSystemctl('inactive');
    expect(run('mine')).toEqual({ kind: 'not_owner', found: 'abc123' });
    expect(folder()).toBe(true);
    expect(unit()).toBe(true);
  });

  const lockDir = (): string => path.join(home, '.azito', 'agent-cleanup.lock');

  it('holds the mark while it runs and removes it when it ends, however it ends', () => {
    // The fake systemctl reports whether the mark exists (and its pid) while the script is between its check and its removal.
    const file = path.join(bin, 'systemctl');
    fs.writeFileSync(file, [
      '#!/bin/sh',
      'shift',
      `case "$1" in stop) cp -R "${lockDir()}/pid" "${home}/pid-seen" 2>/dev/null; exit 0;; is-active) echo inactive; exit 3;; *) exit 0;; esac`,
    ].join('\n'));
    fs.chmodSync(file, 0o755);
    expect(run()).toEqual({ kind: 'removed' });
    expect(fs.existsSync(path.join(home, 'pid-seen'))).toBe(true);
    expect(fs.readFileSync(path.join(home, 'pid-seen'), 'utf8').trim()).toMatch(/^\d+$/);
    expect(fs.existsSync(lockDir())).toBe(false);
    // An ending that is not a success removes it as well.
    fs.mkdirSync(path.join(home, '.azito', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.azito', 'agent', 'install.id'), 'abc123');
    fakeSystemctl('active');
    expect(run()).toMatchObject({ kind: 'not_stopped' });
    expect(fs.existsSync(lockDir())).toBe(false);
    expect(run('mine')).toMatchObject({ kind: 'not_owner' });
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it('removes the mark when the script is terminated', async () => {
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nsleep 30\n');
    fs.chmodSync(path.join(bin, 'systemctl'), 0o755);
    const child = spawn('sh', ['-e', '-c', buildCleanupScript('abc123')], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home }, stdio: 'ignore', detached: true });
    for (let i = 0; i < 50 && !fs.existsSync(lockDir()); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(lockDir())).toBe(true);
    // As a dropped SSH session ends it: the signal reaches the whole group (sh waits for its foreground child, then runs its trap).
    process.kill(-child.pid!, 'SIGTERM');
    await new Promise((r) => child.once('exit', r));
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it('does nothing, and says BUSY, when another cleanup holds the mark (a live pid) or the mark cannot be made', () => {
    fakeSystemctl('inactive');
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'pid'), String(process.pid));
    expect(run()).toEqual({ kind: 'busy' });
    expect(folder()).toBe(true);
    expect(unit()).toBe(true);
    expect(fs.existsSync(lockDir())).toBe(true);
    fs.rmSync(lockDir(), { recursive: true });
    fs.writeFileSync(lockDir(), 'a file where the mark should be made');
    expect(run()).toEqual({ kind: 'busy' });
    expect(folder()).toBe(true);
  });

  it('touches nothing when there is no id file', () => {
    fakeSystemctl('inactive');
    fs.rmSync(path.join(home, '.azito', 'agent', 'install.id'));
    expect(run()).toEqual({ kind: 'not_owner', found: '' });
    expect(unit()).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('the guard an install, update or recovery runs first', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-guard-')); fs.mkdirSync(path.join(home, '.azito'), { recursive: true }); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const lock = (): string => path.join(home, '.azito', 'agent-cleanup.lock');
  const guard = (then?: string): string => spawnSync('sh', ['-e', '-c', buildCleanupGuardScript(then)], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' }).stdout.trim();

  it('says idle when there is no mark', () => {
    expect(guard()).toBe('AZITO_CLEANUP_IDLE');
    expect(guard('echo AFTER')).toBe('AFTER');
  });

  it('stops while the pid in the mark is alive, and leaves the mark', () => {
    fs.mkdirSync(lock());
    fs.writeFileSync(path.join(lock(), 'pid'), String(process.pid));
    expect(guard()).toBe(`AZITO_CLEANUP_MARK:${process.pid}:alive`);
    expect(guard('echo AFTER')).toBe(`AZITO_CLEANUP_MARK:${process.pid}:alive`);
    expect(fs.existsSync(lock())).toBe(true);
  });

  it('stops, and does not remove the mark, when its pid is dead (a person looks and removes it)', () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    fs.mkdirSync(lock());
    fs.writeFileSync(path.join(lock(), 'pid'), String(dead));
    expect(guard('echo AFTER')).toBe(`AZITO_CLEANUP_MARK:${dead}:ended`);
    expect(guard()).toBe(`AZITO_CLEANUP_MARK:${dead}:ended`);
    expect(fs.existsSync(lock())).toBe(true);
  });

  it('stops, on the safe side, for a mark that has no pid yet', () => {
    fs.mkdirSync(lock());
    expect(guard()).toBe('AZITO_CLEANUP_MARK:none:unknown');
    expect(fs.existsSync(lock())).toBe(true);
  });
});

describe('nohup agent: reported, not stopped', () => {
  it('reads the pid and the start time the host prints', () => {
    expect(parseNohupSighting('4242|Sat Oct 25 11:00:00 2026\n')).toEqual({ pid: '4242', startedAt: 'Sat Oct 25 11:00:00 2026' });
    expect(parseNohupSighting('')).toBeUndefined();
  });

  it('gives the steps to stop it by hand, with what was seen', () => {
    const text = nohupManualSteps({ pid: '4242', startedAt: 'Sat Oct 25 11:00:00 2026' });
    expect(text).toContain('the pid was 4242');
    expect(text).toContain('started at "Sat Oct 25 11:00:00 2026"');
    expect(text).toContain('$HOME/.azito/agent/current/azito-agent.cjs as an argument');
    expect(text).toContain('kill <pid>');
    expect(text).toContain('rm -rf ~/.azito/agent');
  });

  it.skipIf(process.platform === 'win32')('the sighting script prints "pid|start" for the process the pid file names', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-sight-'));
    try {
      fs.mkdirSync(path.join(home, '.azito', 'agent'), { recursive: true });
      const child = spawn('sleep', ['5'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(home, '.azito', 'agent', 'agent.pid'), String(child.pid));
      const out = spawnSync('sh', ['-c', buildNohupSightingScript()], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
      expect(parseNohupSighting(out.stdout)?.pid).toBe(String(child.pid));
      child.kill();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
