import * as path from 'path';
import { buildCommandSpec, type CommandResult, type CommandSpec } from '../../shared/exec/commandSpec';
import { powershellDialect, powershellEncodedArgs } from '../../shared/os/shellDialect';
import { buildEndProcessesScript } from '../../shared/os/windowsProcessSweep';
import { buildTaskXml } from '../../shared/os/taskScheduler/taskDefinition';

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
    'try {',
    '  $version = ([System.IO.File]::ReadAllText($pointer)).TrimStart([char]0xFEFF).Trim()',
    `  if ($version -notmatch ${q(VERSION_PATTERN)}) { throw "$pointer does not hold a version such as v0.12.0 (it holds '$version')" }`,
    "  $run = Join-Path (Join-Path $hubRoot $version) 'run.ps1'",
    '  if (-not (Test-Path -LiteralPath $run -PathType Leaf)) { throw "$run does not exist (current.txt names a version that is not installed)" }',
    '} catch {',
    '  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null',
    '  [System.IO.File]::AppendAllText($logFile, "[$([DateTime]::UtcNow.ToString(\'o\'))] launcher: $($_.Exception.Message)`r`n")',
    '  exit 1',
    '}',
    '& $run -Service -LogFile $logFile',
  ].join('\n');
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
    executable: path.win32.join(input.systemRoot, 'System32', 'conhost.exe'),
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

/**
 * Ends any `node.exe` still running this install's hub after the task was stopped. The hub follows its `conhost.exe` and ends by
 * itself within seconds of `/End`, so this is the safety net (an older hub, or one whose watch has not fired yet), and it makes
 * `azito stop` return only when nothing is left. It is as narrow as the agent's: the program is `node.exe`, one argument of its
 * command line is exactly the bundle's `azito-hub.cjs`, it belongs to this user, and it is ended only if it is still the process
 * (id and creation time) the sweep listed. `excludePid` is the caller itself: `azito service stop` is a `node.exe` that names
 * the same file.
 */
export async function endHubProcesses(run: SpecRunner, systemRoot: string, entry: string, excludePid: number): Promise<void> {
  const script = buildEndProcessesScript({ image: 'node.exe', argument: entry, label: 'hub', endParentConhost: false, excludePid });
  const spec = buildCommandSpec(windowsPowershell(systemRoot), powershellEncodedArgs(`$ProgressPreference = 'SilentlyContinue'\n${script}`), { timeoutMs: SWEEP_TIMEOUT_MS });
  const result = await run(spec);
  if (result.exitCode !== 0) {
    throw new Error(`Ending the hub processes failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  }
}
