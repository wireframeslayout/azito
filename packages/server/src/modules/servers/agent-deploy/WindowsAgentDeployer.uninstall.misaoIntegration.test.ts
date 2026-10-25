import { exec as execCallback, execFile, spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MISAO_CLI } from '../../../shared/misaoTestBinary';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { encodeTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { buildMisaoTaskXml, misaoWindowsLayout } from '../../system/misao/misaoWindowsTask';
import { windowsMisaoPipe } from '../transport/agentMisaoSocket';
import { WindowsAgentDeployer, type WindowsSshExec } from './WindowsAgentDeployer';
import { buildWindowsPreflightCommand, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';
import type { WindowsAgentOptions } from './windowsAgentConfig';

/**
 * Removing the misao beside a Windows agent against a REAL misao daemon: one daemon runs for the folder that is to be removed, started
 * by its Task Scheduler task as the installer does (under `conhost.exe --headless`; on a machine with no logon session the Task
 * Scheduler cannot start it, and it is started under `conhost.exe --headless` directly instead), and another runs for a different folder.
 * The uninstall must stop the first (its process gone, its pipe closed, its task and folder removed) and leave the second running.
 * Everything here is unique to this run, and the suite FAILS if it cannot clean up.
 */
const SUFFIX = crypto.randomBytes(4).toString('hex');
const OPTIONS: WindowsAgentOptions = { taskName: `AzitoCiAgent-${SUFFIX}`, dir: `azito-ci-umi-${SUFFIX}`, port: 3999, misaoTaskName: `AzitoCiMisao-${SUFFIX}`, misaoDir: `azito-ci-umi-misao-${SUFFIX}` };
const OTHER_DIR = `azito-ci-umi-other-${SUFFIX}`;
const VERSION = '0.3.0';
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';

const cmdExec: WindowsSshExec = (_host, command, timeoutMs) => new Promise((resolve) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  execCallback(command, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    resolve({ stdout, stderr, code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0 });
  });
});

async function ps(script: string): Promise<string> {
  const out = await cmdExec('ci', powershellDialect.wrapScript(script), 120_000);
  if (out.code !== 0) throw new Error(`PowerShell failed (exit ${out.code}): ${out.stderr.slice(0, 500)}`);
  return out.stdout;
}

function schtasks(args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile(path.win32.join(SYSTEM_ROOT, 'System32', 'schtasks.exe'), args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, text: `${stdout}${stderr}` });
    });
  });
}

/** Whether something accepts a connection on the named pipe. */
function pipeUp(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(pipe);
    const done = (up: boolean): void => { connection.destroy(); resolve(up); };
    connection.setTimeout(2000, () => done(false));
    connection.once('connect', () => done(true));
    connection.once('error', () => done(false));
  });
}

async function waitFor(what: string, condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The `misao.exe` processes whose command line names `root` (the folder is its `--data` argument). */
async function daemonPids(root: string): Promise<number[]> {
  const out = await ps([
    `$root = ${powershellDialect.quote(root)}`,
    '$ids = @(Get-CimInstance Win32_Process -Filter "Name = \'misao.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) } | ForEach-Object { [int]$_.ProcessId })',
    '$global:LASTEXITCODE = 0',
    'ConvertTo-Json -InputObject $ids -Compress',
  ].join('\n'));
  const parsed = JSON.parse(out.trim() || '[]') as number | number[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

describe.skipIf(process.platform !== 'win32' || !fs.existsSync(MISAO_CLI))('removing the misao of a Windows agent, against a real misao daemon', () => {
  let host: WindowsPreflightInfo;
  let deployer: WindowsAgentDeployer;
  const home = os.homedir();
  const misaoRoot = path.win32.join(home, OPTIONS.misaoDir);
  const otherRoot = path.win32.join(home, OTHER_DIR);
  const pipeOf = (root: string): string => windowsMisaoPipe(root, os.userInfo().username);
  const children: ChildProcess[] = [];
  let otherPid: number | undefined;

  /** `conhost.exe --headless misao.exe serve ...`: what the Task Scheduler's task runs the daemon under. */
  function startUnderConhost(exe: string, root: string): void {
    children.push(spawn(path.win32.join(SYSTEM_ROOT, 'System32', 'conhost.exe'), ['--headless', exe, 'serve', '--socket', pipeOf(root), '--data', root], { stdio: 'ignore', windowsHide: true }));
  }

  beforeAll(async () => {
    const pre = await cmdExec('ci', buildWindowsPreflightCommand(), 120_000);
    host = parseWindowsPreflight(pre.stdout, pre.stderr, pre.code);
    deployer = new WindowsAgentDeployer(cmdExec, { putFile: async () => undefined, putBuffer: async () => undefined }, OPTIONS);

    // The folder to be removed: the release the task runs, and the task itself (registered the way the installer registers it).
    const layout = misaoWindowsLayout({ misaoRoot }, VERSION, OPTIONS.misaoTaskName);
    fs.mkdirSync(layout.versionDir, { recursive: true });
    fs.copyFileSync(MISAO_CLI, layout.exe);
    const xml = buildMisaoTaskXml({ userId: host.userId, systemRoot: host.systemRoot, homeDir: home, layout, pipe: pipeOf(misaoRoot) });
    const xmlFile = path.join(os.tmpdir(), `azito-ci-umi-${SUFFIX}.xml`);
    fs.writeFileSync(xmlFile, encodeTaskXml(xml));
    const created = await schtasks(['/Create', '/XML', xmlFile, '/TN', OPTIONS.misaoTaskName, '/F']);
    fs.rmSync(xmlFile, { force: true });
    expect(created.code, created.text).toBe(0);

    // A daemon of a different folder, which must survive.
    fs.mkdirSync(otherRoot, { recursive: true });
    startUnderConhost(MISAO_CLI, otherRoot);
    await waitFor('the other daemon\'s pipe', () => pipeUp(pipeOf(otherRoot)), 60_000);
    otherPid = (await daemonPids(otherRoot))[0];

    // The daemon to be removed, started by its task; with no logon session the task cannot start, and it is started under conhost directly.
    await schtasks(['/Run', '/TN', OPTIONS.misaoTaskName]);
    const started = await waitFor('the daemon of the task', () => pipeUp(pipeOf(misaoRoot)), 30_000).then(() => true, () => false);
    if (!started) {
      console.warn('[uninstall.misaoIntegration] the Task Scheduler did not start the misao task here (no logon session): started it under conhost --headless directly');
      startUnderConhost(layout.exe, misaoRoot);
      await waitFor('the daemon of the folder to remove', () => pipeUp(pipeOf(misaoRoot)), 60_000);
    }
  }, 300_000);

  afterAll(async () => {
    const problems: string[] = [];
    await schtasks(['/Delete', '/TN', OPTIONS.misaoTaskName, '/F']);
    if ((await schtasks(['/Query', '/TN', OPTIONS.misaoTaskName])).code === 0) problems.push('the misao task is still registered');
    for (const child of children) child.kill();
    for (const root of [misaoRoot, otherRoot]) {
      for (const pid of await daemonPids(root).catch(() => [] as number[])) { try { process.kill(pid); } catch { /* already gone */ } }
    }
    for (const dir of [misaoRoot, otherRoot]) {
      for (let attempt = 0; attempt < 20 && fs.existsSync(dir); attempt++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
      if (fs.existsSync(dir)) problems.push(`the folder ${dir} could not be removed`);
    }
    if (problems.length > 0) throw new Error(`The test could not clean up after itself:\n${problems.join('\n')}`);
  }, 120_000);

  it('stops the daemon of the folder (process gone, pipe closed), removes its task and folder, and leaves a daemon of another folder running', async () => {
    expect((await daemonPids(misaoRoot)).length).toBeGreaterThan(0);
    expect(await pipeUp(pipeOf(misaoRoot))).toBe(true);

    const result = await deployer.uninstall('ci', host, { removeMisao: true });

    const step = (id: string): string | undefined => result.steps.find((s) => s.id === id)?.outcome;
    expect([step('misaoTask'), step('misaoProcesses'), step('misaoFolder')], JSON.stringify(result.steps)).toEqual(['done', 'done', 'done']);
    expect(await daemonPids(misaoRoot)).toEqual([]);
    await waitFor('the pipe to close', async () => !(await pipeUp(pipeOf(misaoRoot))), 15_000);
    expect((await schtasks(['/Query', '/TN', OPTIONS.misaoTaskName])).code).not.toBe(0);
    expect(fs.existsSync(misaoRoot)).toBe(false);

    // The other folder's daemon was not touched.
    expect(await daemonPids(otherRoot)).toContain(otherPid);
    expect(await pipeUp(pipeOf(otherRoot))).toBe(true);
    expect(fs.existsSync(otherRoot)).toBe(true);
  }, 300_000);
});
