import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandSpec, runHostOf } from '../../../shared/exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../../../shared/os/hostEnv';
import { powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { assertHubDirOnlyOwnerWritable, findHubVersionsInUse, removeFolderWithRd } from '../windowsHubFolderOps';
import { pruneHubVersions } from '../windowsHubPrune';
import { windowsPowershell } from '../windowsHubService';

/**
 * The old-version tidying (#381 U3) on a real Windows: real junctions, a real volume mount point (a VHD mounted at a folder, when the
 * machine lets the test make one), a file that a process really holds open, the real process list and the real `rd`.
 */
describe.skipIf(process.platform !== 'win32')('tidying the old versions on a real Windows', () => {
  const host = process.platform === 'win32' ? resolveCurrentHostEnv() : undefined;
  let root: string;
  let hub: string;
  let outside: string;
  let vhd: string | undefined;
  const children: ChildProcess[] = [];

  const folder = (name: string): string => {
    const dir = path.join(hub, name);
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'azito-hub.cjs'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'y');
    return dir;
  };
  const noneInUse = async (): Promise<ReadonlySet<string>> => new Set();
  const run = (spec: Parameters<typeof runCommandSpec>[0]) => runCommandSpec(spec, runHostOf(host!));
  const prune = (versionsInUse = noneInUse) => pruneHubVersions({
    hubDir: hub,
    current: 'v0.4.0',
    previous: 'v0.3.0',
    versionsInUse,
    removeIsolated: (name) => removeFolderWithRd(run, host!.systemRoot!, hub, name, fs.existsSync),
  });

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

  function diskpart(lines: string[]): { ok: boolean; output: string } {
    const script = path.join(root, `diskpart-${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(script, `${lines.join('\r\n')}\r\n`);
    const r = spawnSync(path.join(host!.systemRoot!, 'System32', 'diskpart.exe'), ['/s', script], { encoding: 'utf-8', timeout: 120_000 });
    return { ok: r.status === 0 && !/DiskPart has encountered an error|Virtual Disk Service error/i.test(r.stdout), output: `${r.stdout}${r.stderr}` };
  }

  /** A small NTFS volume (a VHD) mounted at `mountA` and again at `mountB`; or the reason it could not be made. */
  function mountVolumeTwice(mountA: string, mountB: string): string | undefined {
    vhd = path.join(root, 'prune.vhd');
    fs.mkdirSync(mountA, { recursive: true });
    fs.mkdirSync(mountB, { recursive: true });
    const made = diskpart([`create vdisk file="${vhd}" maximum=64 type=expandable`, `select vdisk file="${vhd}"`, 'attach vdisk', 'create partition primary', 'format fs=ntfs quick label=prune', `assign mount="${mountA}"`]);
    if (!made.ok) return `diskpart could not make the volume: ${made.output.replace(/\s+/g, ' ').slice(0, 400)}`;
    const guid = spawnSync(path.join(host!.systemRoot!, 'System32', 'mountvol.exe'), [mountA, '/L'], { encoding: 'utf-8' }).stdout.trim();
    if (!/^\\\\\?\\Volume\{[0-9a-fA-F-]+\}\\$/.test(guid)) return `mountvol did not give the volume name: ${guid}`;
    const second = spawnSync(path.join(host!.systemRoot!, 'System32', 'mountvol.exe'), [mountB, guid], { encoding: 'utf-8' });
    return second.status === 0 ? undefined : `mountvol could not mount the volume a second time: ${second.stdout}${second.stderr}`;
  }

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-prune-win-')));
    hub = path.join(root, 'hub');
    outside = path.join(root, 'outside');
    vhd = undefined;
    fs.mkdirSync(hub);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    if (vhd !== undefined) diskpart([`select vdisk file="${vhd}"`, 'detach vdisk']);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  it('does not follow a junction directly under hub\\ or inside a version folder: what it points at survives', async () => {
    fs.symlinkSync(outside, path.join(hub, 'v0.1.0'), 'junction');
    const old = folder('v0.2.0');
    fs.symlinkSync(outside, path.join(old, 'sub', 'junction'), 'junction');
    fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(old, 'file-link.txt'), 'file');
    fs.mkdirSync(path.join(hub, '.staging-x'));
    fs.symlinkSync(outside, path.join(hub, '.staging-x', 'junction'), 'junction');

    const report = await prune();

    expect(report.removed).toEqual(['v0.2.0']);
    expect(report.skipped.map((s) => s.name)).toEqual(['v0.1.0']);
    expect(fs.lstatSync(path.join(hub, 'v0.1.0')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(hub).sort()).toEqual(['.staging-x', 'v0.1.0']);
    expect(fs.readdirSync(outside)).toEqual(['precious.txt']);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf-8')).toBe('keep me');
    // A folder that is not named like a version is not touched at all, its junction included.
    expect(fs.lstatSync(path.join(hub, '.staging-x', 'junction')).isSymbolicLink()).toBe(true);
  });

  it('does not enter a volume mount point inside an old version: the other volume keeps its files', async () => {
    const old = folder('v0.1.0');
    const mountedInside = path.join(old, 'sub', 'mnt');
    const mountedOutside = path.join(root, 'mnt-outside');
    const reason = mountVolumeTwice(mountedInside, mountedOutside);
    if (reason !== undefined) {
      // Stated, not silent: the junction and symlink cases above still run. A machine that cannot make a VHD cannot make this case.
      console.warn(`[windowsHubPrune] no volume mount point could be made on this machine, so that case is not tested here: ${reason}`);
      return;
    }
    fs.writeFileSync(path.join(mountedOutside, 'sentinel.txt'), 'on the other volume');
    expect(fs.readFileSync(path.join(mountedInside, 'sentinel.txt'), 'utf-8')).toBe('on the other volume');

    const report = await prune();

    expect(report).toEqual({ removed: ['v0.1.0'], failed: [], skipped: [] });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(path.join(mountedOutside, 'sentinel.txt'), 'utf-8')).toBe('on the other volume');
  });

  it('keeps a version whose file a process holds open, reports it, and removes it in the next round', async () => {
    const dir = folder('v0.1.0');
    const holder = await holdFile(path.join(dir, 'sub', 'deep.txt'));
    const first = await prune();
    expect(first.removed).toEqual([]);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0].name).toBe('v0.1.0');
    expect(first.failed[0].reason).toMatch(/EBUSY|EPERM|EACCES|rd could not remove/);
    // Nothing of it was removed: the check came before the rename.
    expect(fs.readdirSync(hub)).toEqual(['v0.1.0']);
    expect(fs.existsSync(path.join(dir, 'azito-hub.cjs'))).toBe(true);

    await holder.release();
    const second = await prune();
    expect(second.failed).toEqual([]);
    expect(second.removed).toHaveLength(1);
    expect(fs.readdirSync(hub)).toEqual([]);
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
    expect(report.removed).toHaveLength(1);
    expect(report.failed).toEqual([{ name: 'v0.1.0', reason: 'a running process uses it' }]);
    expect(fs.existsSync(exe)).toBe(true);

    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect((await prune(() => findHubVersionsInUse(run, host!.systemRoot!, [hub]))).removed).toHaveLength(1);
  });

  it('removes nothing of a version whose node.exe runs although no one told the tidying (the image stays mapped after its handle is closed)', async () => {
    const dir = folder('v0.1.0');
    const exe = path.join(dir, 'node.exe');
    fs.copyFileSync(process.execPath, exe);
    const child = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });

    const report = await prune(noneInUse);

    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([{ name: 'v0.1.0', reason: expect.stringMatching(/node\.exe cannot be opened for writing.*nothing was removed/) }]);
    expect(fs.existsSync(exe)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'azito-hub.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sub', 'deep.txt'))).toBe(true);
    expect(fs.readdirSync(hub)).toEqual(['v0.1.0']);
  });

  it('finds nothing in use when no process runs from the hub folder, and does not stop on the processes of the real machine', async () => {
    folder('v0.1.0');
    expect([...await findHubVersionsInUse(run, host!.systemRoot!, [hub])]).toEqual([]);
  });

  it('accepts a hub folder only its owner can change, and refuses one that Everyone can modify', async () => {
    await expect(assertHubDirOnlyOwnerWritable(run, host!.systemRoot!, hub)).resolves.toBeUndefined();
    const granted = spawnSync(path.join(host!.systemRoot!, 'System32', 'icacls.exe'), [hub, '/grant', '*S-1-1-0:(OI)(CI)M'], { encoding: 'utf-8' });
    expect(granted.status, granted.stdout + granted.stderr).toBe(0);
    await expect(assertHubDirOnlyOwnerWritable(run, host!.systemRoot!, hub)).rejects.toThrow(/changed by others \(S-1-1-0\).*not removed/);
  });
});
