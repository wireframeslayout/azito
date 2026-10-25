import * as path from 'path';
import { MISAO_RELEASE_FILE_NAMES, misaoFileNameOn, MISAO_WINDOWS_CURRENT_FILE, type AgentMisaoWindowsHost, type MisaoReleaseFile } from '../../servers/transport/agentMisaoSocket';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
export { taskMisaoRoot } from '../../../shared/os/taskScheduler/taskXmlRead';
import { joinWindowsArgs, quoteWindowsArg } from '../../../shared/os/taskScheduler/windowsCommandLine';
import { powershellDialect, powershellEncodedArgs } from '../../../shared/os/shellDialect';

const win32 = path.win32;

/** A failed misao stays down for a minute before the Task Scheduler starts it again (its smallest interval), as the hub's systemd unit would after `RestartSec`. */
const RESTART_INTERVAL_MINUTES = 1;
const RESTART_COUNT = 999;

/** Where everything of one Windows misao install lives on the host. */
export interface MisaoWindowsLayout {
  /** `<home>\<AZITO_MISAO_DIR>` (owner-only): the daemon's `--data` directory, the versions, the log. */
  root: string;
  /** The folder of the release the layout is for. */
  versionDir: string;
  /** The release's `misao.exe`. */
  exe: string;
  /** Where an upload of this release is staged until it is moved to `versionDir`. */
  stageDir: string;
  /** Which release the task starts (the Windows counterpart of the `current` link). */
  currentFile: string;
  /** The daemon's stdout and stderr, appended by `cmd.exe`. */
  logFile: string;
  /** The task definition, written beside the install while it is being registered. */
  taskXmlFile: string;
}

export function misaoWindowsLayout(windows: Pick<AgentMisaoWindowsHost, 'misaoRoot'>, version: string, taskName: string): MisaoWindowsLayout {
  const root = windows.misaoRoot;
  const versionDir = win32.join(root, version);
  return {
    root,
    versionDir,
    exe: win32.join(versionDir, misaoFileNameOn('win32', 'misao')),
    stageDir: win32.join(root, `${version}.upload`),
    currentFile: win32.join(root, MISAO_WINDOWS_CURRENT_FILE),
    logFile: win32.join(root, 'misao.log'),
    taskXmlFile: win32.join(root, `${taskName}.task.xml`),
  };
}

/** The path of one release file in `versionDir` (`misao` is `misao.exe`). */
export function misaoWindowsReleaseFile(versionDir: string, name: MisaoReleaseFile): string {
  return win32.join(versionDir, misaoFileNameOn('win32', name));
}

/** The release files of a version folder, in the order the sha256 check lists them. */
export function misaoWindowsReleasePaths(versionDir: string): string[] {
  return MISAO_RELEASE_FILE_NAMES.map((name) => misaoWindowsReleaseFile(versionDir, name));
}

/**
 * The characters of a path that the plain command line (below) carries safely. `conhost.exe --headless` re-reads the command line it
 * is given, and a path with a space or a parenthesis in it (`C:\Users\Foo Bar (Work)\...`, a user name with a space) made the task
 * start nothing on a real Windows, whatever the quoting; a path of these characters is read back exactly. Anything else goes through
 * {@link misaoLauncherArguments}, which keeps every path out of the command line.
 */
const PLAIN_COMMAND_LINE_PATH = /^[A-Za-z0-9._:~\\-]+$/;

/**
 * Text that lands inside double quotes in the plain `cmd.exe /c` line. Only paths of plain characters get here (see
 * {@link PLAIN_COMMAND_LINE_PATH}; a quote or a line break is refused before), so nothing needs escaping.
 */
function quoteForCmd(value: string): string {
  return `"${value}"`;
}

/** The launcher form: a fixed PowerShell script (`-EncodedCommand`, no path in the command line) that starts `cmd.exe` with the paths in environment variables, the way `run.ps1` starts the hub. */
function misaoLauncherScript(input: { systemRoot: string; layout: MisaoWindowsLayout; pipe: string }): string {
  const q = powershellDialect.quote;
  const { layout, pipe } = input;
  return [
    '$info = New-Object System.Diagnostics.ProcessStartInfo',
    `$info.FileName = ${q(win32.join(input.systemRoot, 'System32', 'cmd.exe'))}`,
    // %NAME% in the cmd line is replaced by cmd.exe from the environment below, once: a path is never re-read as cmd syntax, whatever it holds.
    `$info.Arguments = ${q('/d /v:off /s /c ""%AZITO_MISAO_EXE%" serve --socket "%AZITO_MISAO_PIPE%" --data "%AZITO_MISAO_ROOT%" >>"%AZITO_MISAO_LOG%" 2>&1"')}`,
    '$info.UseShellExecute = $false',
    '$info.CreateNoWindow = $true',
    `$info.EnvironmentVariables['AZITO_MISAO_EXE'] = ${q(layout.exe)}`,
    `$info.EnvironmentVariables['AZITO_MISAO_PIPE'] = ${q(pipe)}`,
    `$info.EnvironmentVariables['AZITO_MISAO_ROOT'] = ${q(layout.root)}`,
    `$info.EnvironmentVariables['AZITO_MISAO_LOG'] = ${q(layout.logFile)}`,
    '$process = [System.Diagnostics.Process]::Start($info)',
    '$process.WaitForExit()',
    'exit $process.ExitCode',
  ].join('\n');
}

function misaoLauncherArguments(input: { systemRoot: string; layout: MisaoWindowsLayout; pipe: string }): string {
  const powershell = win32.join(input.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return joinWindowsArgs(['--headless', powershell, ...powershellEncodedArgs(misaoLauncherScript(input))]);
}

/**
 * The command line of the misao task. For a plain path it is `conhost.exe --headless cmd.exe /d /c ""<misao.exe>" serve --socket
 * "<pipe>" --data "<root>" >> "<log>" 2>&1"`: `--headless` gives the daemon a console without a window; `cmd.exe` appends its stdout and
 * stderr to the log (misao writes its log there, and has no option of its own for a file): the form misao's own
 * `deploy/windows/misao-task.xml` uses. A path with a space, a parenthesis or another character `conhost.exe` / `cmd.exe` would read
 * differently runs through the launcher script instead (same `cmd.exe` line, paths in environment variables).
 * The pipe is named explicitly so that the daemon, the agent's relay and `misao stop` all use the one the hub chose.
 */
export function misaoTaskArguments(input: { systemRoot: string; layout: MisaoWindowsLayout; pipe: string }): string {
  const { layout, pipe } = input;
  const cmd = win32.join(input.systemRoot, 'System32', 'cmd.exe');
  // A quote ends the quoting of a cmd.exe line and a line break ends the line, in either form: no Windows path has one.
  for (const [what, value] of [['The misao.exe path', layout.exe], ['The misao pipe name', pipe], ['The misao folder', layout.root], ['The misao log path', layout.logFile]] as const) {
    if (/["\r\n\0]/.test(value)) throw new Error(`${what} cannot be written to the misao task (it contains a quote or a line break): ${value}`);
  }
  if (![cmd, layout.exe, layout.root, layout.logFile, pipe].every((value) => PLAIN_COMMAND_LINE_PATH.test(value.replace(/^\\\\\.\\pipe\\/, '')))) {
    return misaoLauncherArguments(input);
  }
  const inner = `${quoteForCmd(layout.exe)} serve --socket ${quoteForCmd(pipe)} --data ${quoteForCmd(layout.root)} >> ${quoteForCmd(layout.logFile)} 2>&1`;
  return `--headless ${quoteWindowsArg(cmd)} /d /c "${inner}"`;
}

export interface MisaoTaskInput {
  /** `DOMAIN\user` (or `COMPUTER\user`) the task starts for at logon. */
  userId: string;
  systemRoot: string;
  /** The user's home folder: the daemon's own working directory, so that no pane starts inside (and so locks) a release folder. */
  homeDir: string;
  layout: MisaoWindowsLayout;
  pipe: string;
}

/** The Task Scheduler definition of the misao daemon: started at the user's logon, restarted after a failure (not after a clean `misao stop`). */
export function buildMisaoTaskXml(input: MisaoTaskInput): string {
  return buildTaskXml({
    userId: input.userId,
    description: 'AZITO misao: started at logon by the AZITO hub',
    executable: win32.join(input.systemRoot, 'System32', 'conhost.exe'),
    argumentsLine: misaoTaskArguments(input),
    workingDirectory: input.homeDir,
    restartOnFailure: { intervalMinutes: RESTART_INTERVAL_MINUTES, count: RESTART_COUNT },
  });
}

