import * as path from 'path';
import { powershellDialect, powershellEncodedArgs } from '../shellDialect';
import { joinWindowsArgs, quoteWindowsArg } from './windowsCommandLine';

const win32 = path.win32;

/** What the misao task's command line is made of: where `misao.exe` is, the data folder, the log and the pipe, and `%SystemRoot%`. */
export interface MisaoTaskArgumentsInput {
  systemRoot: string;
  /** `<root>\<version>\misao.exe`. */
  exe: string;
  /** The daemon's `--data` folder. */
  root: string;
  logFile: string;
  pipe: string;
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
function misaoLauncherScript(input: MisaoTaskArgumentsInput): string {
  const q = powershellDialect.quote;
  const { pipe } = input;
  return [
    '$info = New-Object System.Diagnostics.ProcessStartInfo',
    `$info.FileName = ${q(win32.join(input.systemRoot, 'System32', 'cmd.exe'))}`,
    // %NAME% in the cmd line is replaced by cmd.exe from the environment below, once: a path is never re-read as cmd syntax, whatever it holds.
    `$info.Arguments = ${q('/d /v:off /s /c ""%AZITO_MISAO_EXE%" serve --socket "%AZITO_MISAO_PIPE%" --data "%AZITO_MISAO_ROOT%" >>"%AZITO_MISAO_LOG%" 2>&1"')}`,
    '$info.UseShellExecute = $false',
    '$info.CreateNoWindow = $true',
    `$info.EnvironmentVariables['AZITO_MISAO_EXE'] = ${q(input.exe)}`,
    `$info.EnvironmentVariables['AZITO_MISAO_PIPE'] = ${q(pipe)}`,
    `$info.EnvironmentVariables['AZITO_MISAO_ROOT'] = ${q(input.root)}`,
    `$info.EnvironmentVariables['AZITO_MISAO_LOG'] = ${q(input.logFile)}`,
    '$process = [System.Diagnostics.Process]::Start($info)',
    '$process.WaitForExit()',
    'exit $process.ExitCode',
  ].join('\n');
}

function misaoLauncherArguments(input: MisaoTaskArgumentsInput): string {
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
export function misaoTaskArgumentsOf(input: MisaoTaskArgumentsInput): string {
  const { pipe } = input;
  const cmd = win32.join(input.systemRoot, 'System32', 'cmd.exe');
  // A quote ends the quoting of a cmd.exe line and a line break ends the line, in either form: no Windows path has one.
  for (const [what, value] of [['The misao.exe path', input.exe], ['The misao pipe name', pipe], ['The misao folder', input.root], ['The misao log path', input.logFile]] as const) {
    if (/["\r\n\0]/.test(value)) throw new Error(`${what} cannot be written to the misao task (it contains a quote or a line break): ${value}`);
  }
  if (![cmd, input.exe, input.root, input.logFile, pipe].every((value) => PLAIN_COMMAND_LINE_PATH.test(value.replace(/^\\\\\.\\pipe\\/, '')))) {
    return misaoLauncherArguments(input);
  }
  const inner = `${quoteForCmd(input.exe)} serve --socket ${quoteForCmd(pipe)} --data ${quoteForCmd(input.root)} >> ${quoteForCmd(input.logFile)} 2>&1`;
  return `--headless ${quoteWindowsArg(cmd)} /d /c "${inner}"`;
}

