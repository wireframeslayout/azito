import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * run.ps1 -Service (scripts/run-hub.ps1, the bundle's run.ps1) starts no hub unless the process the launcher named (the task's
 * conhost.exe, by id AND start time) is still running: an End that came in between the launcher's look and this start must not leave
 * a hub that nothing follows. The bundle here has no node.exe, so a start that is NOT refused shows as a failure of cmd.exe to run it.
 */
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const RUN_HUB = path.resolve(__dirname, '..', '..', '..', 'scripts', 'run-hub.ps1');

let work: string;
let log: string;
let sleepers: ChildProcess[];

function powershell(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf-8', timeout: 90_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A process to follow and its start time as run.ps1 compares it (`StartTime.ToFileTimeUtc()`). */
async function startFollowed(): Promise<{ child: ChildProcess; pid: number; start: string }> {
  const child = spawn(POWERSHELL, ['-NoProfile', '-Command', 'Start-Sleep -Seconds 300'], { stdio: 'ignore' });
  sleepers.push(child);
  const pid = child.pid!;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const r = powershell(['-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`]);
    const text = r.out.trim();
    if (/^\d+$/.test(text)) return { child, pid, start: text };
    if (Date.now() > deadline) throw new Error(`cannot read the start time of ${pid}: ${r.out}`);
  }
}

const runService = (followPid: string, followStart: string): { status: number | null; out: string } =>
  powershell(['-File', path.join(work, 'run.ps1'), '-Service', '-LogFile', log, '-FollowPid', followPid, '-FollowStart', followStart]);
const readLog = (): string => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '');

describe.skipIf(process.platform !== 'win32')('run.ps1 -Service and the process it follows', () => {
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-runhub-'));
    log = path.join(work, 'logs', 'hub.log');
    fs.copyFileSync(RUN_HUB, path.join(work, 'run.ps1'));
    sleepers = [];
  });

  afterEach(async () => {
    for (const child of sleepers) {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      }
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it('refuses to be started without the process to follow', () => {
    const r = powershell(['-File', path.join(work, 'run.ps1'), '-Service', '-LogFile', log]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/-FollowPid/);
  });

  it('starts no hub when the process it was told to follow is gone (an End came in), and ends without a failure so the launcher does not retry', async () => {
    const followed = await startFollowed();
    followed.child.kill();
    await new Promise<void>((resolve) => { if (followed.child.exitCode !== null || followed.child.signalCode !== null) resolve(); else followed.child.once('exit', () => resolve()); });
    const r = runService(String(followed.pid), followed.start);
    expect(r.status, r.out).toBe(0);
    expect(readLog()).toMatch(/the process to follow \(\d+\) is gone, so the hub is not started/);
  }, 120_000);

  it('starts no hub for a process id that now belongs to another process (the start time differs)', async () => {
    const followed = await startFollowed();
    const r = runService(String(followed.pid), String(BigInt(followed.start) + 10_000_000n));
    expect(r.status, r.out).toBe(0);
    expect(readLog()).toMatch(/is gone, so the hub is not started/);
  }, 120_000);

  it('goes on to start the hub while the process it follows is the one it was told (here node.exe is missing, which only cmd.exe reports)', async () => {
    const followed = await startFollowed();
    const r = runService(String(followed.pid), followed.start);
    expect(readLog()).not.toMatch(/is gone/);
    expect(r.status, r.out).not.toBe(0);
  }, 120_000);
});
