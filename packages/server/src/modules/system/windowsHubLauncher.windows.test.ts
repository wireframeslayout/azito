import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { powershellEncodedArgs } from '../../shared/os/shellDialect';
import { buildHubLauncherScript, hubWindowsLayout, type HubRestartTiming, type HubWindowsLayout } from './windowsHubService';
import { readHubLauncherState } from './hubLauncherState';

/**
 * The launcher itself, on Windows PowerShell 5.1: a fake `run.ps1` ends with the exit codes the test scripts, and the real launcher
 * script (the very text the task runs, with short waits) decides what happens next. The prefix has spaces, parentheses and an
 * apostrophe, so the paths the script derives from `$hubRoot` are checked against the layout's.
 */
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const FAST: HubRestartTiming = { baseSeconds: 1, maxSeconds: 2, stableSeconds: 300 };

let work: string;
let layout: HubWindowsLayout;
let counter: string;
/** Every launcher this file started and has not seen end: ended in afterEach whatever the test did, before the folder it uses is removed. */
let children: ChildProcess[];
let strayPids: number[];

function installFakeRun(exitCodes: number[]): void {
  const dir = path.join(layout.hubRoot, 'v0.0.1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(layout.pointer, 'v0.0.1\r\n');
  fs.writeFileSync(path.join(dir, 'run.ps1'), [
    'param([switch]$Service, [string]$LogFile = \'\')',
    `$counter = '${counter.replace(/'/g, "''")}'`,
    '$n = 0; if (Test-Path -LiteralPath $counter) { $n = [int](Get-Content -LiteralPath $counter) }',
    '$n++; Set-Content -LiteralPath $counter -Value $n',
    `$codes = @(${exitCodes.join(', ')})`,
    'exit $codes[[Math]::Min($n - 1, $codes.Count - 1)]',
  ].join('\r\n'));
}

const runs = (): number => (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf-8').trim()) : 0);
const hubLog = (): string => (fs.existsSync(layout.logFile) ? fs.readFileSync(layout.logFile, 'utf-8') : '');
const launcher = (timing: HubRestartTiming = FAST): string[] => powershellEncodedArgs(buildHubLauncherScript(layout, timing));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => spawnSync(POWERSHELL, ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' }`], { encoding: 'utf-8' }).stdout.trim() === 'yes';

describe.skipIf(process.platform !== 'win32')('the hub launcher (Windows PowerShell 5.1)', () => {
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-launcher-'));
    layout = hubWindowsLayout(path.join(work, 'Foo Bar (Work)', "O'Neil", '.azito'));
    counter = path.join(work, 'runs.count');
    children = [];
    strayPids = [];
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        await Promise.race([ended, sleep(15_000)]);
      }
    }
    if (strayPids.length > 0) {
      spawnSync(POWERSHELL, ['-NoProfile', '-Command', `Stop-Process -Id ${strayPids.join(',')} -Force -ErrorAction SilentlyContinue`], { encoding: 'utf-8' });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && strayPids.some(alive)) await sleep(250);
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it('starts run.ps1 again after a non-zero exit, waiting base then double, and stops for good at exit code 0', () => {
    installFakeRun([3, 4, 0]);
    const started = Date.now();
    const r = spawnSync(POWERSHELL, launcher(), { encoding: 'utf-8', timeout: 90_000 });
    expect(r.status, `${r.stdout}${r.stderr}\n${hubLog()}`).toBe(0);
    expect(runs()).toBe(3);
    const log = hubLog();
    expect(log).toMatch(/run\.ps1 \(v0\.0\.1\) exited with code 3/);
    expect(log).toMatch(/run\.ps1 \(v0\.0\.1\) exited with code 4/);
    expect(log).toMatch(/start 2 in 1s/);
    expect(log).toMatch(/start 3 in 2s/);
    expect(log).toMatch(/exited with code 0: done/);
    // 1 s + 2 s of waiting at least.
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    const state = readHubLauncherState(layout.launcherState);
    expect(state).toMatchObject({ restarts: 2, lastExitCode: 4, nextWaitSeconds: 2 });
  }, 120_000);

  it('does not start the hub at all again when the first run exits with 0', () => {
    installFakeRun([0]);
    const r = spawnSync(POWERSHELL, launcher(), { encoding: 'utf-8', timeout: 60_000 });
    expect(r.status, `${r.stdout}${r.stderr}\n${hubLog()}`).toBe(0);
    expect(runs()).toBe(1);
    expect(readHubLauncherState(layout.launcherState)).toMatchObject({ restarts: 0, lastExitCode: null });
  }, 90_000);

  it('logs a pointer that is wrong, waits the longest time and tries again (and starts once the pointer is right)', async () => {
    installFakeRun([0]);
    fs.writeFileSync(layout.pointer, 'not-a-version\r\n');
    const child = spawn(POWERSHELL, launcher(), { stdio: 'ignore' });
    children.push(child);
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (hubLog().match(/is not a version/g) ?? []).length < 2) await sleep(250);
    expect((hubLog().match(/is not a version/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(runs()).toBe(0);
    expect(hubLog()).toMatch(/start \d+ in 2s/);
    // The pointer is read again at every start: fixing it is enough.
    fs.writeFileSync(layout.pointer, 'v0.0.1\r\n');
    expect(await exited).toBe(0);
    expect(runs()).toBe(1);
  }, 90_000);

  it('ends instead of starting the hub again once the process it runs under is gone (a /End that left the launcher behind)', async () => {
    installFakeRun([1]);
    const args = launcher();
    // The "conhost.exe": starts the launcher as its child, lives a few seconds, and ends.
    const parentScript = [
      '$b = Start-Process -FilePath $env:LAUNCHER_POWERSHELL -ArgumentList (ConvertFrom-Json $env:LAUNCHER_ARGS) -PassThru -WindowStyle Hidden',
      '$b.Id',
      'Start-Sleep -Seconds 8',
    ].join('\n');
    const parent = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', parentScript], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, LAUNCHER_POWERSHELL: POWERSHELL, LAUNCHER_ARGS: JSON.stringify(args) },
    });
    const pid = Number(parent.stdout.trim().split(/\r?\n/)[0]);
    if (pid > 0) strayPids.push(pid);
    expect(pid, `${parent.stdout}${parent.stderr}`).toBeGreaterThan(0);
    const runsAtEnd = runs();
    expect(runsAtEnd).toBeGreaterThanOrEqual(2); // it did keep starting the hub while its parent lived
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && alive(pid)) await sleep(500);
    expect(alive(pid), hubLog()).toBe(false);
    expect(hubLog()).toMatch(/task ended: not restarting/);
    expect(runs()).toBeLessThanOrEqual(runsAtEnd + 1);
  }, 120_000);
});
