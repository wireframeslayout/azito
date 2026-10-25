import { exec as execCallback, execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MISAO_CLI } from '../../../shared/misaoTestBinary';
import { runCommandSpec, runHostOf } from '../../../shared/exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../../../shared/os/hostEnv';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { SchtasksClient, rawRunnerOf } from '../../../shared/os/taskScheduler/schtasks';
import { encodeTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { buildMisaoTaskXml, misaoWindowsLayout } from '../../system/misao/misaoWindowsTask';
import { windowsMisaoPipe } from '../transport/agentMisaoSocket';
import { WindowsAgentDeployer, type WindowsSshExec } from './WindowsAgentDeployer';
import { buildWindowsPreflightCommand, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';
import type { WindowsAgentOptions } from './windowsAgentConfig';

/**
 * Removing the misao beside a Windows agent against a REAL misao daemon: one daemon runs for the folder that is to be removed, started
 * by its Task Scheduler task as the installer does (under `conhost.exe --headless`), and another runs, by a task of its own, for a different
 * folder. On a machine with no logon session the Task Scheduler cannot start them and the test is skipped, with the reason.
 * The uninstall must stop the first (its process gone, its pipe closed, its task and folder removed) and leave the second running.
 * Everything here is unique to this run, and the suite FAILS if it cannot clean up.
 */
const SUFFIX = crypto.randomBytes(4).toString('hex');
const OPTIONS: WindowsAgentOptions = { taskName: `AzitoCiAgent-${SUFFIX}`, dir: `azito-ci-umi-${SUFFIX}`, port: 3999, misaoTaskName: `AzitoCiMisao-${SUFFIX}`, misaoDir: `azito-ci-umi-misao-${SUFFIX}` };
const OTHER_DIR = `azito-ci-umi-other-${SUFFIX}`;
/** The Task Scheduler's last results of a task that could not start for want of a logon session of its user (the same pair the other Windows tests accept). */
const NO_INTERACTIVE_LOGON = new Set([0x8004130f, 0x80070520]);

class NoLogonSession extends Error {}

const OTHER_TASK = `AzitoCiOtherMisao-${SUFFIX}`;
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
  let otherPid: number | undefined;

  /** The tail of a daemon's log, for the message of a daemon that did not come up. */
  function logTail(root: string): string {
    try { return fs.readFileSync(path.win32.join(root, 'misao.log'), 'utf8').slice(-1500); } catch { return '(no log)'; }
  }

  /**
   * A misao for `root` the way the installer sets it up: the release in `<root>\0.3.0`, a Task Scheduler task registered from the same
   * definition, and the daemon started BY that task (so its parents are the task's `conhost.exe --headless`, which is what the uninstall
   * looks for). Resolves when the daemon answers. When it does not, the Task Scheduler is asked why: a result that says the user has no logon
   * session to run it in is {@link NoLogonSession} (the only reason the test is skipped); anything else (the launcher, a daemon that
   * crashed, a task that never ran) is an error that fails the test, with the result and the daemon's log.
   */
  async function startByTask(taskName: string, root: string): Promise<void> {
    const layout = misaoWindowsLayout({ misaoRoot: root }, VERSION, taskName);
    fs.mkdirSync(layout.versionDir, { recursive: true });
    fs.copyFileSync(MISAO_CLI, layout.exe);
    const xml = buildMisaoTaskXml({ userId: host.userId, systemRoot: host.systemRoot, homeDir: home, layout, pipe: pipeOf(root) });
    const xmlFile = path.join(os.tmpdir(), `azito-ci-umi-${SUFFIX}-${taskName}.xml`);
    fs.writeFileSync(xmlFile, encodeTaskXml(xml));
    const created = await schtasks(['/Create', '/XML', xmlFile, '/TN', taskName, '/F']);
    fs.rmSync(xmlFile, { force: true });
    expect(created.code, created.text).toBe(0);
    const run = await schtasks(['/Run', '/TN', taskName]);
    expect(run.code, run.text).toBe(0);
    try {
      await waitFor(`the daemon of ${taskName}`, () => pipeUp(pipeOf(root)), 45_000);
    } catch (err) {
      const state = await taskScheduler.query(taskName);
      const lastResult = state.exists ? state.lastResult : undefined;
      if (lastResult !== undefined && NO_INTERACTIVE_LOGON.has(lastResult)) throw new NoLogonSession(`the task ${taskName} did not start: last result 0x${lastResult.toString(16)} (no logon session for ${host.userId})`);
      throw new Error(`${(err as Error).message}; the task's state: ${JSON.stringify(state)}; the daemon's log:\n${logTail(root)}`);
    }
  }

  /** Why the daemons could not be started by their tasks here: the Task Scheduler said there is no logon session. Undefined otherwise. */
  let noLogonSession: string | undefined;
  const hostEnv = resolveCurrentHostEnv();
  let taskScheduler: SchtasksClient;

  beforeAll(async () => {
    const pre = await cmdExec('ci', buildWindowsPreflightCommand(), 120_000);
    host = parseWindowsPreflight(pre.stdout, pre.stderr, pre.code);
    deployer = new WindowsAgentDeployer(cmdExec, { putFile: async () => undefined, putBuffer: async () => undefined }, OPTIONS);

    // A daemon of a different folder (its own task, which the uninstall does not know), which must survive; then the daemon to be removed.
    taskScheduler = new SchtasksClient(rawRunnerOf((spec) => runCommandSpec(spec, { ...runHostOf(hostEnv), rawOutput: true })), hostEnv);
    try {
      await startByTask(OTHER_TASK, otherRoot);
      await startByTask(OPTIONS.misaoTaskName, misaoRoot);
    } catch (err) {
      if (!(err instanceof NoLogonSession)) throw err;
      noLogonSession = err.message;
      return;
    }
    otherPid = (await daemonPids(otherRoot))[0];
  }, 300_000);

  afterAll(async () => {
    const problems: string[] = [];
    for (const name of [OPTIONS.misaoTaskName, OTHER_TASK]) {
      await schtasks(['/End', '/TN', name]);
      await schtasks(['/Delete', '/TN', name, '/F']);
      if ((await schtasks(['/Query', '/TN', name])).code === 0) problems.push(`the task ${name} is still registered`);
    }
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

  it('stops the daemon of the folder (process gone, pipe closed), removes its task and folder, and leaves a daemon of another folder running', async (ctx) => {
    if (noLogonSession !== undefined) ctx.skip(noLogonSession);
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
