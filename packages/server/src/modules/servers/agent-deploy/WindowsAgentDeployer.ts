import * as path from 'path';
import type { ExecResult } from '../transport/ServerTransport';
import { CREATE_SCRIPT, INSPECT_SCRIPT, PROTECT_SCRIPT, evaluateAcl, parseAclSnapshot } from '../../../shared/os/windowsSecretFileGuard';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { SchtasksClient, type TaskScheduleState } from '../../../shared/os/taskScheduler/schtasks';
import { buildTaskXml, encodeTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { redactSecretText } from '../../../shared/redactSecretText';
import { createSshCommandSpecRunner } from './windowsSshRunner';
import { checkFirewall, describeFirewallProblem } from './windowsFirewall';
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
const FIREWALL_MS = 120_000;
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

/** `<home>\<dir>`: the folder everything of this agent install lives in. */
export function windowsAgentRoot(home: string, options: WindowsAgentOptions): string {
  return path.win32.join(home, options.dir);
}

/** The settings file of the install in `<home>\<dir>`; the task, the agent folder and the process sweep all name it. */
export function windowsAgentEnvFile(home: string, options: WindowsAgentOptions): string {
  return path.win32.join(windowsAgentRoot(home, options), 'agent.env');
}

export function windowsAgentLayout(home: string, options: WindowsAgentOptions, version: string): WindowsAgentLayout {
  if (!SAFE_VERSION.test(version)) throw new Error(`Unsafe agent version "${version}"`);
  const root = windowsAgentRoot(home, options);
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
    // Set only here, so only an agent started by the task ends when its parent (the conhost.exe the task runs) is gone: a `node azito-agent.cjs` started by hand has no such setting.
    ['AZITO_AGENT_EXIT_WITH_PARENT', '1'],
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

/** What a deploy has put in place so far (an undo removes these, and puts back what it moved aside). */
interface DeployProgress {
  versionCreated: boolean;
  settingsSwapped: boolean;
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
    const result = await checkFirewall((command) => this.sshExec(sshHost, command, FIREWALL_MS), this.options.port, nodePath, bindAddress);
    const problem = describeFirewallProblem(result, this.options.port, nodePath, bindAddress);
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
    /** What this deploy has put in place, so that an undo removes exactly that. */
    const progress: DeployProgress = { versionCreated: false, settingsSwapped: false };
    const rollback = (): Promise<string> => this.restore(input, layout, client, previous, progress);

    try {
      await this.prepareRoot(input.sshHost, layout);
      await this.transfer.putFile(input.sshHost, input.tarballPath, `${layout.rootRelative}/azito-agent-${input.version}.tar.gz`);
      await this.verifySha256(input.sshHost, layout.tarball, input.expectedSha256);
      previous = await this.capturePrevious(client);
      await this.stopTask(input.sshHost, client, layout.envFile);
      await this.extract(input, layout);
      progress.versionCreated = true;
      await this.writeSettings(input, layout, envContent);
      progress.settingsSwapped = true;
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
    await this.stopTask(sshHost, this.schtasks(sshHost, host), windowsAgentEnvFile(host.home, this.options));
  }

  /** Stops and starts the registered task. A task that is not registered is an error (nothing is installed to restart). */
  async restart(sshHost: string, host: WindowsPreflightInfo): Promise<void> {
    const client = this.schtasks(sshHost, host);
    const state = await client.query(this.options.taskName);
    if (!state.exists) throw new Error(`The task "${this.options.taskName}" is not registered on the host: install the agent first`);
    await this.stopTask(sshHost, client, windowsAgentEnvFile(host.home, this.options));
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

  /**
   * Stops the task and makes sure no agent process of this install is left. The agent ends by itself when the `conhost.exe` the
   * task runs is gone (its settings say so), which is what `/End` and the Task Scheduler's own "End" rely on; this is the
   * safety net for an agent that does not (an older one, or one whose parent watch has not fired yet).
   */
  private async stopTask(sshHost: string, client: SchtasksClient, envFile: string): Promise<void> {
    const taskName = this.options.taskName;
    let state = await client.query(taskName);
    if (state.exists && state.running) {
      await client.stop(taskName);
      const deadline = Date.now() + STOP_WAIT_MS;
      while (state.exists && state.running) {
        if (Date.now() >= deadline) throw new Error(`The task "${taskName}" is still running ${STOP_WAIT_MS / 1000}s after it was stopped`);
        await sleep(STOP_POLL_MS);
        state = await client.query(taskName);
      }
    }
    await this.endStrayProcesses(sshHost, envFile);
  }

  /**
   * Ends the `node.exe` processes of this install and nothing else: one of them has the argument `--env-file=<this install's
   * agent.env>` exactly (a token of the command line, so the `--env-file` of an install nested below this one, or a program that
   * merely mentions the folder, does not match) and is owned by the user this session runs as (the SID is compared; an elevated
   * session does not reach other users' processes).
   *
   * The `conhost.exe` above such a node is ended with it, but a process id can be reused once its process has ended, so a parent
   * is taken only if it is a conhost.exe of the same user, created no later than the node, and has the same `--env-file` argument
   * (the task hands its arguments to the conhost, so they are in its command line). A process is identified by its id AND its
   * creation time: the time is checked again just before it is ended, and "has it ended?" asks the same question.
   */
  private async endStrayProcesses(sshHost: string, envFile: string): Promise<void> {
    const q = powershellDialect.quote;
    await this.script(sshHost, 'Ending the agent processes', [
      `$envArgument = '--env-file=' + ${q(envFile)}`,
      "$pattern = '(^|[\\s\"])' + [regex]::Escape($envArgument) + '([\\s\"]|$)'",
      '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      'function Test-Mine($process) { try { (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $me } catch { $false } }',
      'function Test-Argument($process) { $process.CommandLine -and ($process.CommandLine -match $pattern) }',
      'function Get-AgentNodes { @(Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object { (Test-Argument $_) -and (Test-Mine $_) }) }',
      'function Get-Same($target) { $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.Id)"; if ($current -and $current.CreationDate -eq $target.Created) { $current } }',
      '$targets = @()',
      'foreach ($node in Get-AgentNodes) {',
      '  $targets += [pscustomobject]@{ Id = $node.ProcessId; Created = $node.CreationDate }',
      '  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($node.ParentProcessId)"',
      "  if ($parent -and $parent.Name -eq 'conhost.exe' -and $parent.CreationDate -le $node.CreationDate -and (Test-Argument $parent) -and (Test-Mine $parent)) {",
      '    $targets += [pscustomobject]@{ Id = $parent.ProcessId; Created = $parent.CreationDate }',
      '  }',
      '}',
      'foreach ($target in $targets) { if (Get-Same $target) { Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue } }',
      'function Get-Alive { @($targets | Where-Object { Get-Same $_ }) }',
      'for ($i = 0; $i -lt 20 -and (Get-Alive).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }',
      '$left = Get-Alive',
      'if ($left.Count -gt 0) { throw "An agent process did not end: $(($left | ForEach-Object { $_.Id }) -join \', \')" }',
    ].join('\n'), QUICK_MS);
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

  /**
   * Creates the agent's folder and makes it owner-only (files created in it inherit that), clears the temporary files a crashed
   * earlier deploy left, and refuses to go on while an earlier reinstall's previous install is still set aside (`*.prev`): it
   * may be the only copy of settings the hub still holds the token for, so it is never deleted for the sake of a new deploy.
   */
  private async prepareRoot(sshHost: string, layout: WindowsAgentLayout): Promise<void> {
    const q = powershellDialect.quote;
    const temporary = [layout.envFileNew, layout.extractDir].map((p) => `Remove-Item -LiteralPath ${q(p)} -Recurse -Force -ErrorAction SilentlyContinue`).join('\n');
    await this.script(sshHost, 'Preparing the agent folder', [
      `New-Item -ItemType Directory -Force -Path ${q(layout.root)} | Out-Null`,
      `$aside = @(Get-ChildItem -LiteralPath ${q(layout.root)} -Filter '*.prev' -Force | ForEach-Object { $_.FullName })`,
      "if ($aside.Count -gt 0) { throw ('An earlier reinstall left its previous install set aside and it was neither put back nor removed: ' + ($aside -join ', ') + '. If the agent that is installed works, delete these; otherwise move each back to its name without .prev. Then install again.') }",
      temporary,
      `$env:AZITO_GUARD_PATH = ${q(layout.root)}`,
      PROTECT_SCRIPT,
    ].join('\n'));
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
   * Undoes the deploy, in this order: stop whatever is running now; restore the version folder; restore the settings (the two
   * restores are tried independently); delete the temporary files; put the previous task definition back, or delete the new
   * task when there was none; start the previous agent again if it was running AND both restores worked (an agent started on
   * new settings or without its folder would not match the token the hub holds). What this deploy created is removed; what it
   * moved aside is moved back, and stays aside (`*.prev`) when it could not be, with the reason in the returned text.
   */
  private async restore(input: WindowsDeployInput, layout: WindowsAgentLayout, client: SchtasksClient, previous: Previous | undefined, progress: DeployProgress): Promise<string> {
    const q = powershellDialect.quote;
    const done: string[] = [];
    const problems: string[] = [];
    const attempt = async (what: string, action: () => Promise<unknown>): Promise<boolean> => {
      try {
        await action();
        done.push(what);
        return true;
      } catch (err) {
        problems.push(`${what} failed: ${(err as Error).message}`);
        return false;
      }
    };
    // Put `aside` back at `place`. When nothing was set aside but this deploy created `place`, remove it: failing to do THAT is
    // reported (it prints CLEANUP_FAILED) but is not a failure to restore the previous install.
    const putBack = (aside: string, place: string, created: boolean): string => [
      `if (Test-Path -LiteralPath ${q(aside)}) {`,
      `  if (Test-Path -LiteralPath ${q(place)}) { Remove-Item -LiteralPath ${q(place)} -Recurse -Force }`,
      `  Move-Item -LiteralPath ${q(aside)} -Destination ${q(place)}`,
      created ? `} elseif (Test-Path -LiteralPath ${q(place)}) {\n  try { Remove-Item -LiteralPath ${q(place)} -Recurse -Force } catch { Write-Output ('CLEANUP_FAILED ' + $_.Exception.Message) }\n}` : '}',
    ].join('\n');
    const putBackAttempt = (what: string, label: string, aside: string, place: string, created: boolean): Promise<boolean> => attempt(what, async () => {
      const out = await this.script(input.sshHost, label, putBack(aside, place, created));
      const failed = /CLEANUP_FAILED (.*)/.exec(out);
      if (failed) problems.push(`could not remove the new ${what.replace('restored the ', '')} this deploy created (${failed[1]!.trim()}); the previous install itself is not affected`);
    });

    // Nothing was touched before the capture: only the temporary files are removed.
    let restored = false;
    if (previous !== undefined) {
      await attempt('stopped the new agent', () => this.stopTask(input.sshHost, client, layout.envFile));
      const folder = await putBackAttempt('restored the version folder', 'Restoring the previous version folder', layout.versionDirPrev, layout.versionDir, progress.versionCreated);
      const settings = await putBackAttempt('restored the settings', 'Restoring the previous settings', layout.envFilePrev, layout.envFile, progress.settingsSwapped);
      restored = folder && settings;
    }
    await attempt('removed the temporary files', () => this.script(input.sshHost, 'Removing the temporary files', [layout.tarball, layout.extractDir, layout.taskXml, layout.envFileNew].map((p) => `Remove-Item -LiteralPath ${q(p)} -Recurse -Force -ErrorAction SilentlyContinue`).join('\n')));
    if (previous !== undefined) {
      if (previous.taskXml !== undefined) {
        const xml = previous.taskXml;
        await attempt('restored the previous task definition', () => this.registerXml(input.sshHost, layout, client, xml));
        if (previous.wasRunning && restored) await attempt('started the previous agent again', () => client.start(this.options.taskName));
        if (previous.wasRunning && !restored) problems.push(`the previous agent was NOT started, because its folder or settings could not be put back; what is left of the previous install stays set aside as ${layout.envFilePrev} and ${layout.versionDirPrev} (when present)`);
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
