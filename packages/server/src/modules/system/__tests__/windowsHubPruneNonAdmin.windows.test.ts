import { spawn, spawnSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandSpec } from '../../../shared/exec/commandSpec';
import { runCommandSpec, runHostOf } from '../../../shared/exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../../../shared/os/hostEnv';
import { powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { findHubVersionsInUse, removeFolderWithRd } from '../windowsHubFolderOps';
import { pruneHubVersions } from '../windowsHubPrune';
import { windowsPowershell, type SpecRunner } from '../windowsHubService';

/**
 * The in-use look-up of the old-version tidying (#381 U3b) as an account that is NOT an administrator. A runner is an administrator and can
 * read the path of every process, so the test makes a local standard user and runs the look-up as that user: smss / csrss / svchost and the
 * runner's own processes are then unreadable, which is what a person on an ordinary Windows 11 has, and the tidying must still run.
 */
const USER = 'azitoprune';

describe.skipIf(process.platform !== 'win32')('tidying the old versions as a user who is not an administrator', () => {
  const host = process.platform === 'win32' ? resolveCurrentHostEnv() : undefined;
  const password = `Az1-${crypto.randomBytes(12).toString('hex')}`;
  const system32 = host ? path.join(host.systemRoot!, 'System32') : '';
  let root: string;
  let hub: string;
  let userExists = false;
  let setupProblem: string | undefined;
  const children: ChildProcess[] = [];

  const net = (...args: string[]) => spawnSync(path.join(system32, 'net.exe'), args, { encoding: 'utf-8' });

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-prune-na-')));
    hub = path.join(root, 'hub');
    fs.mkdirSync(hub);
    // The user reads the helper's output files and the (Everyone-readable) temp folder; only `out\` is written by it.
    fs.mkdirSync(path.join(root, 'out'));
    spawnSync(path.join(system32, 'icacls.exe'), [path.join(root, 'out'), '/grant', '*S-1-1-0:(OI)(CI)M'], { encoding: 'utf-8' });
    net('user', USER, '/delete');
    const added = net('user', USER, password, '/add', '/y');
    if (added.status !== 0) { setupProblem = `net user could not make ${USER}: ${added.stdout}${added.stderr}`; return; }
    userExists = true;
  });

  afterAll(() => {
    for (const child of children.splice(0)) child.kill();
    if (userExists) net('user', USER, '/delete');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  /** Runs a spec as the standard user (PowerShell `Start-Process -Credential`, output through files the user can write). */
  const runAsUser: SpecRunner = async (spec: CommandSpec) => {
    const tag = crypto.randomBytes(4).toString('hex');
    const out = path.join(root, 'out', `${tag}.out`);
    const err = path.join(root, 'out', `${tag}.err`);
    const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    const script = [
      `$cred = New-Object Management.Automation.PSCredential(".\\${USER}", (ConvertTo-SecureString ${q(password)} -AsPlainText -Force))`,
      `$p = Start-Process -FilePath ${q(spec.file)} -ArgumentList ${q(spec.args.join(' '))} -Credential $cred -LoadUserProfile -WorkingDirectory ${q(system32)} -RedirectStandardOutput ${q(out)} -RedirectStandardError ${q(err)} -Wait -PassThru`,
      'exit $p.ExitCode',
    ].join('\n');
    const r = spawnSync(windowsPowershell(host!.systemRoot!), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', timeout: 240_000, env: outerEnv });
    const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '');
    return { exitCode: r.status ?? 1, stdout: read(out), stderr: `${read(err)}${r.stderr}`, signal: null };
  };

  // The runner's PSModulePath may name PowerShell 7 modules that Windows PowerShell 5.1 cannot load (ConvertTo-SecureString then is not found).
  const outerEnv = (() => { const env = { ...process.env }; for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]; return env; })();

  const asAdmin: SpecRunner = (spec) => runCommandSpec(spec, runHostOf(host!));

  /** A PowerShell run by the user that lists how many processes' image paths WMI cannot give (the premise of the test). */
  async function unreadablePaths(): Promise<number> {
    const script = '$n = @(Get-CimInstance Win32_Process | Where-Object { -not $_.ExecutablePath -and $_.ProcessId -gt 4 }).Count; Write-Output "n $n"';
    const spec = { file: windowsPowershell(host!.systemRoot!), args: powershellEncodedArgs(script) } as CommandSpec;
    const r = await runAsUser(spec);
    return Number(/n (\d+)/.exec(r.stdout)?.[1] ?? -1);
  }

  const folder = (name: string): string => {
    const dir = path.join(hub, name);
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'azito-hub.cjs'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'y');
    return dir;
  };

  const prune = (versionsInUse: () => Promise<ReadonlySet<string>>) => pruneHubVersions({
    hubDir: hub,
    current: 'v0.4.0',
    previous: 'v0.3.0',
    versionsInUse,
    removeIsolated: (name) => removeFolderWithRd(asAdmin, host!.systemRoot!, hub, name, fs.existsSync),
  });

  it('does not stop on the system and other accounts\' processes whose path it cannot read, and the tidying runs', async () => {
    expect(setupProblem, setupProblem).toBeUndefined();
    // Without this the test proves nothing: the user must really be unable to read some process's path.
    expect(await unreadablePaths()).toBeGreaterThan(0);
    folder('v0.1.0');

    const report = await prune(async () => new Set(await findHubVersionsInUse(runAsUser, host!.systemRoot!, [hub])));

    expect(report.removed).toEqual(['v0.1.0']);
    expect(report.failed).toEqual([]);
    expect(fs.readdirSync(hub)).toEqual([]);
  }, 300_000);

  it('still keeps a version whose node.exe runs under another account, found by the write check instead of the process list', async () => {
    expect(setupProblem, setupProblem).toBeUndefined();
    const dir = folder('v0.1.0');
    folder('v0.2.0');
    const exe = path.join(dir, 'node.exe');
    fs.copyFileSync(process.execPath, exe);
    const child = spawn(exe, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });

    const report = await prune(async () => new Set(await findHubVersionsInUse(runAsUser, host!.systemRoot!, [hub])));

    expect(report.removed).toEqual(['v0.2.0']);
    expect(report.failed).toEqual([{ name: 'v0.1.0', reason: expect.stringMatching(/node\.exe cannot be opened for writing|a running process uses it/) }]);
    expect(fs.existsSync(exe)).toBe(true);
  }, 300_000);
});
