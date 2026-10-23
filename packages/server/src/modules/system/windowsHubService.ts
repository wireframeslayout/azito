import * as path from 'path';
import { buildCommandSpec, type CommandResult, type CommandSpec } from '../../shared/exec/commandSpec';
import { powershellDialect, powershellEncodedArgs } from '../../shared/os/shellDialect';
import { buildTaskXml } from '../../shared/os/taskScheduler/taskDefinition';
import { joinWindowsArgs } from '../../shared/os/taskScheduler/windowsCommandLine';

/**
 * The hub as a Task Scheduler task on Windows (#380 B3a). The pieces that are specific to the hub: the task's definition, the
 * launcher it runs, where its log is, and the sweep that makes `azito service stop` leave no `node.exe` behind. The generic
 * start / stop / state is `TaskSchedulerServiceManager`.
 *
 * Why the definition does not change when the hub is updated: the task runs a launcher (an inline PowerShell script, see
 * {@link buildHubLauncherScript}) that reads `<prefix>\hub\current.txt` each time it starts and runs that version's `run.ps1`. The
 * pointer is the one thing an update switches (the Unix `current` symlink, and #381 after it), so no update has to register the
 * task again, and a rollback of the pointer is a rollback of what the task runs.
 */

/** What `current.txt` may hold (the same rule as install.ps1 and azito.cmd): a release tag, which becomes a folder name. */
const VERSION_PATTERN = '^v?[0-9]+\\.[0-9]+\\.[0-9]+([-+.][0-9A-Za-z.-]+)?$';

const RESTART_INTERVAL_MINUTES = 1;
const RESTART_COUNT = 999;
const SWEEP_TIMEOUT_MS = 60_000;

/** Where the hub of one install lives, all under the install prefix (`%USERPROFILE%\.azito` by default). */
export interface HubWindowsLayout {
  prefix: string;
  /** `<prefix>\hub`: the versioned bundle folders, `.env` and `current.txt`. */
  hubRoot: string;
  /** `<prefix>\hub\current.txt`: one line, the version the task runs. */
  pointer: string;
  /** `<prefix>\logs`. */
  logsDir: string;
  /** `<prefix>\logs\hub.log`: everything the hub writes to stdout and stderr (the counterpart of the journal / `azito.log`). */
  logFile: string;
}

export function hubWindowsLayout(prefix: string): HubWindowsLayout {
  if (!/^([A-Za-z]:[\\/]|\\\\)/.test(prefix)) throw new Error(`The AZITO prefix must be an absolute Windows path: ${prefix}`);
  const root = prefix.replace(/[\\/]+$/, '');
  const hubRoot = path.win32.join(root, 'hub');
  const logsDir = path.win32.join(root, 'logs');
  return { prefix: root, hubRoot, pointer: path.win32.join(hubRoot, 'current.txt'), logsDir, logFile: path.win32.join(logsDir, 'hub.log') };
}

/**
 * The script the task runs: reads the pointer, checks that it names an installed version and starts that version's `run.ps1` in
 * its service mode (`-Service -LogFile`: output goes to the log, and the hub follows the `conhost.exe` the task runs under). A
 * pointer that is missing or wrong cannot reach stderr (a task has none), so it is appended to the log, and the task fails.
 */
export function buildHubLauncherScript(layout: HubWindowsLayout): string {
  const q = powershellDialect.quote;
  return [
    `$pointer = ${q(layout.pointer)}`,
    `$logFile = ${q(layout.logFile)}`,
    `$hubRoot = ${q(layout.hubRoot)}`,
    // Everything that goes wrong here is appended to the log (a task has no stderr), then the task fails and is restarted.
    'function Write-LauncherLog([string]$Message) {',
    '  try {',
    '    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null',
    '    [System.IO.File]::AppendAllText($logFile, "[$([DateTime]::UtcNow.ToString(\'o\'))] launcher: $Message`r`n")',
    '  } catch { }',
    '}',
    'try {',
    '  $version = ([System.IO.File]::ReadAllText($pointer)).TrimStart([char]0xFEFF).Trim()',
    `  if ($version -notmatch ${q(VERSION_PATTERN)}) { throw "$pointer does not hold a version such as v0.12.0 (it holds '$version')" }`,
    "  $run = Join-Path (Join-Path $hubRoot $version) 'run.ps1'",
    '  if (-not (Test-Path -LiteralPath $run -PathType Leaf)) { throw "$run does not exist (current.txt names a version that is not installed)" }',
    '  & $run -Service -LogFile $logFile',
    '  $code = $LASTEXITCODE',
    '} catch {',
    '  Write-LauncherLog $_.Exception.Message',
    '  exit 1',
    '}',
    'if ($code -ne 0) { Write-LauncherLog "run.ps1 ($version) exited with code $code" }',
    'exit $code',
  ].join('\n');
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!);
}

/** The quote characters PowerShell reads as a single quote, which `powershellDialect.quote` doubles (the same set as the writer's). */
const QUOTE_CHARS = "'‘’‚‛";
const HUB_ROOT_LINE = new RegExp(`^\\$hubRoot = '((?:[^${QUOTE_CHARS}]|([${QUOTE_CHARS}])\\2)*)'\\r?$`, 'm');

/** What a task's action runs: the program and its arguments as one command line. */
interface TaskExec {
  command: string;
  argumentsLine: string;
}

function hubTaskExec(systemRoot: string, layout: HubWindowsLayout): TaskExec {
  return {
    command: path.win32.join(systemRoot, 'System32', 'conhost.exe'),
    argumentsLine: joinWindowsArgs(['--headless', windowsPowershell(systemRoot), ...powershellEncodedArgs(buildHubLauncherScript(layout))]),
  };
}

/**
 * Which install a REGISTERED task (the XML the Task Scheduler gives back for it, not our copy) belongs to. The prefix is read from
 * the launcher's `$hubRoot`, and the task is recognised only when its action (program and arguments) is exactly what this code
 * generates for that prefix: a line that merely looks like ours, or an action somebody edited, is `undefined` (unknown).
 */
export function inspectRegisteredHub(xml: string, systemRoot: string): { prefix: string } | undefined {
  const exec = /<Exec>\s*<Command>([\s\S]*?)<\/Command>\s*(?:<Arguments>([\s\S]*?)<\/Arguments>)?/.exec(xml);
  if (!exec) return undefined;
  const command = unescapeXml(exec[1]);
  const argumentsLine = unescapeXml(exec[2] ?? '');
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(argumentsLine)?.[1];
  if (!encoded) return undefined;
  const hubRoot = HUB_ROOT_LINE.exec(Buffer.from(encoded, 'base64').toString('utf16le'))?.[1];
  if (hubRoot === undefined) return undefined;
  const prefix = path.win32.dirname(hubRoot.replace(new RegExp(`([${QUOTE_CHARS}])\\1`, 'g'), '$1'));
  let expected: TaskExec;
  try {
    expected = hubTaskExec(systemRoot, hubWindowsLayout(prefix));
  } catch {
    return undefined;
  }
  if (command.toLowerCase() !== expected.command.toLowerCase() || argumentsLine !== expected.argumentsLine) return undefined;
  return { prefix };
}

/** Whether two Windows paths name the same place by spelling (case and a trailing separator do not count). */
export function samePrefix(a: string, b: string): boolean {
  const norm = (value: string): string => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export interface HubTaskInput {
  /** `DOMAIN\user` of the user the task runs as, resolved at the entry point. */
  userId: string;
  /** `%SystemRoot%`. */
  systemRoot: string;
  layout: HubWindowsLayout;
}

/**
 * The task definition (XML is only ever generated here, by `buildTaskXml`): at the user's logon, as that user with least
 * privilege, restarted when it fails. It runs `conhost.exe --headless powershell.exe <launcher>`: without `--headless` a console
 * program started in the user's session gets a visible console window, and closing it would end the hub.
 */
export function buildHubTaskXml(input: HubTaskInput): string {
  return buildTaskXml({
    userId: input.userId,
    description: 'AZITO Hub: started at logon',
    executable: hubTaskExec(input.systemRoot, input.layout).command,
    args: ['--headless', windowsPowershell(input.systemRoot), ...powershellEncodedArgs(buildHubLauncherScript(input.layout))],
    workingDirectory: input.layout.hubRoot,
    restartOnFailure: { intervalMinutes: RESTART_INTERVAL_MINUTES, count: RESTART_COUNT },
  });
}

function windowsPowershell(systemRoot: string): string {
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** `DOMAIN\user` of the logged-on user, from the environment Windows gives every process of that logon (read at the entry point). */
export function resolveWindowsUserId(env: NodeJS.ProcessEnv): string {
  const domain = env.USERDOMAIN;
  const user = env.USERNAME;
  if (!domain || !user) throw new Error('Cannot tell which user the task should run as: USERDOMAIN or USERNAME is not set');
  return `${domain}\\${user}`;
}

/** Runs one command (`runCommandSpec` with the host's options, or a fake). */
export type SpecRunner = (spec: CommandSpec) => Promise<CommandResult>;

/** A process identified the way the sweep needs it: by id AND creation time (an id can be handed to another process once it has ended). */
export interface HubProcess {
  pid: number;
  /** `ToFileTimeUtc()` of its `Process.StartTime`. */
  created: string;
}

/** How long the hub gets to end by itself after `/End` (the 3 s parent probe, then its graceful shutdown, capped at 8 s) before it is ended forcibly. */
export const HUB_GRACE_MS = 20_000;
const FORCE_WAIT_MS = 10_000;

const PROCESS_PREAMBLE = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  'function Test-Mine($process) { try { (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $me } catch { $false } }',
];

/**
 * The hub processes of this install, to be found BEFORE the task is ended: a `node.exe` of this user whose command line has an
 * `azito-hub.cjs` of ANY version folder under `<prefix>\hub\` as one whole argument. Any version, because a restart after `current.txt`
 * was switched must still wait for the version that is running. `hubRoots` are the spellings of `<prefix>\hub` to match (the given
 * one and its real path: a junction or an 8.3 name makes them differ); another prefix or another user's hub is not matched.
 * `excludePid` is the caller itself: `azito service stop` is a `node.exe` that names the same file.
 */
export async function findHubProcesses(run: SpecRunner, systemRoot: string, hubRoots: readonly string[], excludePid: number): Promise<HubProcess[]> {
  const q = powershellDialect.quote;
  const alternatives = hubRoots.map((root) => `[regex]::Escape(${q(`${root.replace(/[\\/]+$/, '')}\\`)})`).join(" + '|' + ");
  const script = [
    ...PROCESS_PREAMBLE,
    `$roots = ${alternatives}`,
    "$pattern = '(^|[\\s\"])(' + $roots + ')[^\\\\\"\\s]+\\\\azito-hub\\.cjs([\\s\"]|$)'",
    `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ProcessId -ne ${Math.trunc(excludePid)} -and $_.CommandLine -and ($_.CommandLine -match $pattern) -and (Test-Mine $_) } | ForEach-Object { $started = try { (Get-Process -Id $_.ProcessId -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { $null }; if ($started) { "$($_.ProcessId) $started" } }`,
  ].join('\n');
  const result = await runPowershell(run, systemRoot, script, 'Looking for the hub processes');
  return result.stdout.split(/\r?\n/).map((line) => /^(\d+) (\d+)$/.exec(line.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ pid: Number(m[1]), created: m[2] }));
}

/**
 * Waits for the processes found before `/End` to end by themselves (the hub follows its `conhost.exe` and shuts down gracefully:
 * browser sessions, tmux hooks, event streams), and ends forcibly only those that are still the same process (id and creation
 * time) when `graceMs` is over. Returns the ids it had to end forcibly. Throws when one still stays.
 */
export async function endHubProcesses(run: SpecRunner, systemRoot: string, targets: readonly HubProcess[], graceMs: number): Promise<number[]> {
  if (targets.length === 0) return [];
  const list = targets.map((t) => `[pscustomobject]@{ Id = ${Math.trunc(t.pid)}; Created = ${BigInt(t.created)} }`).join(', ');
  // Each target is opened as a Process object, which holds a handle: while it is open its id cannot be handed to another process. The
  // start time is checked on that very object, and `Kill()` ends that very object, never an id. A process that is not the one found
  // before (another start time), or cannot be opened, is left alone.
  const script = [
    ...PROCESS_PREAMBLE,
    `$targets = @(${list})`,
    'function Open-Target($target) {',
    '  $p = Get-Process -Id $target.Id -ErrorAction SilentlyContinue',
    '  if (-not $p) { return $null }',
    '  try {',
    '    $null = $p.Handle',
    '    if (-not $p.HasExited -and $p.StartTime.ToFileTimeUtc() -eq $target.Created) { return $p }',
    '  } catch { }',
    '  return $null',
    '}',
    '$procs = @($targets | ForEach-Object { Open-Target $_ } | Where-Object { $_ })',
    'function Get-Alive { @($procs | Where-Object { -not $_.HasExited }) }',
    `$until = (Get-Date).AddMilliseconds(${Math.trunc(graceMs)})`,
    // @() around every call: a function that returns one object returns it unwrapped, and a PowerShell 5.1 object has no .Count.
    'while (@(Get-Alive).Count -gt 0 -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 250 }',
    '$forced = @(Get-Alive)',
    'foreach ($p in $forced) { try { $p.Kill() } catch { } }',
    `$until = (Get-Date).AddMilliseconds(${FORCE_WAIT_MS})`,
    'while (@(Get-Alive).Count -gt 0 -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 250 }',
    '$left = @(Get-Alive)',
    "if ($left.Count -gt 0) { throw \"A hub process did not end: $(($left | ForEach-Object { $_.Id }) -join ', ')\" }",
    '$forced | ForEach-Object { "forced $($_.Id)" }',
  ].join('\n');
  const result = await runPowershell(run, systemRoot, script, 'Ending the hub processes', graceMs + FORCE_WAIT_MS + 30_000);
  return result.stdout.split(/\r?\n/).map((line) => /^forced (\d+)$/.exec(line.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
}

async function runPowershell(run: SpecRunner, systemRoot: string, script: string, what: string, timeoutMs = SWEEP_TIMEOUT_MS): Promise<CommandResult> {
  const result = await run(buildCommandSpec(windowsPowershell(systemRoot), powershellEncodedArgs(script), { timeoutMs }));
  if (result.exitCode !== 0) throw new Error(`${what} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  return result;
}
