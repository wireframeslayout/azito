import fs from 'fs';
import * as path from 'path';
import { buildCommandSpec } from '../../../shared/exec/commandSpec';
import { powershellDialect, powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { createScriptCommandSpecRunner } from '../../servers/agent-deploy/windowsSshRunner';
import { powershellErrorText } from '../../servers/agent-deploy/WindowsAgentDeployer';
import { SchtasksClient } from '../../../shared/os/taskScheduler/schtasks';
import { encodeTaskXml, isTaskDefinitionDisabled } from '../../../shared/os/taskScheduler/taskDefinition';
import { PROTECT_SCRIPT } from '../../../shared/os/windowsSecretFileGuard';
import { buildEndProcessesScript } from '../../../shared/os/windowsProcessSweep';
import { redactSecretText } from '../../../shared/redactSecretText';
import { managedEndpointOf, MISAO_RELEASE_FILE_NAMES, type AgentMisaoWindowsHost, type MisaoSocketStatus } from '../../servers/transport/agentMisaoSocket';
import type { MisaoBundle, MisaoTargetFiles } from './MisaoBundle';
import { bundleFilesFor, sha256Buffer } from './MisaoBundle';
import { daemonCheckScript, parseDaemonCheck, sameProgram } from './misaoWindowsVerify';
import { MisaoServiceError } from './MisaoServiceError';
import { buildMisaoTaskXml, taskMisaoRoot, misaoWindowsLayout, misaoWindowsReleasePaths, type MisaoWindowsLayout } from './misaoWindowsTask';
import type { MisaoAgentInstallResult, MisaoInstallStep, MisaoInstallTarget } from './misaoInstallTypes';

export interface MisaoWindowsInstallerOptions {
  /** The Task Scheduler task that runs the daemon (`MISAO_SERVICE.windowsTaskName`, or a trial's own). */
  taskName: string;
  /** How long a started daemon gets to open its pipe. */
  readyTimeoutMs?: number;
  /** Pause between two checks. */
  pollIntervalMs?: number;
  /** How long a stopped daemon's task gets to leave the running state before it is ended. */
  taskIdleTimeoutMs?: number;
  /**
   * Refuse (before anything is changed) when the task starts another folder's misao. Set for an agent's misao, whose folder is fixed
   * (`~\.azito\misao`). The hub's own misao leaves it off: its caller (`MisaoServiceService`) decides that, and `--replace-socket` takes the task over on purpose.
   */
  refuseTaskOfAnotherRoot?: boolean;
}

/**
 * The managed daemon of a Windows agent is installed by AZITO and does not answer (an agent that relays to another pipe, `MISAO_SOCKET`,
 * has a daemon that is not ours to start or stop).
 */
export function isManagedMisaoDown(status: MisaoSocketStatus): boolean {
  const { host } = status;
  return host.platform === 'win32' && host.windows !== undefined && status.socketPath === managedEndpointOf(host) && !status.socketPresent && status.installedVersion !== undefined;
}

/** What the installer needs of an agent on Windows. */
export type WindowsTarget = Pick<MisaoInstallTarget, 'run' | 'files' | 'fetchMisaoStatus' | 'uploadMisaoFile'>;

const win32 = path.win32;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const SCRIPT_TIMEOUT_MS = 60_000;
const STOP_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_TASK_IDLE_WAIT_MS = 20_000;
const TASK_IDLE_POLL_MS = 500;
const SCRIPT_OUTPUT_BYTES = 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The agent reported its folder in its real spelling and the task was written with it: the strings are compared, never looked up on this machine. */
function isTaskOfRoot(taskRoot: string | undefined, misaoRoot: string): boolean {
  return taskRoot !== undefined && win32.normalize(taskRoot).toLowerCase() === win32.normalize(misaoRoot).toLowerCase();
}

/** What was on the host before a switch, to put back if it fails. */
interface PreviousInstall {
  /** The task definition as it was, when a task was registered. */
  taskXml?: string;
  /** The release `current` named, when there was one. */
  version?: string;
}

/** One install or update in progress: everything resolved once from the agent's report. */
interface Session {
  target: WindowsTarget;
  windows: AgentMisaoWindowsHost;
  homeDir: string;
  nodePath: string;
  pipe: string;
  bundle: MisaoBundle;
  files: MisaoTargetFiles;
  tasks: SchtasksClient;
}

/**
 * The Windows side of `MisaoAgentInstaller`: the bundled `misao.exe` goes to `<home>\.azito\misao\<version>\` through the agent
 * (its upload route, sha256-checked on both ends, like the Unix install), and a Task Scheduler task starts it at the user's logon
 * (`conhost.exe --headless cmd.exe /c "misao.exe serve ..."`, the form misao's own task uses). Everything on the host is done by the
 * agent as the same user: PowerShell scripts (`powershell.exe -EncodedCommand`, no shell), `schtasks.exe`, and its file API.
 *
 * The same promises as the Unix install: `install()` never stops or switches a running daemon (an older release is left alone and
 * reported as an available update; a daemon AZITO did not install is refused); `update()` stops the running one with `misao stop`
 * (through the named pipe), switches, starts, and on any failure puts the previous release and task back and starts it. There is no
 * `current` link: the task names the release's `misao.exe` directly, and `<root>\current` (a file) says which release that is.
 */
export class MisaoWindowsInstaller {
  constructor(private readonly options: MisaoWindowsInstallerOptions) {}

  async install(target: WindowsTarget, bundle: MisaoBundle, onProgress: (step: MisaoInstallStep) => void): Promise<MisaoAgentInstallResult> {
    onProgress('inspect');
    const { session, status } = await this.inspect(target, bundle);
    await this.refuseTaskOfAnotherRootIfAsked(session);
    const live = status.socketPresent;
    // The pipe probe can miss a daemon that is just starting (the logon task is on its way up): the task's own state says so.
    if (!live && (await this.taskIsRunning(session))) {
      throw new MisaoServiceError('daemon_not_ready', `The task "${this.options.taskName}" is running but ${session.pipe} does not accept connections yet. Nothing was changed; try again in a moment.`);
    }
    if (live && !status.installedVersion) {
      throw new MisaoServiceError('custom_socket', `A misao daemon is already listening on ${session.pipe} that AZITO did not install. It is used as it is; AZITO will not put a second one beside it.`);
    }
    if (live && status.installedVersion === bundle.version) {
      return { version: bundle.version, runningVersion: bundle.version, startMethod: 'running', updateAvailable: false };
    }

    const xml = await this.buildTask(session, bundle.version);
    await this.ensureVersion(session, onProgress);
    if (live) {
      // An older release is running. Its panes would end with it, so only an explicit update switches (like the hub's own service).
      return { version: bundle.version, runningVersion: status.installedVersion!, startMethod: 'running', updateAvailable: true };
    }

    onProgress('start');
    const previous = await this.snapshot(session, status.installedVersion);
    try {
      await this.switchAndStart(session, xml);
      return { version: bundle.version, runningVersion: bundle.version, startMethod: 'taskscheduler', updateAvailable: false };
    } catch (err) {
      // Nothing was running, so nothing is lost; but an older install must be startable again as it was. The old release is not started: it was not running.
      await this.undoFailedInstall(err, session, previous);
      throw err;
    }
  }

  async update(target: WindowsTarget, bundle: MisaoBundle, onProgress: (step: MisaoInstallStep) => void): Promise<MisaoAgentInstallResult> {
    onProgress('inspect');
    const { session, status } = await this.inspect(target, bundle);
    // Another install's task is refused before "not installed": the task is not ours to judge or to replace, whatever the folder holds.
    await this.refuseTaskOfAnotherRootIfAsked(session);
    if (!status.installedVersion) {
      throw new MisaoServiceError('not_installed', 'misao is not installed on this server by AZITO, so there is nothing to update. Install it first.');
    }
    const live = status.socketPresent;
    if (live && status.installedVersion === bundle.version) {
      return { version: bundle.version, runningVersion: bundle.version, startMethod: 'running', updateAvailable: false };
    }
    // The pipe probe can miss a daemon that is just starting: stopping or restarting around it could not be undone, so nothing is touched.
    if (!live && (await this.taskIsRunning(session))) {
      throw new MisaoServiceError('daemon_not_ready', `The task "${this.options.taskName}" is running but ${session.pipe} does not accept connections yet. Nothing was changed; try again in a moment.`);
    }

    // The new release is complete on disk and its task definition is built before anything is stopped: a damaged transfer or a value the task cannot hold leaves the daemon running.
    const xml = await this.buildTask(session, bundle.version);
    await this.ensureVersion(session, onProgress);

    const previous = await this.snapshot(session, status.installedVersion);
    // From the first step of the stop on, a failure leaves the daemon in a state to be looked at, not assumed: see recoverFromFailedUpdate.
    const progress = { stopping: true };
    try {
      if (live) {
        onProgress('stop');
        await this.stopDaemonProcess(session, status.installedVersion);
      }
      // A task that is still running (a clean exit leaves it for a moment) would ignore the next start.
      await this.waitUntilTaskIdle(session);
      progress.stopping = false;
      onProgress('start');
      await this.switchAndStart(session, xml);
      return { version: bundle.version, runningVersion: bundle.version, startMethod: 'taskscheduler', updateAvailable: false };
    } catch (err) {
      return this.recoverFromFailedUpdate(err, session, previous, status.installedVersion, live, progress.stopping);
    }
  }

  /**
   * The daemon AZITO installed does not answer (it died: its task reports 0 whatever happened, so the Task Scheduler does not start it
   * again): starts the task through the agent. A task still "running" while the pipe is silent is left alone (it is starting), unless
   * `force`: then it is ended with the `misao.exe` of this pipe first. Touches nothing (and says why) when the agent relays to a pipe
   * other than the managed one (`custom_socket`: that daemon is not ours), when the daemon answers, when AZITO did not install it,
   * when its task is gone (the install is what recreates that), when the task starts another folder's misao (`other_task`) or when
   * it was disabled by hand (`disabled`).
   */
  async reviveDaemon(target: WindowsTarget, force: boolean): Promise<'running' | 'custom_socket' | 'not_installed' | 'no_task' | 'other_task' | 'disabled' | 'starting' | 'started'> {
    const status = await target.fetchMisaoStatus();
    const { host } = status;
    if (host.platform !== 'win32' || !host.windows) throw new MisaoServiceError('unsupported_host', `The agent reports ${host.platform}/${host.arch}, not a Windows host with its folders.`);
    if (status.socketPath !== managedEndpointOf(host)) return 'custom_socket';
    if (status.socketPresent) return 'running';
    if (!status.installedVersion) return 'not_installed';
    const tasks = new SchtasksClient(createScriptCommandSpecRunner((script, timeoutMs) => this.runScript(target, script, timeoutMs)), { systemRoot: host.windows.systemRoot });
    const state = await tasks.query(this.options.taskName);
    if (!state.exists) return 'no_task';
    const xml = await tasks.exportXml(this.options.taskName);
    const taskRoot = taskMisaoRoot(xml);
    if (!isTaskOfRoot(taskRoot, host.windows.misaoRoot)) return 'other_task';
    if (isTaskDefinitionDisabled(xml)) return 'disabled';
    if (state.running) {
      if (!force) return 'starting';
      await tasks.stop(this.options.taskName);
      const sweep = await this.runScript(target, buildEndProcessesScript({ image: 'misao.exe', argument: managedEndpointOf(host), label: 'misao', endParentConhost: false }), SCRIPT_TIMEOUT_MS);
      if (sweep.code !== 0) throw new MisaoServiceError('update_failed', `Ending the misao processes failed on the Windows host (exit ${sweep.code}): ${redactSecretText(powershellErrorText(sweep.stderr) || sweep.stdout.trim()).slice(0, 600)}`);
      const deadline = Date.now() + (this.options.taskIdleTimeoutMs ?? DEFAULT_TASK_IDLE_WAIT_MS);
      for (;;) {
        const now = await tasks.query(this.options.taskName);
        if (!now.exists || !now.running) break;
        if (Date.now() >= deadline) throw new MisaoServiceError('update_failed', `The task "${this.options.taskName}" is still running after it was ended.`);
        await sleep(TASK_IDLE_POLL_MS);
      }
    }
    await tasks.start(this.options.taskName);
    return 'started';
  }

  // ── Reading the host ──

  /** Only an agent's installer asks for this check: see {@link MisaoWindowsInstallerOptions.refuseTaskOfAnotherRoot}. */
  private async refuseTaskOfAnotherRootIfAsked(session: Session): Promise<void> {
    if (this.options.refuseTaskOfAnotherRoot) await this.refuseTaskOfAnotherRoot(session);
  }

  /**
   * The task name is one per user, and the hub may be installed with its own prefix on the same machine: a task that starts a misao
   * from another folder (or one whose folder cannot be read) is another install's. Replacing it would leave that install without
   * its daemon, so nothing is changed. A missing task is the normal first install.
   */
  private async refuseTaskOfAnotherRoot(session: Session): Promise<void> {
    if (!(await session.tasks.query(this.options.taskName)).exists) return;
    const taskRoot = taskMisaoRoot(await session.tasks.exportXml(this.options.taskName));
    if (taskRoot !== undefined && isTaskOfRoot(taskRoot, session.windows.misaoRoot)) return;
    const resolved = taskRoot === undefined ? undefined : await this.resolveFolderOnHost(session, taskRoot);
    if (resolved !== undefined && resolved !== 'missing' && isTaskOfRoot(resolved, session.windows.misaoRoot)) return;
    const where = taskRoot === undefined
      ? 'a task whose misao folder cannot be read'
      : resolved === 'missing' ? `a misao task of a folder that does not exist (${taskRoot})` : `a misao task of another folder (${taskRoot})`;
    throw new MisaoServiceError('custom_socket', `The task "${this.options.taskName}" is registered as ${where}, not ${session.windows.misaoRoot}. Changing it would leave that install without its misao, so nothing was changed.`);
  }

  /**
   * The task may name the same folder in another spelling (an 8.3 short name, a junction). The agent reported its folder resolved, so the
   * task's folder is resolved by the host itself (`fs.realpath.native` in the agent's Node), never on the hub. The folder comes from the
   * task definition, so it follows `--`: a value that starts with `-` (`--require=...`) is a path to resolve, never an option of node.
   * `missing` = the folder does not exist; `undefined` = it could not be resolved.
   */
  private async resolveFolderOnHost(session: Session, taskRoot: string): Promise<string | 'missing' | undefined> {
    const script = 'try { process.stdout.write(require("fs").realpathSync.native(process.argv[1])) } catch (e) { process.exit(e.code === "ENOENT" ? 3 : 1) }';
    const spec = buildCommandSpec(session.nodePath, ['-e', script, '--', taskRoot], { timeoutMs: SCRIPT_TIMEOUT_MS, maxOutputBytes: SCRIPT_OUTPUT_BYTES });
    const result = await session.target.run(spec);
    if (result.exitCode === 3) return 'missing';
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  private async inspect(target: WindowsTarget, bundle: MisaoBundle): Promise<{ session: Session; status: MisaoSocketStatus }> {
    let status: MisaoSocketStatus;
    try {
      status = await target.fetchMisaoStatus();
    } catch (err) {
      throw new MisaoServiceError('unsupported_host', `Could not read the agent's misao status (an agent older than this hub has no such route: update the agent first): ${describeError(err)}`);
    }
    const { host } = status;
    if (host.platform !== 'win32' || !host.windows) {
      throw new MisaoServiceError('unsupported_host', `This agent server is registered as a Windows host but the agent reports ${host.platform}/${host.arch}${host.platform === 'win32' ? ' without its Windows folders (update the agent)' : ''}.`);
    }
    const files = bundleFilesFor(bundle, host.platform, host.arch);
    const pipe = managedEndpointOf(host);
    if (status.socketPath !== pipe) {
      throw new MisaoServiceError('custom_socket', `The agent relays to ${status.socketPath}, not the managed pipe ${pipe}. Installing the managed service would leave it unused; unset MISAO_SOCKET in the agent's environment first.`);
    }
    const session: Session = {
      target,
      windows: host.windows,
      homeDir: host.homeDir,
      nodePath: host.nodePath,
      pipe,
      bundle,
      files,
      tasks: new SchtasksClient(createScriptCommandSpecRunner((script, timeoutMs) => this.runScript(target, script, timeoutMs)), { systemRoot: host.windows.systemRoot }),
    };
    return { session, status };
  }

  private layout(session: Session, version: string): MisaoWindowsLayout {
    return misaoWindowsLayout(session.windows, version, this.options.taskName);
  }

  /** Runs a PowerShell script on the host through the agent (no shell: `powershell.exe -EncodedCommand`). */
  private async runScript(target: WindowsTarget, script: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
    const spec = buildCommandSpec('powershell.exe', powershellEncodedArgs(`$ProgressPreference = 'SilentlyContinue'\n${script}`), { timeoutMs, maxOutputBytes: SCRIPT_OUTPUT_BYTES });
    const result = await target.run(spec);
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
  }

  /** A script whose failure is an error carrying the script's own message. */
  private async script(session: Session, what: string, body: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<string> {
    const result = await this.runScript(session.target, body, timeoutMs);
    if (result.code !== 0) {
      const reason = powershellErrorText(result.stderr) || result.stdout.trim();
      throw new MisaoServiceError('transfer_failed', `${what} failed on the Windows host (exit ${result.code})${reason ? `: ${redactSecretText(reason).slice(0, 600)}` : ''}`);
    }
    return result.stdout;
  }

  /** The task definition for `version`: needs the account the task runs as, read from the host before anything is changed. */
  private async buildTask(session: Session, version: string): Promise<string> {
    const out = await this.script(session, 'Reading the account the misao task runs as', "[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([System.Security.Principal.WindowsIdentity]::GetCurrent().Name))");
    const userId = Buffer.from(out.trim(), 'base64').toString('utf8');
    if (userId === '') throw new MisaoServiceError('transfer_failed', 'The host did not tell which account the agent runs as.');
    try {
      return buildMisaoTaskXml({ userId, systemRoot: session.windows.systemRoot, homeDir: session.homeDir, layout: this.layout(session, version), pipe: session.pipe });
    } catch (err) {
      throw new MisaoServiceError('unsupported_host', `This host's folders cannot be used in the misao task: ${describeError(err)}`);
    }
  }

  // ── Putting the release on the host ──

  /** The misao folder exists and is owner-only, and the bundled release's directory is on the host (transferred unless it is already there, whole). */
  private async ensureVersion(session: Session, onProgress: (step: MisaoInstallStep) => void): Promise<void> {
    const q = powershellDialect.quote;
    const layout = this.layout(session, session.bundle.version);
    await this.script(session, 'Preparing the misao folder', [
      `New-Item -ItemType Directory -Force -Path ${q(layout.root)} | Out-Null`,
      `$env:AZITO_GUARD_PATH = ${q(layout.root)}`,
      PROTECT_SCRIPT,
    ].join('\n'));
    if (await this.hasVersion(session, layout)) return;
    onProgress('transfer');
    await this.transfer(session);
    onProgress('prepare');
    await this.finalize(session, layout);
  }

  /** Every release file of the version folder is there and is the bundled one: no need to transfer it again. */
  private async hasVersion(session: Session, layout: MisaoWindowsLayout): Promise<boolean> {
    const q = powershellDialect.quote;
    const out = await this.script(session, 'Checking the misao release on the host', [
      'function Get-Sha256($file) {',
      '  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return \'-\' }',
      '  $stream = [System.IO.File]::OpenRead($file)',
      '  try { $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($stream) } finally { $stream.Dispose() }',
      "  [System.BitConverter]::ToString($hash).Replace('-', '').ToLower()",
      '}',
      `foreach ($file in @(${misaoWindowsReleasePaths(layout.versionDir).map(q).join(', ')})) { Get-Sha256 $file }`,
    ].join('\n'));
    const expected = MISAO_RELEASE_FILE_NAMES.map((name) => session.files.sha256[name]);
    return out.trim().split(/\r?\n/).map((line) => line.trim()).join('\n') === expected.join('\n');
  }

  private async transfer(session: Session): Promise<void> {
    const { bundle, files, target } = session;
    for (const name of MISAO_RELEASE_FILE_NAMES) {
      const data = fs.readFileSync(files.files[name]);
      // The bundle was verified when it was read; this also catches a file changed on disk since.
      if (sha256Buffer(data) !== files.sha256[name]) {
        throw new MisaoServiceError('transfer_failed', `The bundled ${name} no longer matches its manifest sha256; not sending it.`);
      }
      let received: { size: number; sha256: string };
      try {
        received = await target.uploadMisaoFile(bundle.version, name, data);
      } catch (err) {
        throw new MisaoServiceError('transfer_failed', `Sending ${name} to the agent failed: ${describeError(err)}`);
      }
      if (received.sha256 !== files.sha256[name] || received.size !== data.length) {
        throw new MisaoServiceError('transfer_failed', `${name} arrived damaged: expected ${files.sha256[name]} (${data.length} bytes), the agent received ${received.sha256} (${received.size} bytes).`);
      }
    }
  }

  /** Moves the staged release into place as `<root>\<version>`. An older release's folder is not touched. */
  private async finalize(session: Session, layout: MisaoWindowsLayout): Promise<void> {
    const q = powershellDialect.quote;
    const staged = misaoWindowsReleasePaths(layout.stageDir);
    await this.script(session, 'Preparing misao on the agent', [
      `foreach ($file in @(${staged.map(q).join(', ')})) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'the staged release files are missing' } }`,
      `if (Test-Path -LiteralPath ${q(layout.versionDir)}) { Remove-Item -LiteralPath ${q(layout.versionDir)} -Recurse -Force }`,
      `Move-Item -LiteralPath ${q(layout.stageDir)} -Destination ${q(layout.versionDir)}`,
    ].join('\n'));
  }

  // ── The task and the marker ──

  /** The task definition and the release `current` names, as they are now. */
  private async snapshot(session: Session, installedVersion: string | undefined): Promise<PreviousInstall> {
    const previous: PreviousInstall = { ...(installedVersion ? { version: installedVersion } : {}) };
    const state = await session.tasks.query(this.options.taskName);
    if (state.exists) previous.taskXml = await session.tasks.exportXml(this.options.taskName);
    return previous;
  }

  private async writeCurrent(session: Session, version: string): Promise<void> {
    await session.target.files().write(this.layout(session, version).currentFile, Buffer.from(`${version}\n`, 'utf8'));
  }

  /** Registers the task from XML the agent writes beside the install (the XML holds no secret), and removes the file afterwards. */
  private async registerXml(session: Session, xml: string): Promise<void> {
    const file = this.layout(session, session.bundle.version).taskXmlFile;
    const files = session.target.files();
    await files.write(file, encodeTaskXml(xml));
    try {
      await session.tasks.registerFromFile(this.options.taskName, file);
    } finally {
      await files.remove(file).catch(() => undefined);
    }
  }

  /** Writes `current`, registers the task for the bundled release and starts it; the daemon must be listening when this returns. */
  private async switchAndStart(session: Session, xml: string): Promise<void> {
    await this.writeCurrent(session, session.bundle.version);
    await this.registerXml(session, xml);
    await session.tasks.start(this.options.taskName);
    await this.waitUntilListening(session);
    await this.verifyRelease(session, session.bundle.version);
  }

  /** The pipe being open does not say whose daemon it is: the program running behind it must be the release's own `misao.exe`. */
  private async verifyRelease(session: Session, version: string): Promise<void> {
    const out = await this.script(session, 'Checking which misao is running', daemonCheckScript(session.pipe, this.layout(session, version).exe));
    const check = parseDaemonCheck(out);
    if (!sameProgram(check)) {
      throw new MisaoServiceError('daemon_not_ready', `The pipe ${session.pipe} answers, but the program behind it is ${check.actual}, not ${check.expected}.`);
    }
  }

  // ── Stopping ──

  private async isListening(session: Session): Promise<boolean> {
    return (await session.target.fetchMisaoStatus()).socketPresent;
  }

  private async waitUntilStopped(session: Session): Promise<boolean> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 8;
    do {
      if (!(await this.isListening(session))) return true;
      await sleep(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    } while (Date.now() < deadline);
    return !(await this.isListening(session));
  }

  /** Ends the task if it is running and every `misao.exe` of this pipe that is left (a daemon the task no longer owns). */
  private async endTaskAndProcesses(session: Session): Promise<void> {
    const state = await session.tasks.query(this.options.taskName);
    if (state.exists && state.running) await session.tasks.stop(this.options.taskName);
    await this.script(session, 'Ending the misao processes', buildEndProcessesScript({ image: 'misao.exe', argument: session.pipe, label: 'misao', endParentConhost: false }));
  }

  /**
   * Stops the daemon on this server's pipe (it closes every pane before exiting) and waits until the pipe no longer answers and
   * the task is no longer running. In order, each only if the pipe still answers: `misao stop` of the release named `binaryVersion`
   * (through the pipe; the daemon exits with code 0, so the task is not restarted), then the Task Scheduler's End plus a sweep of
   * the `misao.exe` processes of this user whose command line names this exact pipe. Throws when it still answers.
   */
  private async stopDaemonProcess(session: Session, binaryVersion: string | undefined): Promise<void> {
    if (!(await this.isListening(session))) return;
    if (binaryVersion !== undefined) {
      const stop = buildCommandSpec(this.layout(session, binaryVersion).exe, ['stop'], { env: { MISAO_SOCKET: session.pipe }, timeoutMs: STOP_COMMAND_TIMEOUT_MS, maxOutputBytes: SCRIPT_OUTPUT_BYTES });
      await session.target.run(stop).catch(() => undefined);
    }
    if (await this.waitUntilStopped(session)) return;
    await this.endTaskAndProcesses(session);
    if (!(await this.waitUntilStopped(session))) {
      throw new MisaoServiceError('update_failed', `The misao daemon on ${session.pipe} did not stop. Nothing was changed.`);
    }
  }

  private async taskIsRunning(session: Session): Promise<boolean> {
    const state = await session.tasks.query(this.options.taskName);
    return state.exists && state.running;
  }

  /** `schtasks /Run` does nothing while the previous instance of the task is still running (a clean exit leaves it for a moment). */
  private async waitUntilTaskIdle(session: Session): Promise<void> {
    const idleWaitMs = this.options.taskIdleTimeoutMs ?? DEFAULT_TASK_IDLE_WAIT_MS;
    const deadline = Date.now() + idleWaitMs;
    for (;;) {
      const state = await session.tasks.query(this.options.taskName);
      if (!state.exists || !state.running) return;
      if (Date.now() >= deadline) break;
      await sleep(TASK_IDLE_POLL_MS);
    }
    await this.endTaskAndProcesses(session);
    const state = await session.tasks.query(this.options.taskName);
    if (state.exists && state.running) {
      throw new MisaoServiceError('update_failed', `The task "${this.options.taskName}" is still running ${idleWaitMs / 1000}s after the daemon stopped and it could not be ended.`);
    }
  }

  private async waitUntilListening(session: Session): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (await this.isListening(session)) return;
      await sleep(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }
    const task = await this.describeTask(session);
    throw new MisaoServiceError('daemon_not_ready', `The misao daemon was started but its pipe ${session.pipe} is not accepting connections yet (${task}). Check ${this.layout(session, session.bundle.version).logFile} on the agent host.`);
  }

  private async describeTask(session: Session): Promise<string> {
    try {
      const state = await session.tasks.query(this.options.taskName);
      if (!state.exists) return `the task "${this.options.taskName}" is not registered`;
      return state.running
        ? `the task "${this.options.taskName}" is running`
        : `the task "${this.options.taskName}" is not running, last result 0x${state.lastResult.toString(16)}`;
    } catch (err) {
      return `the state of the task "${this.options.taskName}" could not be read: ${describeError(err)}`;
    }
  }

  // ── Putting the previous install back ──

  /**
   * Stops whatever the failed switch started, then puts the previous `current` file and task definition back (or, when there
   * was none, removes what this switch made). If the daemon cannot be confirmed stopped, nothing is put back (a task or marker
   * changed under a running daemon is not a recovery) and that is what is reported. Returns what could not be done (empty when
   * everything was).
   */
  private async restore(session: Session, previous: PreviousInstall): Promise<string[]> {
    try {
      await this.stopDaemonProcess(session, session.bundle.version);
    } catch (err) {
      return [`stopping the daemon on ${session.pipe}: ${describeError(err)}`];
    }
    // The task ignores a start while it is running (IgnoreNew): the previous release is only put back and started once it is known to be stopped.
    try {
      await this.waitUntilTaskIdle(session);
    } catch (err) {
      return [`the task "${this.options.taskName}" did not stop: ${describeError(err)}`];
    }
    const failed: string[] = [];
    const attempt = async (what: string, action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
      } catch (err) {
        failed.push(`${what}: ${describeError(err)}`);
      }
    };
    const current = this.layout(session, session.bundle.version).currentFile;
    if (previous.version !== undefined) await attempt(`the file ${current}`, () => this.writeCurrent(session, previous.version!));
    else await attempt(`removing the file ${current}`, () => session.target.files().remove(current).catch(() => undefined));
    if (previous.taskXml !== undefined) {
      const xml = previous.taskXml;
      await attempt(`the task "${this.options.taskName}"`, () => this.registerXml(session, xml));
    } else {
      await attempt(`removing the task "${this.options.taskName}"`, async () => {
        if ((await session.tasks.query(this.options.taskName)).exists) await session.tasks.delete(this.options.taskName);
      });
    }
    return failed;
  }

  private manualRestore(session: Session, previous: PreviousInstall): string {
    const layout = this.layout(session, session.bundle.version);
    const steps = [
      `make sure no daemon answers on ${session.pipe} (\`schtasks /End /TN ${this.options.taskName}\`, or end the misao.exe whose command line names that pipe)`,
      previous.version !== undefined ? `write "${previous.version}" into ${layout.currentFile}` : undefined,
      previous.taskXml !== undefined ? `register the previous task definition again (\`schtasks /Create /XML <file> /TN ${this.options.taskName} /F\`)` : undefined,
    ].filter((step) => step !== undefined);
    return `To restore the previous release by hand on the agent host: ${steps.join('; ')}.`;
  }

  /** The first install failed: put an older install back as it was, or remove what this one made. The failure is reported either way (the caller rethrows it). */
  private async undoFailedInstall(cause: unknown, session: Session, previous: PreviousInstall): Promise<void> {
    const failed = await this.restore(session, previous);
    if (failed.length === 0) return;
    throw new MisaoServiceError('update_failed', `Installing misao ${session.bundle.version} failed (${describeError(cause)}) and putting the previous state back failed too (could not restore: ${failed.join('; ')}). ${this.manualRestore(session, previous)}`);
  }

  /**
   * The switch failed after the old daemon was stopped (its panes are gone). Stop whatever the new release started, put the
   * previous file and task back, and start the previous release again; then report the failure either way: the update did not happen.
   */
  private async recoverFromFailedUpdate(cause: unknown, session: Session, previous: PreviousInstall, previousVersion: string, wasRunning: boolean, whileStopping: boolean): Promise<never> {
    const bundledVersion = session.bundle.version;
    const causeText = describeError(cause);
    const manual = this.manualRestore(session, previous);
    if (whileStopping) {
      // Nothing was switched yet. Look at the daemon again instead of assuming: it may have stopped before the step that failed.
      const listening = await this.isListening(session).then((up) => up, () => undefined);
      if (listening === true) {
        throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion} failed (${causeText}). The previous release ${previousVersion} is still running and nothing was changed.`);
      }
      if (listening === undefined) {
        throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion} failed (${causeText}), and whether the daemon on ${session.pipe} is still running could not be confirmed. The task definition and ${session.windows.misaoRoot} were not changed.`);
      }
    }
    try {
      const failed = await this.restore(session, previous);
      if (failed.length > 0) throw new Error(`could not restore: ${failed.join('; ')}`);
      if (wasRunning) {
        await session.tasks.start(this.options.taskName);
        await this.waitUntilListening(session);
        await this.verifyRelease(session, previousVersion);
      }
    } catch (restoreErr) {
      throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion} failed (${causeText}) and restoring ${previousVersion} failed too (${describeError(restoreErr)}). misao is not running on this server and every pane has ended. ${manual}`);
    }
    throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion} failed (${causeText}). The previous release ${previousVersion} was restored${wasRunning ? ' and started; its panes had already ended' : ''}.`);
  }
}
