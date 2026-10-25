import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandSpec, runHostOf } from '../../../shared/exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../../../shared/os/hostEnv';
import { powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { findHubVersionsInUse, pruneHubVersions } from '../windowsHubPrune';
import { windowsPowershell } from '../windowsHubService';

/**
 * The old-version tidying (#381 U3) on a real Windows: real junctions, a file that a process really holds open, and the process list of the
 * real WMI. Nothing here is skipped on Windows; elsewhere the cases that need no Windows are in windowsHubPrune.test.ts.
 */
describe.skipIf(process.platform !== 'win32')('tidying the old versions on a real Windows', () => {
  const host = process.platform === 'win32' ? resolveCurrentHostEnv() : undefined;
  let root: string;
  let hub: string;
  let outside: string;
  const children: ChildProcess[] = [];

  const folder = (name: string): string => {
    const dir = path.join(hub, name);
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'azito-hub.cjs'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'y');
    return dir;
  };
  const noneInUse = async (): Promise<ReadonlySet<string>> => new Set();
  const prune = (versionsInUse = noneInUse) => pruneHubVersions({ hubDir: hub, current: 'v0.4.0', previous: 'v0.3.0', versionsInUse });
  const run = (spec: Parameters<typeof runCommandSpec>[0]) => runCommandSpec(spec, runHostOf(host!));

  /** A PowerShell process that holds `file` open WITHOUT sharing delete (the way an antivirus scan or a running tool does), until told to let go. */
  async function holdFile(file: string): Promise<{ release(): Promise<void> }> {
    const script = [
      `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read')`,
      "[Console]::Out.WriteLine('held'); [Console]::Out.Flush()",
      '[Console]::In.ReadLine() | Out-Null',
      '$f.Close()',
    ].join('\n');
    const child = spawn(windowsPowershell(host!.systemRoot!), powershellEncodedArgs(script), { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      let out = '';
      child.stdout!.on('data', (d: Buffer) => { out += d.toString(); if (out.includes('held')) resolve(); });
      child.once('exit', () => reject(new Error(`the holder ended before it held the file: ${out}`)));
    });
    return { release: async () => { child.stdin!.write('\n'); await exited; } };
  }

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-prune-win-')));
    hub = path.join(root, 'hub');
    outside = path.join(root, 'outside');
    fs.mkdirSync(hub);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  it('does not follow a junction directly under hub\\ or inside a version folder: what it points at survives', async () => {
    fs.symlinkSync(outside, path.join(hub, 'v0.1.0'), 'junction');
    const old = folder('v0.2.0');
    fs.symlinkSync(outside, path.join(old, 'sub', 'junction'), 'junction');
    fs.mkdirSync(path.join(hub, '.staging-x'));
    fs.symlinkSync(outside, path.join(hub, '.staging-x', 'junction'), 'junction');

    const report = await prune();

    expect(report.removed).toEqual(['v0.2.0']);
    expect(report.skipped.map((s) => s.name)).toEqual(['v0.1.0']);
    expect(fs.lstatSync(path.join(hub, 'v0.1.0')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readdirSync(outside)).toEqual(['precious.txt']);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf-8')).toBe('keep me');
    // A folder that is not named like a version is not touched at all, its junction included.
    expect(fs.lstatSync(path.join(hub, '.staging-x', 'junction')).isSymbolicLink()).toBe(true);
  });

  it('keeps a version whose file a process holds open, reports it with the reason, and removes it in the next round', async () => {
    const dir = folder('v0.1.0');
    const holder = await holdFile(path.join(dir, 'sub', 'deep.txt'));
    const first = await prune();
    expect(first.removed).toEqual([]);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0].name).toBe('v0.1.0');
    expect(first.failed[0].reason).toMatch(/EBUSY|EPERM|EACCES/);
    expect(fs.existsSync(path.join(dir, 'sub', 'deep.txt'))).toBe(true);

    await holder.release();
    const second = await prune();
    expect(second).toEqual({ removed: ['v0.1.0'], failed: [], skipped: [] });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('finds the version a running node.exe of that folder uses, by the real process list, and keeps it', async () => {
    const dir = folder('v0.1.0');
    folder('v0.2.0');
    const exe = path.join(dir, 'node.exe');
    fs.copyFileSync(process.execPath, exe);
    const child = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });

    const found = await findHubVersionsInUse(run, host!.systemRoot!, [hub]);
    expect([...found]).toEqual(['v0.1.0']);

    const report = await prune(() => findHubVersionsInUse(run, host!.systemRoot!, [hub]));
    expect(report.removed).toEqual(['v0.2.0']);
    expect(report.failed).toEqual([{ name: 'v0.1.0', reason: 'a running process uses it' }]);
    expect(fs.existsSync(exe)).toBe(true);

    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect((await prune(() => findHubVersionsInUse(run, host!.systemRoot!, [hub]))).removed).toEqual(['v0.1.0']);
  });

  it('finds nothing in use when no process runs from the hub folder', async () => {
    folder('v0.1.0');
    expect([...await findHubVersionsInUse(run, host!.systemRoot!, [hub])]).toEqual([]);
  });
});
