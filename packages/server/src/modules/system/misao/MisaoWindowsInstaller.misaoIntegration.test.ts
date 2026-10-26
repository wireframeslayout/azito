import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { type MuxRef, type PaneHandle } from '@azito/shared';
import { buildCommandSpec } from '../../../shared/exec/commandSpec';
import { powershellDialect, powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { MISAO_CLI } from '../../../shared/misaoTestBinary';
import { SchtasksClient } from '../../../shared/os/taskScheduler/schtasks';
import { createScriptCommandSpecRunner } from '../../servers/agent-deploy/windowsSshRunner';
import { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { testLocalHost } from '../../../shared/os/testing/testLocalHost';
import type { ServerConfig } from '../../servers/Server';
import type { AgentTransport } from '../../servers/transport/AgentTransport';
import { TransportFactory } from '../../servers/transport/TransportFactory';
import { windowsMisaoPipe } from '../../servers/transport/agentMisaoSocket';
import { MuxDriverRegistry } from '../../tmux/MuxDriverRegistry';
import { describeMisaoDaemon, registerMisaoDriver, type MisaoHandle } from '../../tmux/misao/misaoDriver';
import { hubPaneShell } from '../../tmux/misao/paneShell';
import { daemonCheckScript, parseDaemonCheck, sameProgram } from './misaoWindowsVerify';
import { readMisaoBundle } from './MisaoBundle';
import { writeHubBundle } from './misaoBundleFixture';
import { MisaoAgentInstaller } from './MisaoAgentInstaller';
import { readFakeAgentReport, readFakeTaskAgentResult, writeFakeAgent, writeFakeTaskAgent } from '../../../shared/misaoFakeAgent';

/**
 * misao on a real Windows, end to end: the hub's installer puts the real `misao.exe` (the pinned release the hub ships; CI fetches
 * it, `MISAO_CLI` names it) on a real agent process through the agent, registers the Task Scheduler task and starts it under
 * `conhost.exe --headless`; the hub reaches the daemon through the agent's relay (a named pipe), opens a window, types into it,
 * reads the screen, updates the release in place, and stops the daemon with `misao stop`. Task, folder, pipe and port are unique
 * to this run, and the suite FAILS if anything it made is left behind.
 *
 * When this machine has no interactive logon session the Task Scheduler cannot start the task (the install says so and undoes
 * itself, which is checked); the rest then runs against a daemon started directly from the very file the installer put there.
 */
const SUFFIX = crypto.randomBytes(4).toString('hex');
const TASK_NAME = `AzitoCiMisao-${SUFFIX}`;
const MISAO_DIR = `azito-ci-misao-${SUFFIX}`;
const ROOT = path.win32.join(os.homedir(), MISAO_DIR);
const PIPE = windowsMisaoPipe(ROOT, os.userInfo().username);
const OLD_VERSION = '0.2.0';
const VERSION = '0.3.0';
const NO_INTERACTIVE_LOGON = /0x(8004130f|80070520)/i;
const AGENT_MAIN = path.resolve(__dirname, '../../../agent/main.ts');
const TSX_CLI = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const HUB_ENV = { publicUrl: 'http://hub.example:3001', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh-token-secret', harnessPrefix: '' };
const AGENT_TOKEN = crypto.randomBytes(16).toString('hex');
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.skipIf(process.platform !== 'win32' || !fs.existsSync(MISAO_CLI))('misao on a real Windows agent', () => {
  let tmp: string;
  let agent: ChildProcess | undefined;
  let direct: ChildProcess | undefined;
  let agentLog = '';
  let port: number;
  let server: ServerConfig;
  let transport: AgentTransport;
  let misao: MisaoHandle | undefined;
  let registry: MuxDriverRegistry;
  /** Whether the Task Scheduler could start the task (this machine has a logon session for the user). */
  let viaTask: boolean | undefined;
  const warn = vi.fn();

  /** The release the task starts now (the test moves it along). */
  let currentVersion = OLD_VERSION;

  const installerFor = (version: string, binary: Buffer = fs.readFileSync(MISAO_CLI), readyTimeoutMs = 60_000) => {
    const hub = path.join(tmp, `hub-${version}`);
    if (!fs.existsSync(hub)) writeHubBundle(hub, version, binary);
    return new MisaoAgentInstaller(readMisaoBundle(hub), { windowsTaskName: TASK_NAME, readyTimeoutMs, pollIntervalMs: 250 });
  };

  /** A PowerShell script run on this machine the way the agent runs one for the installer. */
  async function powershell(script: string): Promise<string> {
    const result = await transport.run(buildCommandSpec('powershell.exe', powershellEncodedArgs(`$ProgressPreference = 'SilentlyContinue'\n${script}`), { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 }));
    if (result.exitCode !== 0) throw new Error(`PowerShell failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
    return result.stdout;
  }

  /** The processes of this run's daemon: `misao.exe`, and the `cmd.exe` / `conhost.exe` above it, found by the pipe or the folder in their command line. */
  async function runProcesses(names: string[]): Promise<number[]> {
    const out = await powershell([
      `$pipe = ${powershellDialect.quote(PIPE)}`,
      `$root = ${powershellDialect.quote(ROOT)}`,
      `$names = @(${names.map((n) => powershellDialect.quote(n)).join(', ')})`,
      '$ids = @(Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name -and $_.CommandLine -and ($_.CommandLine.Contains($pipe) -or $_.CommandLine.Contains($root)) } | ForEach-Object { [int]$_.ProcessId })',
      '$global:LASTEXITCODE = 0',
      'ConvertTo-Json -InputObject $ids -Compress',
    ].join('\n'));
    const parsed = JSON.parse(out.trim() || '[]') as number | number[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  /** The `misao.exe` processes of this run. */
  const daemonProcesses = (): Promise<number[]> => runProcesses(['misao.exe']);

  /** The Task Scheduler of the machine, reached through the agent like the installer does. */
  const tasks = () => new SchtasksClient(createScriptCommandSpecRunner(async (script, timeoutMs) => {
    const result = await transport.run(buildCommandSpec('powershell.exe', powershellEncodedArgs(script), { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 }));
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
  }), { systemRoot: SYSTEM_ROOT });

  const taskExists = async (): Promise<boolean> => (await tasks().query(TASK_NAME)).exists;

  const registered = async (): Promise<string> => tasks().exportXml(TASK_NAME);

  const driver = () => registry.resolveKind('misao', server);

  async function openWindow(): Promise<{ ref: MuxRef; pane: PaneHandle }> {
    const name = `w${Math.random().toString(36).slice(2, 7)}`;
    const opened = await driver().openWorkspace(server, `azw-${name}`, { windowName: name, exactName: true });
    return { ref: opened.ref, pane: await driver().resolvePane(server, opened.ref, 1) };
  }

  const screenOf = async (pane: PaneHandle): Promise<string> => (await driver().captureScreen(server, pane)).stdout;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'azmw-'));
    port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AZITO_AGENT_BIND: '127.0.0.1',
      AZITO_AGENT_TOKEN: AGENT_TOKEN,
      PORT: String(port),
      AZITO_MISAO_DIR: MISAO_DIR,
    };
    delete env.MISAO_SOCKET;
    agent = spawn(process.execPath, [TSX_CLI, AGENT_MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(__dirname, '../../../..'), windowsHide: true });
    agent.stdout?.on('data', (chunk: Buffer) => { agentLog += chunk.toString(); });
    agent.stderr?.on('data', (chunk: Buffer) => { agentLog += chunk.toString(); });
    await vi.waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      expect(res?.ok, agentLog).toBe(true);
    }, { timeout: 60_000, interval: 300 });

    server = { name: 'win1', type: 'agent', host: '127.0.0.1', agentPort: port, agentToken: AGENT_TOKEN, defaultMux: 'misao', muxRuntime: 'system', isolationIntent: false, hostProfile: { platform: 'win32', arch: 'x64' } } as ServerConfig;
    const factory = new TransportFactory(HUB_ENV.publicUrl, testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
    transport = factory.getAgentTransport(server);
    registry = new MuxDriverRegistry();
    const sdk = await import('@misao/sdk');
    misao = registerMisaoDriver(registry, { sdk, socketPath: path.join(tmp, 'unused-local.sock'), paneShell: hubPaneShell('/bin/bash', { platform: 'linux', arch: 'x64' }) }, () => undefined, { warn }, HUB_ENV, {
      target: (srv) => ({ connect: ({ signal }) => factory.getAgentTransport(srv).connectMisaoRelay(signal) }),
      status: (srv) => factory.getAgentTransport(srv).fetchMisaoStatus(),
      hostInfo: (srv) => factory.getAgentTransport(srv).fetchHostInfo(),
      latest: () => server,
    });
  }, 120_000);

  afterAll(async () => {
    const problems: string[] = [];
    misao?.servers.closeAgentNodes();
    misao?.connection.close();
    direct?.kill();
    if (transport) {
      // Whatever the test left running: the task (and with it the daemon), then any process of this run. A question that cannot be answered is a problem too.
      await (async () => {
        const state = await tasks().query(TASK_NAME);
        if (state.exists && state.running) await tasks().stop(TASK_NAME);
        if (state.exists) await tasks().delete(TASK_NAME);
      })().catch((e: unknown) => problems.push(`deleting the task: ${(e as Error).message}`));
      try {
        for (const id of await runProcesses(['misao.exe', 'cmd.exe', 'conhost.exe'])) await powershell(`Stop-Process -Id ${id} -Force -ErrorAction SilentlyContinue`);
      } catch (e) {
        problems.push(`ending the processes: ${(e as Error).message}`);
      }
      try {
        if (await taskExists()) problems.push(`the task ${TASK_NAME} is still registered`);
        await new Promise((r) => setTimeout(r, 1000));
        const left = await runProcesses(['misao.exe', 'cmd.exe', 'conhost.exe']);
        if (left.length > 0) problems.push(`processes of this run are still running: ${left.join(', ')}`);
      } catch (e) {
        problems.push(`could not check what is left: ${(e as Error).message}`);
      }
    }
    if (agent && agent.exitCode === null) {
      const exited = new Promise<void>((resolve) => agent!.once('exit', () => resolve()));
      agent.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      if (agent.exitCode === null && agent.signalCode === null) problems.push('the agent process did not end');
    }
    // The folder may still be held for a moment by a process that is ending.
    for (let attempt = 0; attempt < 20 && fs.existsSync(ROOT); attempt++) {
      try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    if (fs.existsSync(ROOT)) problems.push(`the folder ${ROOT} could not be removed`);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (problems.length > 0) throw new Error(`The test could not clean up after itself:\n${problems.join('\n')}\nagent log:\n${agentLog.slice(-2000)}`);
  }, 180_000);

  it('the agent reports the Windows host: the managed pipe, the misao folder and the account', async () => {
    const status = await transport.fetchMisaoStatus();
    expect(status).toMatchObject({ socketPath: PIPE, socketPresent: false, host: { platform: 'win32', windows: { misaoRoot: ROOT, userName: os.userInfo().username } } });
    expect(status).not.toHaveProperty('installedVersion');
    expect((await transport.fetchHostInfo())).toMatchObject({ platform: 'win32', shell: process.env.ComSpec });
  });

  it('installs the release through the agent: the real misao.exe, sha256-checked, an owner-only folder, a logon task named for the release', async (ctx) => {
    const steps: string[] = [];
    let result;
    try {
      result = await installerFor(OLD_VERSION).install(transport, (step) => steps.push(step));
    } catch (err) {
      // Only a developer's own machine may fall back to a daemon started directly: CI must prove the Task Scheduler path, so it fails there.
      if (!NO_INTERACTIVE_LOGON.test((err as Error).message) || process.env.CI) throw new Error(`${(err as Error).message}\nagent log:\n${agentLog.slice(-2000)}`);
      viaTask = false;
      console.warn(`[MisaoWindowsInstaller.misaoIntegration.test] no interactive logon session: the task cannot start here (${(err as Error).message})`);
      // The install undid what it made: no task and no marker. The release folder is there; the daemon is started from it directly.
      expect(await taskExists()).toBe(false);
      expect(fs.existsSync(path.win32.join(ROOT, 'current'))).toBe(false);
      expect(fs.existsSync(path.win32.join(ROOT, OLD_VERSION, 'misao.exe'))).toBe(true);
      fs.mkdirSync(ROOT, { recursive: true });
      direct = spawn(path.win32.join(ROOT, OLD_VERSION, 'misao.exe'), ['serve', '--socket', PIPE, '--data', ROOT], { stdio: 'ignore', windowsHide: true });
      await vi.waitFor(async () => expect((await transport.fetchMisaoStatus()).socketPresent).toBe(true), { timeout: 30_000, interval: 250 });
      ctx.skip('the Task Scheduler has no logon session here; the daemon was started directly');
      return;
    }
    viaTask = true;
    expect(result).toEqual({ version: OLD_VERSION, runningVersion: OLD_VERSION, startMethod: 'taskscheduler', updateAvailable: false });
    expect(steps).toEqual(['inspect', 'transfer', 'prepare', 'start']);
    expect(fs.readFileSync(path.win32.join(ROOT, OLD_VERSION, 'misao.exe')).equals(fs.readFileSync(MISAO_CLI))).toBe(true);
    expect(fs.readFileSync(path.win32.join(ROOT, 'current'), 'utf8').trim()).toBe(OLD_VERSION);
    expect(fs.existsSync(path.win32.join(ROOT, `${OLD_VERSION}.upload`))).toBe(false);
    expect(fs.existsSync(path.win32.join(ROOT, `${TASK_NAME}.task.xml`))).toBe(false);

    const xml = await registered();
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain(path.win32.join(SYSTEM_ROOT, 'System32', 'conhost.exe'));
    expect(xml).toContain('--headless');
    expect(xml).toContain(path.win32.join(ROOT, OLD_VERSION, 'misao.exe'));
    expect(xml).toContain(PIPE);

    // Running under the task: one misao.exe naming the pipe, and its log is appended by cmd.exe.
    expect((await daemonProcesses()).length).toBe(1);
    expect(fs.existsSync(path.win32.join(ROOT, 'misao.log'))).toBe(true);
    expect(await transport.fetchMisaoStatus()).toMatchObject({ socketPresent: true, installedVersion: OLD_VERSION });
  }, 240_000);

  describe('through the agent relay (a named pipe)', () => {
    it('connects the hub to the daemon', async () => {
      expect(await misao!.servers.discoverAgentNode(server)).toBe(true);
      const node = misao!.servers.nodeFor(server);
      await vi.waitFor(() => expect(node.connection.availability()).toEqual({ available: true }), { timeout: 30_000, interval: 200 });
      expect(await describeMisaoDaemon(node.connection)).toMatchObject({ installed: true });
    }, 60_000);

    it('opens a window with cmd.exe, takes typed input and gives the screen back', async () => {
      const { ref, pane } = await openWindow();
      await driver().sendKeysToHandle(server, pane, ['echo azito-misao-ok', 'Enter']);
      await vi.waitFor(async () => expect(await screenOf(pane)).toContain('azito-misao-ok'), { timeout: 30_000, interval: 300 });
      expect(await driver().windowExists(server, ref)).toBe(true);
    }, 90_000);

    it('attaches a terminal: typed input reaches the pane and its output comes back', async () => {
      const { ref } = await openWindow();
      const stream = await driver().openTerminal(server, ref, 1, 80, 24);
      let received = '';
      stream.on('data', (chunk: string) => { received += chunk; });
      stream.write('echo through-the-relay\r');
      await vi.waitFor(() => expect(received).toContain('through-the-relay'), { timeout: 30_000, interval: 200 });
      stream.close();
    }, 90_000);

    it('creates a window whose first pane is the worker program (#371): a .cmd found through PATHEXT, its arguments, directory, size and env as given, no shell pane first', async () => {
      const fake = writeFakeAgent(tmp);
      const work = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'work-')));
      const name = `w${Math.random().toString(36).slice(2, 7)}`;

      const opened = await driver().openWorkspace(server, `azw-${name}`, {
        windowName: name,
        exactName: true,
        // `fake-agent` is `fake-agent.cmd` in the shim directory on the pane's PATH: misao resolves it with PATH and PATHEXT, no shell is typed into.
        program: { argv: ['fake-agent', '--model', 'claude-opus-4-6[1m]', '--flag'], cwd: work, cols: 120, rows: 40 },
        extraEnv: { PATH: `${fake.shimDir};${process.env.PATH ?? ''}`, AZITO_FAKE_ENV: 'from-the-window' },
      });

      const panes = await driver().listPanesByRef(server, opened.ref);
      expect(panes).toHaveLength(1);
      const program = panes[0].handle;
      await vi.waitFor(async () => expect(readFakeAgentReport(await screenOf(program))).not.toBeNull(), { timeout: 30_000, interval: 300 });
      const report = readFakeAgentReport(await screenOf(program))!;
      expect(report.cwd.toLowerCase()).toBe(work.toLowerCase());
      expect(report).toMatchObject({ args: ['--model', 'claude-opus-4-6[1m]', '--flag'], env: 'from-the-window', cols: 120, rows: 40 });
    }, 90_000);

    // A task's worker on Windows: the window starts in the worktree with the worker as its program, and the worker does what the Windows prompt
    // envelope says with the real scripts — output through azitoctl.mjs (UTF-8 on stdin), the work branch pushed by push.mjs, the done marker
    // appended by azitoctl.mjs signal. Both shapes of a Windows agent are run: an npm shim (.cmd, like codex.cmd) and a native binary (.exe, like claude.exe).
    it.each([['fake-task-cmd', 'cmd'], ['fake-task-exe', 'exe']] as const)('runs a task\'s steps as the worker program %s (.%s): output, push and signal reach the files the hub reads', async (program, shape) => {
      const fake = writeFakeTaskAgent(tmp);
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, `task-${shape}-`)));
      const remote = path.join(root, 'remote.git');
      const work = path.join(root, 'work tree');
      const gitIn = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
      execFileSync('git', ['init', '--bare', remote]);
      fs.mkdirSync(work);
      gitIn(work, ['init', '-b', 'master']);
      gitIn(work, ['config', 'user.email', 'ci@example.com']);
      gitIn(work, ['config', 'user.name', 'CI']);
      gitIn(work, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(work, 'README.md'), 'initial\n');
      gitIn(work, ['add', '-A']);
      gitIn(work, ['commit', '-m', 'initial']);
      gitIn(work, ['push', '-u', 'origin', 'master']);
      gitIn(work, ['checkout', '-b', 'task/7-feature']);
      fs.writeFileSync(path.join(work, 'feature.txt'), 'change\n');
      const outputFile = path.join(root, 'azito-output-7-abc.md');
      const signalFile = path.join(root, 'azito-pipe-7-sig-1.log');
      const content = '# 計画\n\n- "quoted" $(not run)\n\nAZITO_PHASE_SUMMARY: {"phase":"planning"}\n';
      const harness = path.resolve(__dirname, '../../../../../../harness');
      const name = `t${shape}${Math.random().toString(36).slice(2, 6)}`;

      const opened = await driver().openWorkspace(server, `azw-${name}`, {
        windowName: name,
        exactName: true,
        program: { argv: [program], cwd: work, cols: 120, rows: 40 },
        extraEnv: {
          PATH: `${shape === 'cmd' ? fake.cmdShimDir : fake.exeDir};${process.env.PATH ?? ''}`,
          ...(shape === 'exe' ? fake.exeEnv : {}),
          AZITO_FAKE_NODE: process.execPath,
          AZITO_FAKE_CTL: path.join(harness, 'bin', 'azitoctl.mjs'),
          AZITO_FAKE_PUSH: path.join(harness, 'sidekicks', 'pushing-default', 'scripts', 'push.mjs'),
          AZITO_FAKE_OUTPUT: outputFile,
          AZITO_FAKE_CONTENT: content,
          AZITO_FAKE_SIGNAL: signalFile,
          AZITO_FAKE_MARKER: 'AZITO_DONE_7_abc',
        },
      });
      const pane = (await driver().listPanesByRef(server, opened.ref))[0].handle;

      await vi.waitFor(async () => expect(readFakeTaskAgentResult(await screenOf(pane))).not.toBeNull(), { timeout: 60_000, interval: 500 });
      expect(readFakeTaskAgentResult(await screenOf(pane))).toEqual({ output: 0, push: 0, signal: 0 });
      expect(fs.readFileSync(outputFile, 'utf8')).toBe(content);
      expect(fs.readFileSync(signalFile, 'utf8')).toBe('AZITO_DONE_7_abc\n');
      expect(gitIn(work, ['ls-remote', '--heads', 'origin', 'task/7-feature']).trim()).toContain(gitIn(work, ['rev-parse', 'HEAD']).trim());
    }, 120_000);

    it('leaves no window behind when the program cannot be found (command not found)', async () => {
      const before = (await driver().listWorkspaces(server)).flatMap((w) => w.windows).length;
      await expect(driver().openWorkspace(server, 'azw-noprog', { windowName: 'noprog', exactName: true, program: { argv: ['azito-no-such-program-xyz'], cols: 120, rows: 40 } })).rejects.toThrow();
      expect((await driver().listWorkspaces(server)).flatMap((w) => w.windows).length).toBe(before);
    }, 60_000);

    it('refuses to run a command line in a pane (a worker is started as a program instead), leaving no window behind', async () => {
      const before = (await driver().listWorkspaces(server)).flatMap((w) => w.windows).length;
      await expect(driver().openWorkspace(server, 'azw-refused', { windowName: 'refused', exactName: true, command: 'claude' })).rejects.toMatchObject({ code: 'unsupported_os' });
      expect((await driver().listWorkspaces(server)).flatMap((w) => w.windows).length).toBe(before);
    }, 60_000);
  });

  it('names the program behind the pipe from the pipe\'s own server process, whatever spelling of the path is compared (8.3 short names)', async () => {
    const exe = path.win32.join(ROOT, currentVersion, 'misao.exe');
    const shortPath = (await powershell(`$global:LASTEXITCODE = 0\n(New-Object -ComObject Scripting.FileSystemObject).GetFile(${powershellDialect.quote(exe)}).ShortPath`)).trim();
    if (shortPath.toLowerCase() === exe.toLowerCase()) {
      console.warn(`[MisaoWindowsInstaller.misaoIntegration.test] this volume made no 8.3 short name for ${exe} (it is the same spelling): the short-path comparison below is trivial here`);
    } else {
      expect(shortPath).toMatch(/~\d/);
    }
    const started = Date.now();
    const viaShort = parseDaemonCheck(await powershell(daemonCheckScript(PIPE, shortPath)));
    console.log(`[MisaoWindowsInstaller.misaoIntegration.test] the pipe check (Add-Type, connect, server pid, long paths) took ${Date.now() - started} ms; short ${shortPath}, long ${viaShort.actual}`);
    expect(sameProgram(viaShort)).toBe(true);
    expect(viaShort.actual.toLowerCase()).toBe(exe.toLowerCase());
    // The upper-case spelling of the same path is the same program; another file is not.
    expect(sameProgram(parseDaemonCheck(await powershell(daemonCheckScript(PIPE, exe.toUpperCase()))))).toBe(true);
    expect(sameProgram(parseDaemonCheck(await powershell(daemonCheckScript(PIPE, MISAO_CLI))))).toBe(false);
    // A pipe of a similar name has no server: nothing is matched by name.
    await expect(powershell(daemonCheckScript(`${PIPE}-other`, exe))).rejects.toThrow();
  }, 120_000);

  it('a newer bundled release is put beside the running one and does not touch it; the update then switches and starts it', async (ctx) => {
    if (!viaTask) ctx.skip('the daemon was started directly (no logon session): there is no task to switch');
    const installer = installerFor(VERSION);
    const [pidBefore] = await daemonProcesses();
    expect(await installer.install(transport)).toEqual({ version: VERSION, runningVersion: OLD_VERSION, startMethod: 'running', updateAvailable: true });
    expect(fs.existsSync(path.win32.join(ROOT, VERSION, 'misao.exe'))).toBe(true);
    expect(await daemonProcesses()).toEqual([pidBefore]);
    expect(fs.readFileSync(path.win32.join(ROOT, 'current'), 'utf8').trim()).toBe(OLD_VERSION);

    const steps: string[] = [];
    expect(await installer.update(transport, (step) => steps.push(step))).toEqual({ version: VERSION, runningVersion: VERSION, startMethod: 'taskscheduler', updateAvailable: false });
    expect(steps).toEqual(['inspect', 'stop', 'start']);
    currentVersion = VERSION;
    expect(fs.readFileSync(path.win32.join(ROOT, 'current'), 'utf8').trim()).toBe(VERSION);
    expect(await registered()).toContain(path.win32.join(ROOT, VERSION, 'misao.exe'));
    const after = await daemonProcesses();
    expect(after.length).toBe(1);
    expect(after[0]).not.toBe(pidBefore);
    expect(await transport.fetchMisaoStatus()).toMatchObject({ socketPresent: true, installedVersion: VERSION });
    // The hub's connection comes back by itself; a window can be opened again.
    await vi.waitFor(() => expect(misao!.servers.nodeFor(server).connection.availability()).toEqual({ available: true }), { timeout: 60_000, interval: 300 });
    const { pane } = await openWindow();
    await driver().sendKeysToHandle(server, pane, ['echo after-update', 'Enter']);
    await vi.waitFor(async () => expect(await screenOf(pane)).toContain('after-update'), { timeout: 30_000, interval: 300 });
  }, 300_000);

  it('ends the task and sweeps the daemon when misao stop does not work, on the real PowerShell 5.1', async (ctx) => {
    if (!viaTask) ctx.skip('the daemon was started directly (no logon session): there is no task to end');
    const installer = installerFor('0.4.0');
    await installer.install(transport); // put beside the running one
    const [pidBefore] = await daemonProcesses();
    // The agent is asked to run everything but `misao stop`, which "does nothing": the Task Scheduler's End and the sweep must stop it.
    const real = transport.run.bind(transport);
    const deaf = Object.create(transport) as AgentTransport;
    deaf.run = async (spec) => (spec.file.toLowerCase().endsWith('misao.exe') && spec.args[0] === 'stop' ? { exitCode: 0, signal: null, stdout: '', stderr: '' } : real(spec));
    expect(await installer.update(deaf)).toMatchObject({ version: '0.4.0', startMethod: 'taskscheduler' });
    currentVersion = '0.4.0';
    const after = await daemonProcesses();
    expect(after.length).toBe(1);
    expect(after[0]).not.toBe(pidBefore);
    expect(fs.readFileSync(path.win32.join(ROOT, 'current'), 'utf8').trim()).toBe('0.4.0');
    expect(await transport.fetchMisaoStatus()).toMatchObject({ socketPresent: true, installedVersion: '0.4.0' });
  }, 300_000);

  it('puts the previous release and task back, and starts it, when the new release does not come up', async (ctx) => {
    if (!viaTask) ctx.skip('the daemon was started directly (no logon session): there is no task to switch');
    // A file that is not a program: the task starts, cmd.exe cannot run it, and the pipe never opens.
    const installer = installerFor('0.5.0', Buffer.from('this is not an executable'), 20_000);
    await installer.install(transport);
    const error = await installer.update(transport).then(() => undefined, (e: unknown) => e as Error);
    expect(error).toMatchObject({ code: 'update_failed' });
    expect(error!.message).toContain('was restored and started');
    expect(fs.readFileSync(path.win32.join(ROOT, 'current'), 'utf8').trim()).toBe('0.4.0');
    expect(await registered()).toContain(path.win32.join(ROOT, '0.4.0', 'misao.exe'));
    expect(await registered()).not.toContain(path.win32.join(ROOT, '0.5.0', 'misao.exe'));
    await vi.waitFor(async () => expect(await transport.fetchMisaoStatus()).toMatchObject({ socketPresent: true, installedVersion: '0.4.0' }), { timeout: 60_000, interval: 500 });
    expect((await daemonProcesses()).length).toBe(1);
  }, 300_000);

  it('misao stop through the pipe ends the daemon, and the task is not restarted for a clean exit', async () => {
    const exe = path.win32.join(ROOT, viaTask ? currentVersion : OLD_VERSION, 'misao.exe');
    const stopped = await transport.run(buildCommandSpec(exe, ['stop'], { env: { MISAO_SOCKET: PIPE }, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 }));
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    await vi.waitFor(async () => expect((await transport.fetchMisaoStatus()).socketPresent).toBe(false), { timeout: 30_000, interval: 250 });
    await vi.waitFor(async () => expect(await daemonProcesses()).toEqual([]), { timeout: 30_000, interval: 250 });
    if (viaTask) await vi.waitFor(async () => expect(await tasks().query(TASK_NAME)).toMatchObject({ exists: true, running: false }), { timeout: 30_000, interval: 500 });
  }, 120_000);
});
