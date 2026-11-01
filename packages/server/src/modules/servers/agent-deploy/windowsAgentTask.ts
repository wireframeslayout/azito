import * as path from 'path';
import type { TaskExecAction } from '../../../shared/os/taskScheduler/taskXmlRead';
import { joinWindowsArgs } from '../../../shared/os/taskScheduler/windowsCommandLine';
import { KILL_CHILDREN_JOB, compressedTaskScript, decodedTaskScript, sameTaskAction } from '../../../shared/os/taskScheduler/taskLauncher';
import { powershellDialect, powershellEncodedArgs } from '../../../shared/os/shellDialect';

/** A release folder's name: what `windowsAgentLayout` accepts as a version. */
export const RELEASE_NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';
const AGENT_VERSION_IN_ENTRY = new RegExp(`\\\\(${RELEASE_NAME})\\\\azito-agent\\.cjs"?$`);

/** The `conhost.exe` both tasks run under (`--headless` gives the program a console without a window). */
function conhostOf(systemRoot: string): string {
  return path.win32.join(systemRoot, 'System32', 'conhost.exe');
}

/**
 * The program and the arguments of the agent's logon task. The ONE definition: the install writes the task from it, and the removal
 * recognises the install's task by building the same text again and comparing, not by parsing whatever is registered.
 */
export function legacyAgentTaskAction(systemRoot: string, nodePath: string, envFile: string, entry: string): { executable: string; args: string[] } {
  return { executable: conhostOf(systemRoot), args: ['--headless', nodePath, `--env-file=${envFile}`, entry] };
}

export function agentLauncherScript(nodePath: string, envFile: string, entry: string, taskName: string): string {
  const q = powershellDialect.quote;
  return [
    `$node = ${q(nodePath)}`, `$envFile = ${q(envFile)}`, `$entry = ${q(entry)}`, `$taskName = ${q(taskName)}`,
    '$log = Join-Path (Split-Path -Parent $envFile) \'agent.log\'',
    'function Log($m) { try { [IO.File]::AppendAllText($log, "[$([DateTime]::UtcNow.ToString(\'o\'))] launcher: $m`r`n") } catch {} }',
    'try { $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId; $parentStart = (Get-Process -Id $parentId).StartTime } catch { Log "cannot find parent: $_"; exit 1 }',
    'function ParentAlive { $p = Get-Process -Id $parentId -ErrorAction SilentlyContinue; return ($p -and $p.StartTime -eq $parentStart) }',
    '$delay = 5',
    'while (ParentAlive) {',
    '  try { if (-not (Get-ScheduledTask -TaskPath \'\\\' -TaskName $taskName -ErrorAction Stop).Settings.Enabled) { Log "task disabled: not restarting"; exit 0 } } catch { Log "cannot check task state: $_"; exit 1 }',
    '  if (-not (ParentAlive)) { exit 0 }',
    '  $began = [DateTime]::UtcNow; $code = 1',
    '  try {',
    '    $info = New-Object System.Diagnostics.ProcessStartInfo',
    '    $info.FileName = $node; $info.Arguments = \'"--env-file=\' + $envFile + \'" "\' + $entry + \'"\'; $info.UseShellExecute = $false; $info.CreateNoWindow = $true',
    '    $child = [Diagnostics.Process]::Start($info)',
    '    while (-not $child.WaitForExit(1000)) { if (-not (ParentAlive)) { $child.Kill(); $child.WaitForExit(); exit 0 } }',
    '    $code = $child.ExitCode',
    '  } catch { Log "start failed: $_" }',
    '  if ($code -eq 0) { exit 0 }',
    '  if (([DateTime]::UtcNow - $began).TotalSeconds -ge 300) { $delay = 5 }',
    '  Log "exit $code; retry in $delay seconds"',
    '  for ($i = 0; $i -lt $delay; $i++) { if (-not (ParentAlive)) { exit 0 }; Start-Sleep -Seconds 1 }',
    '  $delay = [Math]::Min(60, $delay * 2)',
    '}',
  ].join('\n');
}

export function agentTaskAction(systemRoot: string, nodePath: string, envFile: string, entry: string, taskName: string): { executable: string; args: string[] } {
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = agentLauncherScript(nodePath, envFile, entry, taskName);
  const logEnd = script.indexOf('\ntry { $parentId');
  const withJob = `${script.slice(0, logEnd)}\n${KILL_CHILDREN_JOB}\n${script.slice(logEnd)}`;
  const args = ['--headless', powershell, ...powershellEncodedArgs(compressedTaskScript(withJob))];
  if (joinWindowsArgs(args).length + conhostOf(systemRoot).length + 3 > 8191) throw new Error('The agent task command line exceeds the Windows limit');
  return { executable: conhostOf(systemRoot), args };
}

/** What the removal learns from a task it has recognised as the install's. */
export interface AgentTaskIdentity {
  nodePath: string;
  /** The release folder the task runs the agent from. */
  version: string;
  launcher?: boolean;
}

/**
 * The node.exe and the release folder the task runs when `action` is exactly what the install writes for the install in `root` (settings
 * file `envFile`): the same program, and an arguments line equal, character for character, to the one {@link agentTaskAction} makes for that
 * node.exe and a release folder of this install. Anything else (an extra or missing argument, quotes or backslashes in another form,
 * another folder, a hand-edited line) is undefined: it is not known to be the install's, so it is left alone.
 *
 * The node.exe and the release folder are the two parts the removal cannot know in advance. The node.exe has to be one token that is
 * quoted exactly as `joinWindowsArgs` quotes that path; the release folder has to be a plain version name; the rest is compared whole.
 */
export function agentTaskIdentity(action: TaskExecAction, systemRoot: string, root: string, envFile: string, taskName: string): AgentTaskIdentity | undefined {
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(action.argumentsLine)?.[1];
  if (encoded) {
    const script = decodedTaskScript(encoded);
    if (!script) return undefined;
    const match = /\$node = '((?:''|[^'])*)'\n\$envFile = '((?:''|[^'])*)'\n\$entry = '((?:''|[^'])*)'/.exec(script);
    if (!match) return undefined;
    const [nodePath, foundEnv, entry] = match.slice(1).map((v) => v!.replace(/(['‘’‚‛])\1/g, '$1'));
    if (!nodePath || foundEnv !== envFile || !entry || !/^[A-Za-z]:\\/.test(nodePath) || path.win32.basename(nodePath).toLowerCase() !== 'node.exe') return undefined;
    const version = AGENT_VERSION_IN_ENTRY.exec(entry)?.[1];
    if (!version || entry !== path.win32.join(root, version, 'azito-agent.cjs')) return undefined;
    const expected = agentTaskAction(systemRoot, nodePath, envFile, entry, taskName);
    return action.command.toLowerCase() === expected.executable.toLowerCase() && sameTaskAction(action.argumentsLine, joinWindowsArgs(expected.args)) ? { nodePath, version, launcher: true } : undefined;
  }
  const head = `${joinWindowsArgs(['--headless'])} `;
  if (action.command.toLowerCase() !== conhostOf(systemRoot).toLowerCase()) return undefined;
  if (!action.argumentsLine.startsWith(head)) return undefined;
  const split = /^("[^"]+"|[^"\s]+) ([\s\S]+)$/.exec(action.argumentsLine.slice(head.length));
  if (!split) return undefined;
  const [, nodeToken, tail] = split as unknown as [string, string, string];
  const nodePath = nodeToken.startsWith('"') ? nodeToken.slice(1, -1) : nodeToken;
  if (joinWindowsArgs([nodePath]) !== nodeToken) return undefined;
  // A program that is not an absolute path to a file called node.exe is not the install's, however well the rest fits.
  if (!/^[A-Za-z]:\\/.test(nodePath) || path.win32.basename(nodePath).toLowerCase() !== 'node.exe') return undefined;
  const version = AGENT_VERSION_IN_ENTRY.exec(tail)?.[1];
  if (version === undefined) return undefined;
  const expected = legacyAgentTaskAction(systemRoot, nodePath, envFile, path.win32.join(root, version, 'azito-agent.cjs'));
  return tail === joinWindowsArgs(expected.args.slice(2)) ? { nodePath, version } : undefined;
}
