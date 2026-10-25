import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCleanupScript, buildNohupSightingScript, nohupManualSteps, parseCleanupOutcome, parseNohupSighting } from './unixAgentCleanup';

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

  it('touches nothing when there is no id file', () => {
    fakeSystemctl('inactive');
    fs.rmSync(path.join(home, '.azito', 'agent', 'install.id'));
    expect(run()).toEqual({ kind: 'not_owner', found: '' });
    expect(unit()).toBe(true);
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
