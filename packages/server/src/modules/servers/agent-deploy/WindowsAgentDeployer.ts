import * as path from 'path';
import type { ExecResult } from '../transport/ServerTransport';
import { INSPECT_SCRIPT, PROTECT_SCRIPT, evaluateAcl, parseAclSnapshot } from '../../../shared/os/windowsSecretFileGuard';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { SchtasksClient, type TaskScheduleState } from '../../../shared/os/taskScheduler/schtasks';
import { buildTaskXml, encodeTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { redactSecretText } from '../../../shared/redactSecretText';
import { createSshCommandSpecRunner } from './windowsSshRunner';
import { buildFirewallCommand, describeFirewallProblem, parseFirewallResult } from './windowsFirewall';
import type { WindowsAgentOptions } from './windowsAgentConfig';
import type { WindowsPreflightInfo } from './windowsPreflight';

/** Runs one command line on the Windows host through its SSH login shell. */
export type WindowsSshExec = (sshHost: string, command: string, timeoutMs: number) => Promise<ExecResult>;

/** Puts bytes on the host over SFTP. The remote path is relative to the user's home, with `/` separators (what Windows OpenSSH's sftp-server takes). */
export interface WindowsFileTransfer {
  putFile(sshHost: string, localPath: string, remoteRelativePath: string): Promise<void>;
  putBuffer(sshHost: string, data: Buffer, remoteRelativePath: string): Promise<void>;
}

/** What a deploy needs, all resolved by the caller (the hub's entry points and the preflight). */
export interface WindowsDeployInput {
  sshHost: string;
  host: WindowsPreflightInfo;
  /** The `node.exe` the preflight found; the task starts the agent with it. */
  nodePath: string;
  version: string;
  tarballPath: string;
  expectedSha256: string;
  token: string;
  bindAddress: string;
}

const QUICK_MS = 60_000;
const EXTRACT_MS = 300_000;
const STOP_WAIT_MS = 20_000;
const STOP_POLL_MS = 500;
const RESTART_INTERVAL_MINUTES = 1;
const RESTART_COUNT = 999;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A character that would end or change a dotenv value (the agent's settings are read by `node --env-file`). */
const UNSAFE_ENV_VALUE = /[\r\n"'`#]/;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Where everything of one agent install lives on the host. */
export interface WindowsAgentLayout {
  /** `<home>\<dir>` (owner-only). */
  root: string;
  /** The same folder relative to the home with `/` separators, for SFTP. */
  rootRelative: string;
  versionDir: string;
  entry: string;
  envFile: string;
  logFile: string;
  tarball: string;
  extractDir: string;
  taskXml: string;
}

export function windowsAgentLayout(home: string, options: WindowsAgentOptions, version: string): WindowsAgentLayout {
  if (!SAFE_VERSION.test(version)) throw new Error(`Unsafe agent version "${version}"`);
  const root = path.win32.join(home, options.dir);
  const versionDir = path.win32.join(root, version);
  return {
    root,
    rootRelative: options.dir.replace(/\\/g, '/'),
    versionDir,
    entry: path.win32.join(versionDir, 'azito-agent.cjs'),
    envFile: path.win32.join(root, 'agent.env'),
    logFile: path.win32.join(root, 'agent.log'),
    tarball: path.win32.join(root, `azito-agent-${version}.tar.gz`),
    extractDir: path.win32.join(root, `.extract-${version}`),
    taskXml: path.win32.join(root, `${options.taskName}.task.xml`),
  };
}

/** The agent's settings, the file `node --env-file` reads (the same values the Unix install passes through its unit / nohup environment). */
export function buildAgentEnvFile(env: { token: string; bindAddress: string; port: number; logFile: string }): string {
  const values: Array<[string, string]> = [
    ['AZITO_AGENT_TOKEN', env.token],
    ['AZITO_AGENT_BIND', env.bindAddress],
    ['PORT', String(env.port)],
    // A task has nowhere to send the agent's output: the agent writes its log to this file itself.
    ['AZITO_AGENT_LOG_FILE', env.logFile],
  ];
  for (const [name, value] of values) {
    if (value === '' || UNSAFE_ENV_VALUE.test(value)) throw new Error(`${name} cannot be written to the agent's env file (empty, or contains a quote, "#" or a line break)`);
  }
  return values.map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
}

/**
 * The text a failed PowerShell run left on stderr. Under -EncodedCommand with a redirected stderr, PowerShell serializes errors
 * as CLIXML (`#< CLIXML` + `<S S="Error">…</S>` parts, line breaks as `_x000D__x000A_`); the readable messages are taken out.
 */
export function powershellErrorText(stderr: string): string {
  if (!stderr.includes('#< CLIXML')) return stderr.trim();
  const parts = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]!);
  const text = parts.join('').replace(/_x000D__x000A_|_x000A_/g, '\n').replace(/_x000D_/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return text.trim();
}

/**
 * Installs, stops and restarts the agent on a Windows host over SSH, with the Task Scheduler as the service (see
 * `buildTaskXml`: it starts when the user logs on, so the agent is not running while that user is logged off).
 *
 * Everything the host runs is a PowerShell script sent as an EncodedCommand (the same under a cmd.exe and a PowerShell login
 * shell), or `schtasks.exe` through `SchtasksClient`. Files go over SFTP.
 */
export class WindowsAgentDeployer {
  constructor(
    private readonly sshExec: WindowsSshExec,
    private readonly transfer: WindowsFileTransfer,
    private readonly options: WindowsAgentOptions,
  ) {}

  /** Throws with the reason and the fix when Windows Firewall would block the hub from reaching the agent's port. Adds the rule when this session may (elevated). */
  async ensureFirewall(sshHost: string, nodePath: string): Promise<void> {
    const result = await this.sshExec(sshHost, buildFirewallCommand(this.options.port, nodePath), QUICK_MS);
    const problem = describeFirewallProblem(parseFirewallResult(result.stdout, result.stderr, result.code), this.options.port);
    if (problem) throw new Error(problem);
  }

  /**
   * Puts the agent on the host and registers its task (the task is not started: {@link start}). The task of an earlier install is
   * stopped first, because its files are in use. On failure the temporary files are removed and the error is thrown.
   */
  async deploy(input: WindowsDeployInput): Promise<void> {
    const layout = windowsAgentLayout(input.host.home, this.options, input.version);
    const client = this.schtasks(input.sshHost, input.host);
    try {
      await this.prepareRoot(input.sshHost, layout);
      await this.transfer.putFile(input.sshHost, input.tarballPath, `${layout.rootRelative}/azito-agent-${input.version}.tar.gz`);
      await this.verifySha256(input.sshHost, layout.tarball, input.expectedSha256);
      await this.stopTask(client);
      await this.extract(input, layout);
      await this.writeSettings(input, layout);
      await this.registerTask(input, layout, client);
    } catch (err) {
      await this.removeTemporary(input.sshHost, layout).catch(() => undefined);
      throw err;
    }
  }

  async start(sshHost: string, host: WindowsPreflightInfo): Promise<void> {
    await this.schtasks(sshHost, host).start(this.options.taskName);
  }

  /** Stops the task if it is running and waits until it is not (`/End` returns before the process is gone). */
  async stop(sshHost: string, host: WindowsPreflightInfo): Promise<void> {
    await this.stopTask(this.schtasks(sshHost, host));
  }

  /** Stops and starts the registered task. A task that is not registered is an error (nothing is installed to restart). */
  async restart(sshHost: string, host: WindowsPreflightInfo): Promise<void> {
    const client = this.schtasks(sshHost, host);
    const state = await client.query(this.options.taskName);
    if (!state.exists) throw new Error(`The task "${this.options.taskName}" is not registered on the host: install the agent first`);
    await this.stopTask(client);
    await client.start(this.options.taskName);
  }

  /** What the Task Scheduler says about the task, for the message of a health check that failed. */
  async describeTask(sshHost: string, host: WindowsPreflightInfo): Promise<string> {
    try {
      return describeState(this.options.taskName, await this.schtasks(sshHost, host).query(this.options.taskName));
    } catch (err) {
      return `the state of the task "${this.options.taskName}" could not be read (${(err as Error).message})`;
    }
  }

  private schtasks(sshHost: string, host: Pick<WindowsPreflightInfo, 'systemRoot'>): SchtasksClient {
    return new SchtasksClient(createSshCommandSpecRunner((command, timeoutMs) => this.sshExec(sshHost, command, timeoutMs)), { systemRoot: host.systemRoot });
  }

  private async stopTask(client: SchtasksClient): Promise<void> {
    const taskName = this.options.taskName;
    let state = await client.query(taskName);
    if (!state.exists || !state.running) return;
    await client.stop(taskName);
    const deadline = Date.now() + STOP_WAIT_MS;
    while (state.exists && state.running) {
      if (Date.now() >= deadline) throw new Error(`The task "${taskName}" is still running ${STOP_WAIT_MS / 1000}s after it was stopped`);
      await sleep(STOP_POLL_MS);
      state = await client.query(taskName);
    }
  }

  /** Runs a PowerShell script on the host; a non-zero exit is an error carrying the script's own message. */
  private async script(sshHost: string, what: string, body: string, timeoutMs = QUICK_MS): Promise<string> {
    const result = await this.sshExec(sshHost, powershellDialect.wrapScript(`$ProgressPreference = 'SilentlyContinue'\n${body}`), timeoutMs);
    if (result.code !== 0) {
      const reason = powershellErrorText(result.stderr) || result.stdout.trim();
      throw new Error(`${what} failed on the Windows host (exit ${result.code})${reason ? `: ${redactSecretText(reason).slice(0, 600)}` : ''}`);
    }
    return result.stdout;
  }

  /** Creates the agent's folder and makes it owner-only (files created in it inherit that: the settings file holds the token). */
  private async prepareRoot(sshHost: string, layout: WindowsAgentLayout): Promise<void> {
    const q = powershellDialect.quote;
    await this.script(sshHost, 'Preparing the agent folder', `New-Item -ItemType Directory -Force -Path ${q(layout.root)} | Out-Null\n$env:AZITO_GUARD_PATH = ${q(layout.root)}\n${PROTECT_SCRIPT}`);
  }

  private async verifySha256(sshHost: string, file: string, expected: string): Promise<void> {
    const q = powershellDialect.quote;
    const out = await this.script(sshHost, 'Computing the SHA256 of the uploaded bundle', `(Get-FileHash -LiteralPath ${q(file)} -Algorithm SHA256).Hash.ToLower()`);
    const actual = /\b[0-9a-f]{64}\b/.exec(out)?.[0];
    if (actual !== expected) {
      await this.script(sshHost, 'Removing the bundle', `Remove-Item -LiteralPath ${q(file)} -Force`).catch(() => undefined);
      throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual ?? 'nothing readable'}`);
    }
  }

  /** `tar.exe` (in Windows since 10 1803) unpacks into a scratch folder first; the version folder appears only when that worked. */
  private async extract(input: WindowsDeployInput, layout: WindowsAgentLayout): Promise<void> {
    const q = powershellDialect.quote;
    const tar = path.win32.join(input.host.systemRoot, 'System32', 'tar.exe');
    await this.script(input.sshHost, 'Extracting the agent bundle', [
      `$tar = ${q(tar)}`,
      `$tgz = ${q(layout.tarball)}`,
      `$tmp = ${q(layout.extractDir)}`,
      `$dest = ${q(layout.versionDir)}`,
      // An archive path that leaves the folder (.., an absolute path, a drive) is refused before anything is written.
      '$bad = @(& $tar -tzf $tgz | Where-Object { $_ -match \'(^|[\\\\/])\\.\\.([\\\\/]|$)\' -or $_ -match \'^([\\\\/]|[A-Za-z]:)\' })',
      'if ($LASTEXITCODE -ne 0) { throw "tar could not list the bundle (exit $LASTEXITCODE)" }',
      'if ($bad.Count -gt 0) { throw "The bundle has an unsafe path: $($bad[0])" }',
      'if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }',
      'New-Item -ItemType Directory -Path $tmp | Out-Null',
      '& $tar -xzf $tgz -C $tmp',
      'if ($LASTEXITCODE -ne 0) { throw "tar could not extract the bundle (exit $LASTEXITCODE)" }',
      'if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }',
      'Move-Item -LiteralPath $tmp -Destination $dest',
      'Remove-Item -LiteralPath $tgz -Force',
    ].join('\n'), EXTRACT_MS);
  }

  /** Writes the settings file inside the owner-only folder, then checks the file's ACL: nobody but the user may read it. */
  private async writeSettings(input: WindowsDeployInput, layout: WindowsAgentLayout): Promise<void> {
    const q = powershellDialect.quote;
    const content = buildAgentEnvFile({ token: input.token, bindAddress: input.bindAddress, port: this.options.port, logFile: layout.logFile });
    await this.transfer.putBuffer(input.sshHost, Buffer.from(content, 'utf8'), `${layout.rootRelative}/agent.env`);
    await this.script(input.sshHost, 'Restricting the agent settings file to its owner', `$env:AZITO_GUARD_PATH = ${q(layout.envFile)}\n${PROTECT_SCRIPT}`);
    const inspected = await this.script(input.sshHost, 'Checking the access rights of the agent settings file', `$env:AZITO_GUARD_PATH = ${q(layout.envFile)}\n${INSPECT_SCRIPT}`);
    const verdict = evaluateAcl(parseAclSnapshot(inspected.trim()), layout.envFile, 'file');
    if (!verdict.ok) throw new Error(`The agent settings file on the host is readable by others: ${verdict.summary} Fix: ${verdict.fix}`);
  }

  /** Registers the logon task from XML sent over SFTP; the XML (it holds no secret) is removed afterwards. */
  private async registerTask(input: WindowsDeployInput, layout: WindowsAgentLayout, client: SchtasksClient): Promise<void> {
    const q = powershellDialect.quote;
    const xml = buildTaskXml({
      userId: input.host.userId,
      description: 'AZITO Agent: started at logon by the AZITO hub',
      executable: input.nodePath,
      args: [`--env-file=${layout.envFile}`, layout.entry],
      workingDirectory: layout.versionDir,
      restartOnFailure: { intervalMinutes: RESTART_INTERVAL_MINUTES, count: RESTART_COUNT },
    });
    await this.transfer.putBuffer(input.sshHost, encodeTaskXml(xml), `${layout.rootRelative}/${this.options.taskName}.task.xml`);
    try {
      await client.registerFromFile(this.options.taskName, layout.taskXml);
    } finally {
      await this.script(input.sshHost, 'Removing the task definition file', `Remove-Item -LiteralPath ${q(layout.taskXml)} -Force -ErrorAction SilentlyContinue`).catch(() => undefined);
    }
  }

  /** What a failed deploy leaves behind that is not part of a working install: the uploaded bundle, the scratch folder, the task XML. */
  private async removeTemporary(sshHost: string, layout: WindowsAgentLayout): Promise<void> {
    const q = powershellDialect.quote;
    await this.script(sshHost, 'Cleaning up', [layout.tarball, layout.extractDir, layout.taskXml].map((p) => `Remove-Item -LiteralPath ${q(p)} -Recurse -Force -ErrorAction SilentlyContinue`).join('\n'));
  }
}

function describeState(taskName: string, state: TaskScheduleState): string {
  if (!state.exists) return `the task "${taskName}" is not registered`;
  const result = `0x${state.lastResult.toString(16)}`;
  return state.running
    ? `the task "${taskName}" is running (the agent process started but did not answer)`
    : `the task "${taskName}" is not running (last result ${result}${state.lastResult === 0x8004130f ? ': the user is not logged on, the agent starts at logon' : ''})`;
}
