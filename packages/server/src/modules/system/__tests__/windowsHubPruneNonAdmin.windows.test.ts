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
describe.skipIf(process.platform !== 'win32')('tidying the old versions as a user who is not an administrator', () => {
  const host = process.platform === 'win32' ? resolveCurrentHostEnv() : undefined;
  // A name of our own for each run: an account that already exists is never touched, and only the one this run made is removed.
  const user = `azp${crypto.randomBytes(5).toString('hex')}`;
  const password = `Az1-${crypto.randomBytes(12).toString('hex')}`;
  const system32 = host ? path.join(host.systemRoot!, 'System32') : '';
  let root: string;
  let hub: string;
  let userSid: string | undefined;
  let setupProblem: string | undefined;
  const children: ChildProcess[] = [];

  const net = (...args: string[]) => spawnSync(path.join(system32, 'net.exe'), args, { encoding: 'utf-8' });
  const powershellOut = (script: string) => spawnSync(windowsPowershell(host!.systemRoot!), powershellEncodedArgs(script), { encoding: 'utf-8', env: outerEnv });
  const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-prune-na-')));
    hub = path.join(root, 'hub');
    fs.mkdirSync(hub);
    // The user reads the helper's output files and the (Everyone-readable) temp folder; only `out\` is written by it.
    fs.mkdirSync(path.join(root, 'out'));
    spawnSync(path.join(system32, 'icacls.exe'), [path.join(root, 'out'), '/grant', '*S-1-1-0:(OI)(CI)M'], { encoding: 'utf-8' });
    const added = net('user', user, password, '/add', '/y');
    if (added.status !== 0) { setupProblem = `net user could not make ${user}: ${added.stdout}${added.stderr}`; return; }
    const sid = /S-1-5-21-[0-9-]+/.exec(powershellOut(`Write-Output ((New-Object Security.Principal.NTAccount('${user}')).Translate([Security.Principal.SecurityIdentifier]).Value)`).stdout)?.[0];
    if (sid === undefined) { setupProblem = `could not read the SID of ${user}`; net('user', user, '/delete'); return; }
    userSid = sid;
  });

  afterAll(async () => {
    const waiting = children.splice(0).map((child) => new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { child.once('exit', () => resolve()); child.kill(); } }));
    await Promise.all(waiting);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    if (userSid === undefined) return;
    // The profile that `-LoadUserProfile` made (it can stay loaded for a moment after the user's last process ends), then the account; both must be gone.
    const profileGone = (): boolean => powershellOut(`Write-Output ('profiles ' + @(Get-CimInstance Win32_UserProfile -Filter "SID='${userSid}'").Count)`).stdout.includes('profiles 0');
    let removed = false;
    for (let attempt = 0; attempt < 10 && !removed; attempt++) {
      powershellOut(`Get-CimInstance Win32_UserProfile -Filter "SID='${userSid}'" | Remove-CimInstance -ErrorAction SilentlyContinue`);
      removed = profileGone();
      if (!removed) sleep(1000);
    }
    const deleted = net('user', user, '/delete');
    const accountGone = net('user', user).status !== 0;
    if (!removed || deleted.status !== 0 || !accountGone) {
      throw new Error(`could not remove the test account ${user} (${userSid}): profile removed=${removed}, net user /delete exit ${deleted.status} ${deleted.stdout}${deleted.stderr}, account gone=${accountGone}`);
    }
  }, 120_000);

  /** Runs a spec as the standard user (PowerShell `Start-Process -Credential`, output through files the user can write). */
  const runAsUser: SpecRunner = async (spec: CommandSpec) => {
    const tag = crypto.randomBytes(4).toString('hex');
    const out = path.join(root, 'out', `${tag}.out`);
    const err = path.join(root, 'out', `${tag}.err`);
    const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    const script = [
      `$cred = New-Object Management.Automation.PSCredential(".\\${user}", (ConvertTo-SecureString ${q(password)} -AsPlainText -Force))`,
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

    // The look-up as the other user does not see this version (it cannot read the path of the runner's process) ...
    const inUse = await findHubVersionsInUse(runAsUser, host!.systemRoot!, [hub]);
    expect([...inUse]).not.toContain('v0.1.0');
    // ... so with exactly that list it is the write check alone that keeps it.
    const report = await prune(async () => inUse);

    expect(report.removed).toEqual(['v0.2.0']);
    expect(report.failed).toEqual([{ name: 'v0.1.0', reason: expect.stringMatching(/node\.exe cannot be opened for writing/) }]);
    expect(fs.existsSync(exe)).toBe(true);
  }, 300_000);
});
