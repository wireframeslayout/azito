import * as path from 'path';
import type { ExecResult } from '../transport/ServerTransport';
import { CREATE_SCRIPT, INSPECT_SCRIPT, PROTECT_SCRIPT, evaluateAcl, parseAclSnapshot } from '../../../shared/os/windowsSecretFileGuard';
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

/**
 * A deploy that is not final yet: the previous install (task definition, settings, same-version folder, whether it was running)
 * is kept aside until {@link commit}. {@link rollback} puts it back, and starts it again if it was running, so that a failed
 * (re)install leaves the host as it was: with the settings the hub still has the token for.
 */
export interface WindowsDeployment {
  /** The new install is good: the previous one is deleted. Throws if something could not be removed (the install itself is fine). */
  commit(): Promise<void>;
  /** The new install is bad (it did not start, or did not answer): stop it and restore the previous one. Returns what it did, including anything it could not restore. */
  rollback(): Promise<string>;
}

const QUICK_MS = 60_000;
const EXTRACT_MS = 300_000;
const STOP_WAIT_MS = 20_000;
const STOP_POLL_MS = 500;
const RESTART_INTERVAL_MINUTES = 1;
const RESTART_COUNT = 999;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Where everything of one agent install lives on the host. */
export interface WindowsAgentLayout {
  /** `<home>\<dir>` (owner-only). */
  root: string;
  /** The same folder relative to the home with `/` separators, for SFTP. */
  rootRelative: string;
  versionDir: string;
  /** The version folder kept aside while a same-version reinstall is not final. */
  versionDirPrev: string;
  entry: string;
  envFile: string;
  /** The new settings, created owner-only before any content is written, then swapped in. */
  envFileNew: string;
  /** The previous settings, kept until the deploy is committed. */
  envFilePrev: string;
  logFile: string;
  tarball: string;
  extractDir: string;
  taskXml: string;
}

export function windowsAgentLayout(home: string, options: WindowsAgentOptions, version: string): WindowsAgentLayout {
  if (!SAFE_VERSION.test(version)) throw new Error(`Unsafe agent version "${version}"`);
  const root = path.win32.join(home, options.dir);
  const versionDir = path.win32.join(root, version);
  const envFile = path.win32.join(root, 'agent.env');
  return {
    root,
    rootRelative: options.dir.replace(/\\/g, '/'),
    versionDir,
    versionDirPrev: `${versionDir}.prev`,
    entry: path.win32.join(versionDir, 'azito-agent.cjs'),
    envFile,
    envFileNew: `${envFile}.new`,
    envFilePrev: `${envFile}.prev`,
    logFile: path.win32.join(root, 'agent.log'),
    tarball: path.win32.join(root, `azito-agent-${version}.tar.gz`),
    extractDir: path.win32.join(root, `.extract-${version}`),
    taskXml: path.win32.join(root, `${options.taskName}.task.xml`),
  };
}

/**
 * One dotenv value as `node --env-file` reads it back (the same as `util.parseEnv`). Double quotes are used unless the value has
 * a `"` or a literal `\n` (which Node expands only inside double quotes); then single quotes, then backticks, which are read
 * as they are. `'`, `#` and backticks in a path are therefore fine; a line break or a value that fits no quote is refused.
 */
export function quoteDotenvValue(name: string, value: string): string {
  if (value === '' || /[\r\n]/.test(value)) throw new Error(`${name} cannot be written to the agent's env file (empty, or contains a line break)`);
  if (!value.includes('"') && !value.includes('\\n')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new Error(`${name} cannot be written to the agent's env file (it contains ", ' and a backtick, or \\n together with them)`);
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
  return values.map(([name, value]) => `${name}=${quoteDotenvValue(name, value)}`).join('\n') + '\n';
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

/** What was on the host before a deploy touched it. */
interface Previous {
  /** The registered task's XML, or undefined when there was none. */
  taskXml: string | undefined;
  wasRunning: boolean;
}

/**
 * Installs, stops and restarts the agent on a Windows host over SSH, with the Task Scheduler as the service (see
 * `buildTaskXml`: it starts when the user logs on, so the agent is not running while that user is logged off). The task runs
 * `conhost.exe --headless node.exe ...`, so no console window appears on the user's desktop.
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

  /**
   * Throws with the reason and the fix when Windows Firewall would stop the hub from reaching the agent: a Block rule, or no
   * Allow rule that covers this program, port, address and the tailnet. Adds the rule when this session may (elevated).
   */
  async ensureFirewall(sshHost: string, nodePath: string, bindAddress: string): Promise<void> {
    const result = await this.sshExec(sshHost, buildFirewallCommand(this.options.port, nodePath, bindAddress), QUICK_MS);
    const problem = describeFirewallProblem(parseFirewallResult(result.stdout, result.stderr, result.code), this.options.port, nodePath, bindAddress);
    if (problem) throw new Error(problem);
  }

  /**
   * Puts the agent on the host and registers its task (the task is not started: {@link start}), as one operation that is final
   * only at {@link WindowsDeployment.commit}. The settings and the task definition are built first, so a value that cannot be
   * written fails before anything on the host is stopped. If a step fails, the previous install is restored before the error is
   * thrown.
   */
  async deploy(input: WindowsDeployInput): Promise<WindowsDeployment> {
    const layout = windowsAgentLayout(input.host.home, this.options, input.version);
    const envContent = buildAgentEnvFile({ token: input.token, bindAddress: input.bindAddress, port: this.options.port, logFile: layout.logFile });
    const taskXml = this.buildTask(input, layout);
    const client = this.schtasks(input.sshHost, input.host);
    let previous: Previous | undefined;
    const rollback = (): Promise<string> => this.restore(input, layout, client, previous);

    try {
      await this.prepareRoot(input.sshHost, layout);
      await this.transfer.putFile(input.sshHost, input.tarballPath, `${layout.rootRelative}/azito-agent-${input.version}.tar.gz`);
      await this.verifySha256(input.sshHost, layout.tarball, input.expectedSha256);
      previous = await this.capturePrevious(client);
      await this.stopTask(client);
      await this.extract(input, layout);
      await this.writeSettings(input, layout, envContent);
      await this.registerXml(input.sshHost, layout, client, taskXml);
    } catch (err) {
      const outcome = await rollback().catch((e: unknown) => `the previous install could not be restored: ${(e as Error).message}`);
      throw new Error(`${(err as Error).message} (${outcome})`);
    }
    return {
      commit: () => this.discardPrevious(input.sshHost, layout),
      rollback,
    };
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

  /**
   * The task definition: a logon task that runs `conhost.exe --headless node.exe --env-file=<settings> <entry>`. Without
   * `--headless` a console program started in the user's session gets a visible console window, and closing it ends the agent.
   * `--headless` (Windows 10 1809 and later) gives the process a console that has no window.
   */
  private buildTask(input: WindowsDeployInput, layout: WindowsAgentLayout): string {
    return buildTaskXml({
      userId: input.host.userId,
      description: 'AZITO Agent: started at logon by the AZITO hub',
      executable: path.win32.join(input.host.systemRoot, 'System32', 'conhost.exe'),
      args: ['--headless', input.nodePath, `--env-file=${layout.envFile}`, layout.entry],
      workingDirectory: layout.versionDir,
      restartOnFailure: { intervalMinutes: RESTART_INTERVAL_MINUTES, count: RESTART_COUNT },
    });
  }

  /** Reads what is registered now. A definition that cannot be read stops the deploy, before anything is changed. */
  private async capturePrevious(client: SchtasksClient): Promise<Previous> {
    const state = await client.query(this.options.taskName);
    if (!state.exists) return { taskXml: undefined, wasRunning: false };
    return { taskXml: await client.exportXml(this.options.taskName), wasRunning: state.running };
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

  /** Creates the agent's folder and makes it owner-only (files created in it inherit that); clears what a crashed earlier deploy left. */
  private async prepareRoot(sshHost: string, layout: WindowsAgentLayout): Promise<void> {
    const q = powershellDialect.quote;
    const stale = [layout.versionDirPrev, layout.envFilePrev, layout.envFileNew, layout.extractDir].map((p) => `Remove-Item -LiteralPath ${q(p)} -Recurse -Force -ErrorAction SilentlyContinue`).join('\n');
    await this.script(sshHost, 'Preparing the agent folder', `New-Item -ItemType Directory -Force -Path ${q(layout.root)} | Out-Null\n${stale}\n$env:AZITO_GUARD_PATH = ${q(layout.root)}\n${PROTECT_SCRIPT}`);
  }

  private async verifySha256(sshHost: string, file: string, expected: string): Promise<void> {
    const q = powershellDialect.quote;
    // .NET directly, not Get-FileHash: that cmdlet comes from a module, and a session whose PSModulePath belongs to another PowerShell (7) cannot load it.
    const out = await this.script(sshHost, 'Computing the SHA256 of the uploaded bundle', [
      `$stream = [System.IO.File]::OpenRead(${q(file)})`,
      'try { $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($stream) } finally { $stream.Dispose() }',
      '[System.BitConverter]::ToString($hash).Replace(\'-\', \'\').ToLower()',
    ].join('\n'));
    const actual = /\b[0-9a-f]{64}\b/.exec(out)?.[0];
    if (actual !== expected) {
      await this.script(sshHost, 'Removing the bundle', `Remove-Item -LiteralPath ${q(file)} -Force`).catch(() => undefined);
      throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual ?? 'nothing readable'}`);
    }
  }

  /**
   * `tar.exe` (in Windows since 10 1803) unpacks into a scratch folder first; the version folder appears only when that worked.
   * A folder of the same version is moved aside (not deleted) until the deploy is committed.
   */
  private async extract(input: WindowsDeployInput, layout: WindowsAgentLayout): Promise<void> {
    const q = powershellDialect.quote;
    const tar = path.win32.join(input.host.systemRoot, 'System32', 'tar.exe');
    await this.script(input.sshHost, 'Extracting the agent bundle', [
      `$tar = ${q(tar)}`,
      `$tgz = ${q(layout.tarball)}`,
      `$tmp = ${q(layout.extractDir)}`,
      `$dest = ${q(layout.versionDir)}`,
      `$prev = ${q(layout.versionDirPrev)}`,
      // An archive path that leaves the folder (.., an absolute path, a drive) is refused before anything is written.
      '$bad = @(& $tar -tzf $tgz | Where-Object { $_ -match \'(^|[\\\\/])\\.\\.([\\\\/]|$)\' -or $_ -match \'^([\\\\/]|[A-Za-z]:)\' })',
      'if ($LASTEXITCODE -ne 0) { throw "tar could not list the bundle (exit $LASTEXITCODE)" }',
      'if ($bad.Count -gt 0) { throw "The bundle has an unsafe path: $($bad[0])" }',
      'if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }',
      'New-Item -ItemType Directory -Path $tmp | Out-Null',
      '& $tar -xzf $tgz -C $tmp',
      'if ($LASTEXITCODE -ne 0) { throw "tar could not extract the bundle (exit $LASTEXITCODE)" }',
      'if (Test-Path -LiteralPath $dest) { Move-Item -LiteralPath $dest -Destination $prev }',
      'Move-Item -LiteralPath $tmp -Destination $dest',
      'Remove-Item -LiteralPath $tgz -Force',
    ].join('\n'), EXTRACT_MS);
  }

  /**
   * The settings file is created owner-only (exclusively, with the protected ACL set at creation) BEFORE the token is written
   * into it, the token is written over SFTP into that file, its ACL is checked, and only then does it replace `agent.env`
   * (rename: the ACL travels with the file). An existing `agent.env`, whatever its ACL, is never written to; it is kept as
   * `agent.env.prev` until the deploy is committed.
   */
  private async writeSettings(input: WindowsDeployInput, layout: WindowsAgentLayout, content: string): Promise<void> {
    const q = powershellDialect.quote;
    await this.script(input.sshHost, 'Creating the owner-only agent settings file', `$env:AZITO_GUARD_PATH = ${q(layout.envFileNew)}\nRemove-Item -LiteralPath $env:AZITO_GUARD_PATH -Force -ErrorAction SilentlyContinue\n${CREATE_SCRIPT}`);
    await this.transfer.putBuffer(input.sshHost, Buffer.from(content, 'utf8'), `${layout.rootRelative}/agent.env.new`);
    const inspected = await this.script(input.sshHost, 'Checking the access rights of the agent settings file', `$env:AZITO_GUARD_PATH = ${q(layout.envFileNew)}\n${INSPECT_SCRIPT}`);
    const verdict = evaluateAcl(parseAclSnapshot(inspected.trim()), layout.envFileNew, 'file');
    if (!verdict.ok) throw new Error(`The agent settings file on the host is readable by others: ${verdict.summary} Fix: ${verdict.fix}`);
    await this.script(input.sshHost, 'Replacing the agent settings file', [
      `if (Test-Path -LiteralPath ${q(layout.envFile)}) { Move-Item -LiteralPath ${q(layout.envFile)} -Destination ${q(layout.envFilePrev)} -Force }`,
      `Move-Item -LiteralPath ${q(layout.envFileNew)} -Destination ${q(layout.envFile)}`,
    ].join('\n'));
  }

  /** Registers a task from XML sent over SFTP; the XML (it holds no secret) is removed afterwards. */
  private async registerXml(sshHost: string, layout: WindowsAgentLayout, client: SchtasksClient, xml: string): Promise<void> {
    const q = powershellDialect.quote;
    await this.transfer.putBuffer(sshHost, encodeTaskXml(xml), `${layout.rootRelative}/${this.options.taskName}.task.xml`);
    try {
      await client.registerFromFile(this.options.taskName, layout.taskXml);
    } finally {
      await this.script(sshHost, 'Removing the task definition file', `Remove-Item -LiteralPath ${q(layout.taskXml)} -Force -ErrorAction SilentlyContinue`).catch(() => undefined);
    }
  }

  /** Deletes what a committed deploy no longer needs: the previous settings and the previous same-version folder. */
  private async discardPrevious(sshHost: string, layout: WindowsAgentLayout): Promise<void> {
    const q = powershellDialect.quote;
    await this.script(sshHost, 'Removing the previous install', [layout.envFilePrev, layout.versionDirPrev].map((p) => `if (Test-Path -LiteralPath ${q(p)}) { Remove-Item -LiteralPath ${q(p)} -Recurse -Force }`).join('\n'));
  }

  /**
   * Puts the host back as it was before the deploy, in this order: stop whatever is running now; restore the folder and the
   * settings that were moved aside; delete the temporary files; put the previous task definition back (or delete the task if
   * there was none); start the task again if it was running. A step that fails does not stop the others; what could not be
   * restored is in the returned text.
   */
  private async restore(input: WindowsDeployInput, layout: WindowsAgentLayout, client: SchtasksClient, previous: Previous | undefined): Promise<string> {
    const q = powershellDialect.quote;
    const done: string[] = [];
    const problems: string[] = [];
    const attempt = async (what: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
        done.push(what);
      } catch (err) {
        problems.push(`${what} failed: ${(err as Error).message}`);
      }
    };

    // Nothing was touched before the capture: only the temporary files are removed.
    if (previous !== undefined) {
      await attempt('stopped the new agent', () => this.stopTask(client));
      await attempt('restored the previous files', async () => {
        await this.script(input.sshHost, 'Restoring the previous files', [
          `if (Test-Path -LiteralPath ${q(layout.versionDirPrev)}) { if (Test-Path -LiteralPath ${q(layout.versionDir)}) { Remove-Item -LiteralPath ${q(layout.versionDir)} -Recurse -Force }; Move-Item -LiteralPath ${q(layout.versionDirPrev)} -Destination ${q(layout.versionDir)} }`,
          `if (Test-Path -LiteralPath ${q(layout.envFilePrev)}) { if (Test-Path -LiteralPath ${q(layout.envFile)}) { Remove-Item -LiteralPath ${q(layout.envFile)} -Force }; Move-Item -LiteralPath ${q(layout.envFilePrev)} -Destination ${q(layout.envFile)} }`,
        ].join('\n'));
      });
    }
    await attempt('removed the temporary files', async () => {
      await this.script(input.sshHost, 'Removing the temporary files', [layout.tarball, layout.extractDir, layout.taskXml, layout.envFileNew].map((p) => `Remove-Item -LiteralPath ${q(p)} -Recurse -Force -ErrorAction SilentlyContinue`).join('\n'));
    });
    if (previous !== undefined) {
      if (previous.taskXml !== undefined) {
        const xml = previous.taskXml;
        await attempt('restored the previous task definition', () => this.registerXml(input.sshHost, layout, client, xml));
        if (previous.wasRunning) await attempt('started the previous agent again', () => client.start(this.options.taskName));
      } else {
        await attempt('removed the new task', async () => {
          if ((await client.query(this.options.taskName)).exists) await client.delete(this.options.taskName);
        });
      }
    }
    return [...(previous === undefined ? ['nothing on the host had been changed'] : done), ...problems].join('; ');
  }
}

function describeState(taskName: string, state: TaskScheduleState): string {
  if (!state.exists) return `the task "${taskName}" is not registered`;
  const result = `0x${state.lastResult.toString(16)}`;
  return state.running
    ? `the task "${taskName}" is running (the agent process started but did not answer)`
    : `the task "${taskName}" is not running (last result ${result}${state.lastResult === 0x8004130f ? ': the user is not logged on, the agent starts at logon' : ''})`;
}
