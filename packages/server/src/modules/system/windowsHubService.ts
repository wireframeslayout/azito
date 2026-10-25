import * as path from 'path';
import { buildCommandSpec, type CommandResult, type CommandSpec } from '../../shared/exec/commandSpec';
import { powershellDialect, powershellEncodedArgs } from '../../shared/os/shellDialect';
import { buildTaskXml } from '../../shared/os/taskScheduler/taskDefinition';
import { joinWindowsArgs } from '../../shared/os/taskScheduler/windowsCommandLine';
import { HUB_POINTER_VERSION_PATTERN } from './hubVersion';

/**
 * The hub as a Task Scheduler task on Windows (#380 B3a). The pieces that are specific to the hub: the task's definition, the
 * launcher it runs, where its log is, and the sweep that makes `azito service stop` leave no `node.exe` behind. The generic
 * start / stop / state is `TaskSchedulerServiceManager`.
 *
 * Why the definition does not change when the hub is updated: the task runs a launcher (an inline PowerShell script, see
 * {@link buildHubLauncherScript}) that reads `<prefix>\hub\current.txt` each time it starts and runs that version's `run.ps1`. The
 * pointer is the one thing an update switches (the Unix `current` symlink's counterpart; the in-app update, `windowsUpdateBackend.ts`, writes it), so no update has to register the
 * task again, and a rollback of the pointer is a rollback of what the task runs.
 */

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
  /** `<prefix>\logs\hub-launcher.json`: the launcher's own record of its restarts (see {@link readHubLauncherState}). */
  launcherState: string;
}

export function hubWindowsLayout(prefix: string): HubWindowsLayout {
  if (!/^([A-Za-z]:[\\/]|\\\\)/.test(prefix)) throw new Error(`The AZITO prefix must be an absolute Windows path: ${prefix}`);
  const root = prefix.replace(/[\\/]+$/, '');
  const hubRoot = path.win32.join(root, 'hub');
  const logsDir = path.win32.join(root, 'logs');
  return { prefix: root, hubRoot, pointer: path.win32.join(hubRoot, 'current.txt'), logsDir, logFile: path.win32.join(logsDir, 'hub.log'), launcherState: path.win32.join(logsDir, 'hub-launcher.json') };
}

/** How the launcher waits between two starts of a hub that exited with a non-zero code. */
export interface HubRestartTiming {
  /** The first wait; it doubles after every exit up to `maxSeconds`. */
  baseSeconds: number;
  maxSeconds: number;
  /** A hub that ran this long before it exited starts the waits over from `baseSeconds`. */
  stableSeconds: number;
}

export const HUB_RESTART_TIMING: HubRestartTiming = { baseSeconds: 5, maxSeconds: 60, stableSeconds: 300 };

/** The launcher is in the task's command line; 8191 characters is cmd.exe's limit, the smallest on the way. */
export const MAX_COMMAND_LINE = 8191;

/**
 * The script the task runs: a loop around "read the pointer, check that it names an installed version, run that version's `run.ps1`
 * in its service mode (`-Service -LogFile`: output goes to the log, and the hub follows the `conhost.exe` the task runs under)".
 *
 * Why a loop here: nothing outside the hub can restart it. `conhost.exe --headless` reports exit code 0 whatever its child did, so
 * the Task Scheduler's RestartOnFailure never fires (measured: `restartOnFailure.windows.test.ts`), and a repeating trigger would
 * undo `/End`. So the launcher, which lives as long as the task, starts the hub again when `run.ps1` ends with a non-zero code:
 * after `baseSeconds`, doubling up to `maxSeconds`, starting over once a start lasted `stableSeconds`. Every start reads the pointer
 * again (an update only switches `current.txt`). Exit code 0 is a hub that shut down on purpose (SIGTERM, or the `conhost.exe` it
 * follows being gone) and is not started again. `/End` (`azito stop`, `restart`) ends the task's `conhost.exe` and with it the
 * launcher; should the launcher outlive its `conhost.exe` anyway it notices (same process id and start time) and ends instead of
 * starting a hub nobody follows. A pointer that is missing or wrong cannot reach stderr (a task has none): it is appended to the
 * log and tried again every `maxSeconds`. Each restart is appended to the log and recorded in `hub-launcher.json`.
 */
export function buildHubLauncherScript(layout: HubWindowsLayout, timing: HubRestartTiming): string {
  const q = powershellDialect.quote;
  // The prefix is written once, as $hubRoot (inspectRegisteredHub reads it back from that line); the other paths are derived from it
  // in the script, because the whole script travels in the task's command line (8191 characters) and a path costs about 11 there.
  // They are the same paths as `layout.pointer`, `layout.logFile` and `layout.launcherState` (a test runs the script to check).
  return [
    `$hubRoot = ${q(layout.hubRoot)}`,
    `$base = ${Math.trunc(timing.baseSeconds)}; $max = ${Math.trunc(timing.maxSeconds)}; $stable = ${Math.trunc(timing.stableSeconds)}`,
    '$pointer = "$hubRoot\\current.txt"; $logDir = Join-Path (Split-Path -Parent $hubRoot) \'logs\'',
    '$logFile = "$logDir\\hub.log"; $stateFile = "$logDir\\hub-launcher.json"',
    // Everything that goes wrong here is appended to the log (a task has no stderr).
    'function Log([string]$m) {',
    '  try {',
    '    New-Item -ItemType Directory -Force -Path $logDir | Out-Null',
    '    [IO.File]::AppendAllText($logFile, "[$([DateTime]::UtcNow.ToString(\'o\'))] launcher: $m`r`n")',
    '  } catch { }',
    '}',
    // The conhost.exe this runs under: once it is gone the task was ended, and no hub is started for nobody.
    'try {',
    '  $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId',
    '  $parentStart = (Get-Process -Id $parentId).StartTime',
    '} catch { Log "no parent to follow, so no hub is started: $($_.Exception.Message)"; exit 1 }',
    // run.ps1 is given the same process (id and start time) and starts no hub unless it is still running: an End in between must not leave one nobody follows.
    '$parentFt = $parentStart.ToFileTimeUtc()',
    'function Stop-IfEnded {',
    '  $p = Get-Process -Id $parentId -ErrorAction SilentlyContinue',
    '  if (-not $p -or $p.StartTime -ne $parentStart) { Log \'task ended: not restarting\'; exit 0 }',
    '}',
    // What `azito status` shows: when this launcher began, and how many times it started the hub again (and after which exit).
    '$restarts = 0; $started = [DateTime]::UtcNow.ToString(\'o\')',
    'function Save-State($code, $at, $wait) {',
    '  try {',
    '    $json = [pscustomobject]@{ startedAt = $started; restarts = $restarts; lastExitCode = $code; lastExitAt = $at; nextWaitSeconds = $wait } | ConvertTo-Json -Compress',
    '    New-Item -ItemType Directory -Force -Path $logDir | Out-Null',
    // Written beside and swapped in (Replace is one operation; Move for the first one, in the same folder), so `azito status` never reads half a file or none.
    '    [IO.File]::WriteAllText("$stateFile.tmp", $json, (New-Object Text.UTF8Encoding($false)))',
    '    if (Test-Path -LiteralPath $stateFile) { [IO.File]::Replace("$stateFile.tmp", $stateFile, [NullString]::Value) } else { [IO.File]::Move("$stateFile.tmp", $stateFile) }',
    '  } catch { Log "cannot write ${stateFile}: $($_.Exception.Message)" }',
    '}',
    'Save-State $null $null 0',
    '$delay = $base',
    'while ($true) {',
    // Checked before every start too, not only while waiting: an End that came in between would leave a hub with no conhost.exe to follow.
    '  Stop-IfEnded',
    '  $began = [DateTime]::UtcNow; $version = \'?\'; $code = $null',
    '  try {',
    '    $version = ([IO.File]::ReadAllText($pointer)).TrimStart([char]0xFEFF).Trim()',
    `    if ($version -notmatch ${q(HUB_POINTER_VERSION_PATTERN)}) { throw "$pointer is not a version (it holds '$version')" }`,
    "    $run = Join-Path (Join-Path $hubRoot $version) 'run.ps1'",
    '    if (-not (Test-Path -LiteralPath $run -PathType Leaf)) { throw "$run does not exist (not installed)" }',
    '    & $run -Service -LogFile $logFile -FollowPid $parentId -FollowStart $parentFt',
    '    $code = $LASTEXITCODE',
    '  } catch { Log $_.Exception.Message }',
    '  if ($code -eq 0) { Log "run.ps1 ($version) exited with code 0: done"; exit 0 }',
    '  Stop-IfEnded',
    '  $wait = $max',
    '  if ($null -ne $code) {',
    '    Log "run.ps1 ($version) exited with code $code"',
    '    if (([DateTime]::UtcNow - $began).TotalSeconds -ge $stable) { $delay = $base }',
    '    $wait = $delay; $delay = [Math]::Min($delay * 2, $max)',
    '  }',
    '  $restarts++',
    '  Log "start $($restarts + 1) in ${wait}s"',
    '  Save-State $code ([DateTime]::UtcNow.ToString(\'o\')) $wait',
    '  for ($i = 0; $i -lt $wait; $i++) { Start-Sleep -Seconds 1; Stop-IfEnded }',
    '}',
  ].join('\n');
}


/** The launcher the first 0.12 builds registered: it ran `run.ps1` once and exited with its code. Kept only to recognise (and replace) such a task. */
export function buildSingleRunLauncherScript(layout: HubWindowsLayout): string {
  const q = powershellDialect.quote;
  return [
    `$pointer = ${q(layout.pointer)}`,
    `$logFile = ${q(layout.logFile)}`,
    `$hubRoot = ${q(layout.hubRoot)}`,
    'function Write-LauncherLog([string]$Message) {',
    '  try {',
    '    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null',
    '    [System.IO.File]::AppendAllText($logFile, "[$([DateTime]::UtcNow.ToString(\'o\'))] launcher: $Message`r`n")',
    '  } catch { }',
    '}',
    'try {',
    '  $version = ([System.IO.File]::ReadAllText($pointer)).TrimStart([char]0xFEFF).Trim()',
    `  if ($version -notmatch ${q(HUB_POINTER_VERSION_PATTERN)}) { throw "$pointer does not hold a version such as v0.12.0 (it holds '$version')" }`,
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
export interface TaskExec {
  command: string;
  argumentsLine: string;
}

function hubTaskExec(systemRoot: string, launcher: string): TaskExec {
  const exec = {
    command: path.win32.join(systemRoot, 'System32', 'conhost.exe'),
    argumentsLine: joinWindowsArgs(['--headless', windowsPowershell(systemRoot), ...powershellEncodedArgs(launcher)]),
  };
  const length = exec.command.length + 1 + exec.argumentsLine.length;
  if (length > MAX_COMMAND_LINE) throw new Error(`The hub launcher's command line would be ${length} characters, over the ${MAX_COMMAND_LINE} the task can run: the install prefix is too long`);
  return exec;
}

/**
 * The one action of a task, read as structure: there must be exactly one `<Actions>` with exactly one `<Exec>` in it and nothing else
 * (no second Exec, no ComHandler, SendEmail, ShowMessage or any other element, no text). A task with more actions than the one this
 * code generates would run more than the hub, so it is not ours.
 */
export function singleExec(xml: string): TaskExec | undefined {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  const actions = [...withoutComments.matchAll(/<Actions\b[^>]*>([\s\S]*?)<\/Actions>/g)];
  if (actions.length !== 1) return undefined;
  const inner = actions[0][1];
  const execs = [...inner.matchAll(/<Exec\b[^>]*>([\s\S]*?)<\/Exec>/g)];
  if (execs.length !== 1) return undefined;
  if (inner.replace(/<Exec\b[^>]*>[\s\S]*?<\/Exec>/, '').trim() !== '') return undefined;
  const body = execs[0][1];
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(body)?.[1];
  if (command === undefined) return undefined;
  const argumentsLine = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(body)?.[1] ?? '';
  return { command: unescapeXml(command), argumentsLine: unescapeXml(argumentsLine) };
}

/**
 * Which install a REGISTERED task (the XML the Task Scheduler gives back for it, not our copy) belongs to. The prefix is read from
 * the launcher's `$hubRoot`, and the task is recognised only when its action (program and arguments) is exactly what this code
 * generates for that prefix: a line that merely looks like ours, or an action somebody edited, is `undefined` (unknown).
 * `singleRun` is the launcher the first 0.12 builds registered (it started the hub once and never again): the same install's task,
 * still operable, and replaced by `azito service install`.
 */
export function inspectRegisteredHub(xml: string, systemRoot: string): { prefix: string; singleRun: boolean } | undefined {
  const exec = singleExec(xml);
  if (exec === undefined) return undefined;
  const command = exec.command;
  const argumentsLine = exec.argumentsLine;
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(argumentsLine)?.[1];
  if (!encoded) return undefined;
  const hubRoot = HUB_ROOT_LINE.exec(Buffer.from(encoded, 'base64').toString('utf16le'))?.[1];
  if (hubRoot === undefined) return undefined;
  const prefix = path.win32.dirname(hubRoot.replace(new RegExp(`([${QUOTE_CHARS}])\\1`, 'g'), '$1'));
  let layout: HubWindowsLayout;
  try {
    layout = hubWindowsLayout(prefix);
  } catch {
    return undefined;
  }
  const matches = (launcher: string): boolean => {
    try {
      const expected = hubTaskExec(systemRoot, launcher);
      return command.toLowerCase() === expected.command.toLowerCase() && argumentsLine === expected.argumentsLine;
    } catch {
      return false;
    }
  };
  if (matches(buildHubLauncherScript(layout, HUB_RESTART_TIMING))) return { prefix, singleRun: false };
  if (matches(buildSingleRunLauncherScript(layout))) return { prefix, singleRun: true };
  return undefined;
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
 * program started in the user's session gets a visible console window, and closing it would end the hub. The launcher is what
 * starts the hub again when it dies ({@link buildHubLauncherScript}); RestartOnFailure never fires for it (conhost reports 0) and is only the Task Scheduler's own retry of a start that failed.
 */
export function buildHubTaskXml(input: HubTaskInput): string {
  const exec = hubTaskExec(input.systemRoot, buildHubLauncherScript(input.layout, HUB_RESTART_TIMING));
  return buildTaskXml({
    userId: input.userId,
    description: 'AZITO Hub: started at logon',
    executable: exec.command,
    argumentsLine: exec.argumentsLine,
    workingDirectory: input.layout.hubRoot,
    restartOnFailure: { intervalMinutes: RESTART_INTERVAL_MINUTES, count: RESTART_COUNT },
  });
}

export function windowsPowershell(systemRoot: string): string {
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
  // GetOwnerSid reports "access denied" and the like as a non-zero ReturnValue, not as an exception, so the result is kept and
  // looked at: Mine is $true / $false only for ReturnValue 0 with a SID; anything else is $null with the reason, never "not mine".
  'function Get-Owner($process) {',
  '  try { $r = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop } catch { return [pscustomobject]@{ Mine = $null; Reason = $_.Exception.Message } }',
  '  if ($r.ReturnValue -ne 0) { return [pscustomobject]@{ Mine = $null; Reason = "ReturnValue $($r.ReturnValue)" } }',
  '  if (-not ($r.Sid -is [string]) -or $r.Sid -eq \'\') { return [pscustomobject]@{ Mine = $null; Reason = \'ReturnValue 0 but no SID\' } }',
  '  return [pscustomobject]@{ Mine = ($r.Sid -eq $me); Reason = $null }',
  '}',
];

/**
 * Splits a command line with Windows' own `CommandLineToArgvW`, called from PowerShell, rather than a re-implementation of its rules in
 * TypeScript or PowerShell: the rule is the one `quoteWindowsArg` is written against, and what the OS gives back is what any program (node.exe
 * included) sees as its arguments. Compiled in the PowerShell session; nothing is installed.
 */
export const ARGV_HELPER = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AzitoArgv {
  [DllImport("shell32.dll", SetLastError = true)]
  static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr handle);
  public static string[] Split(string commandLine) {
    int count;
    IntPtr argv = CommandLineToArgvW(commandLine, out count);
    if (argv == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      var result = new string[count];
      for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
      return result;
    } finally { LocalFree(argv); }
  }
}
'@`;

/**
 * The hub processes of this install, to be found BEFORE the task is ended: a `node.exe` of this user whose command line has an
 * `azito-hub.cjs` of ANY version folder under `<prefix>\hub\` as one whole argument. Any version, because a restart after `current.txt`
 * was switched must still wait for the version that is running. `hubRoots` are the spellings of `<prefix>\hub` to match (the given
 * one and its real path: a junction or an 8.3 name makes them differ); another prefix or another user's hub is not matched.
 * `onlyWithArgument`: when given, only a process that also has it as one whole argument (`update-run`: the update process and not `azito misao ...` or the hub itself).
 * `excludePid` is the caller itself: `azito service stop` is a `node.exe` that names the same file.
 */
export async function findHubProcesses(run: SpecRunner, systemRoot: string, hubRoots: readonly string[], excludePid: number, onlyWithArgument?: string): Promise<HubProcess[]> {
  const q = powershellDialect.quote;
  if (onlyWithArgument !== undefined && !/^[A-Za-z0-9-]+$/.test(onlyWithArgument)) throw new Error(`Not a plain word: ${onlyWithArgument}`);
  const alternatives = hubRoots.map((root) => `[regex]::Escape(${q(`${root.replace(/[\\/]+$/, '')}\\`)})`).join(" + '|' + ");
  // Per candidate: the Process is opened FIRST (the handle keeps its id from being handed to another process), THEN the command line,
  // owner and creation date of that id are read, and the creation date must agree with the opened process's start time (WMI keeps
  // microseconds, a start time 100 ns: 1 ms of slack). What is recorded is that verified start time.
  // "Gone" (no such process by the time it is read) and "another user's" are skipped; a hub process of THIS user that cannot be
  // opened or read is an error naming its id. This user's own processes are always openable, so that should not happen: it means
  // something is wrong (a protected process, a changed security setup) and the stop must not claim success.
  const script = [
    ...PROCESS_PREAMBLE,
    ...(onlyWithArgument === undefined ? [] : [ARGV_HELPER]),
    `$roots = ${alternatives}`,
    "$pattern = '(^|[\\s\"])(' + $roots + ')[^\\\\\"\\s]+\\\\azito-hub\\.cjs([\\s\"]|$)'",
    `foreach ($p in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {`,
    `  if ($p.Id -eq ${Math.trunc(excludePid)}) { continue }`,
    '  $openError = $null',
    '  try { $null = $p.Handle; $started = $p.StartTime } catch { $openError = $_.Exception.Message }',
    '  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)"',
    '  if (-not $cim -or -not $cim.CommandLine -or $cim.CommandLine -notmatch $pattern) { continue }',
    ...(onlyWithArgument === undefined ? [] : [
      // The command line is split by the OS's own rule (CommandLineToArgvW, the inverse of `quoteWindowsArg`), and the argument right after the
      // bundle's azito-hub.cjs must be exactly this word: a path or another argument that merely contains it is not a match.
      '  $argv = [AzitoArgv]::Split($cim.CommandLine)',
      '  $given = $false',
      `  for ($i = 0; $i -lt $argv.Count - 1; $i++) { if ($argv[$i].EndsWith('\\azito-hub.cjs', [StringComparison]::OrdinalIgnoreCase) -and $argv[$i + 1] -ceq ${q(onlyWithArgument)}) { $given = $true } }`,
      '  if (-not $given) { continue }',
    ]),
    // Only a process whose command line is this hub's gets its owner looked at: an unrelated node.exe of another user is skipped above.
    '  $owner = Get-Owner $cim',
    '  if ($null -eq $owner.Mine) { throw "Cannot tell whose hub process $($p.Id) is (GetOwnerSid: $($owner.Reason))" }',
    '  if (-not $owner.Mine) { continue }',
    '  if ($openError) { throw "Cannot open hub process $($p.Id) to verify it: $openError" }',
    '  if ([Math]::Abs($cim.CreationDate.ToFileTimeUtc() - $started.ToFileTimeUtc()) -gt 10000) { throw "Hub process $($p.Id) is not the process that was read (the start time differs)" }',
    '  "$($p.Id) $($started.ToFileTimeUtc())"',
    '}',
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
  // start time is checked on that very object, and `Kill()` ends that very object, never an id. A process that is gone, or is not the
  // one found before (another start time), is left alone; one that exists but cannot be opened to be checked is an error naming its
  // id (these are this user's own processes, which are always openable, so that means something is wrong).
  const script = [
    ...PROCESS_PREAMBLE,
    `$targets = @(${list})`,
    'function Open-Target($target) {',
    '  $p = Get-Process -Id $target.Id -ErrorAction SilentlyContinue',
    '  if (-not $p) { return $null }',
    '  try {',
    '    $null = $p.Handle',
    '    $exited = $p.HasExited',
    '    $started = $p.StartTime.ToFileTimeUtc()',
    '  } catch {',
    '    $reason = $_.Exception.Message',
    '    if (-not (Get-Process -Id $target.Id -ErrorAction SilentlyContinue)) { return $null }',
    '    throw "Cannot open hub process $($target.Id) to verify it: $reason"',
    '  }',
    '  if ($exited -or $started -ne $target.Created) { return $null }',
    '  return $p',
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
