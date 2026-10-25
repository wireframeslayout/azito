import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';

/**
 * - `done`: it was there and is gone now (for the processes: they were running and are ended).
 * - `absent`: there was nothing to remove (for the processes: none was running).
 * - `failed`: it could not be removed, or the host could not be asked; `detail` says why and what to do.
 * - `skipped`: not attempted or not removed on purpose; `detail` says why.
 */
export type UninstallOutcome = 'done' | 'absent' | 'failed' | 'skipped';

/** What a step script answered, before it is worded: an outcome and the detail that goes with it. */
export interface ScriptOutcome {
  outcome: UninstallOutcome;
  detail?: string;
}

export const lines = (output: string): string[] => output.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l !== '');

export function unreadable(output: string): Error {
  return new Error(`The host's answer could not be read: ${redactSecretText(output.trim()).slice(0, 300) || 'nothing'}`);
}

// ─── The folder ───

/**
 * Deletes the folder tree below `root` without following a link: the folder and EVERY folder above it, up to the drive's root, must be
 * real folders that can be looked at (not a junction or symbolic link, whose target would be the thing deleted; not one that cannot be
 * queried), and a link inside is removed as a link (its target is not entered). A file that cannot be deleted (in use) is reported; the rest goes.
 * A folder that is not there is `ABSENT`; any other reason the folder cannot be looked at (access denied) is an error, never `ABSENT`.
 * The same race as the old-version prune remains and is accepted: a folder can be swapped for a link between the check and the delete,
 * which only the owner of the owner-only folder or an administrator can do, and either can already delete what the link reaches.
 */
export function folderScript(home: string, root: string): string {
  const q = powershellDialect.quote;
  return [
    `$homeDir = ${q(home)}`,
    `$root = ${q(root)}`,
    'function Test-Link($path) { return [bool]((Get-Item -LiteralPath $path -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) }',
    'try { $null = Get-Item -LiteralPath $root -Force -ErrorAction Stop } catch { if ($_.CategoryInfo.Category -eq \'ObjectNotFound\') { Write-Output \'ABSENT\'; exit 0 } else { throw } }',
    'if (-not $root.StartsWith($homeDir.TrimEnd([char]92) + [char]92, [System.StringComparison]::OrdinalIgnoreCase)) { throw ("The folder " + $root + " is not below the home folder " + $homeDir) }',
    '$driveRoot = [System.IO.Path]::GetPathRoot($root)',
    '$walk = $root',
    'while ($walk.TrimEnd([char]92) -ne $driveRoot.TrimEnd([char]92)) {',
    '  try { $isLink = Test-Link $walk } catch { throw ("Refusing to remove anything: " + $walk + " cannot be looked at (" + $_.Exception.Message + ")") }',
    '  if ($isLink) { throw ("Refusing to remove anything: " + $walk + " is a link (junction or symbolic link), and removing below it could delete files elsewhere") }',
    '  $parent = [System.IO.Path]::GetDirectoryName($walk)',
    '  if ($null -eq $parent -or $parent -eq $walk) { break }',
    '  $walk = $parent',
    '}',
    '$problems = New-Object System.Collections.ArrayList',
    'function Remove-Tree([string]$dir) {',
    '  foreach ($entry in [System.IO.Directory]::GetFileSystemEntries($dir)) {',
    '    try {',
    '      $attributes = [System.IO.File]::GetAttributes($entry)',
    '      $isDirectory = [bool]($attributes -band [System.IO.FileAttributes]::Directory)',
    '      if ([bool]($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {',
    '        if ($isDirectory) { [System.IO.Directory]::Delete($entry) } else { [System.IO.File]::Delete($entry) }',
    '      } elseif ($isDirectory) {',
    '        Remove-Tree $entry',
    '      } else {',
    '        [System.IO.File]::SetAttributes($entry, [System.IO.FileAttributes]::Normal)',
    '        [System.IO.File]::Delete($entry)',
    '      }',
    '    } catch { [void]$problems.Add($entry + ": " + $_.Exception.Message) }',
    '  }',
    '  try { [System.IO.File]::SetAttributes($dir, [System.IO.FileAttributes]::Directory); [System.IO.Directory]::Delete($dir) } catch { [void]$problems.Add($dir + ": " + $_.Exception.Message) }',
    '}',
    'Remove-Tree $root',
    'if ($problems.Count -gt 0) { Write-Output (\'FAILED \' + $problems.Count + \' item(s) could not be removed (a file in use? end the program that holds it, then delete the folder by hand): \' + ((@($problems | Select-Object -First 3) -join \'; \') -replace \'[\\r\\n]+\', \' \')) } else { Write-Output \'DONE\' }',
  ].join('\n');
}

export function parseFolderOutput(output: string): ScriptOutcome {
  const last = lines(output).pop() ?? '';
  if (last === 'DONE') return { outcome: 'done' };
  if (last === 'ABSENT') return { outcome: 'absent' };
  const reason = /^FAILED (.*)$/.exec(last)?.[1];
  if (reason !== undefined) return { outcome: 'failed', detail: redactSecretText(reason).slice(0, 600) };
  throw unreadable(output);
}

// ─── The processes ───

/**
 * AZITO ends no process itself. The task is ended (`/End`: the Task Scheduler ends what it started), and this only LOOKS, afterwards, for
 * what would be in the way of deleting the folder: any process whose program is a file under `root`, or whose command line names a path
 * under `root` (the agent's node.exe runs a script there). It waits up to 10 s for them to go (the agent leaves with its parent; a misao
 * stopped through its pipe leaves with it). What is still there is printed as `LEFT|pid|name|path` and nothing is touched; no leftover is
 * `CLEAR`. A process list that cannot be read is an error, never `CLEAR`.
 */
export function leftoverProcessesScript(root: string): string {
  const q = powershellDialect.quote;
  return [
    `$prefix = ${q(root)}.TrimEnd([char]92) + [char]92`,
    'function Find-Left { @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) }) }',
    '$left = Find-Left',
    'for ($i = 0; $i -lt 20 -and $left.Count -gt 0; $i++) { Start-Sleep -Milliseconds 500; $left = Find-Left }',
    'foreach ($p in $left) { Write-Output (\'LEFT|\' + $p.ProcessId + \'|\' + ($p.Name -replace \'[\\r\\n|]+\', \' \') + \'|\' + ($p.ExecutablePath -replace \'[\\r\\n|]+\', \' \')) }',
    'if ($left.Count -eq 0) { Write-Output \'CLEAR\' }',
  ].join('\n');
}

export function parseLeftoverOutput(output: string, root: string): ScriptOutcome {
  const all = lines(output);
  if (all.length === 1 && all[0] === 'CLEAR') return { outcome: 'absent' };
  const left = all.filter((l) => l.startsWith('LEFT|')).map((l) => {
    const [, pid = '', name = '', exe = ''] = l.split('|');
    return { pid, name: redactSecretText(name).slice(0, 100), exe: redactSecretText(exe).slice(0, 300) };
  });
  if (left.length === 0) throw unreadable(output);
  const listed = left.map((p) => `${p.name} (process ${p.pid}${p.exe ? `, ${p.exe}` : ''})`).join('; ');
  return {
    outcome: 'failed',
    detail: `The task was ended, but ${left.length === 1 ? 'a process is' : `${left.length} processes are`} still running from ${root}: ${listed}. AZITO does not stop it, and the folder was left. Check what it is, stop it yourself (Stop-Process -Id <pid>), then delete the folder or remove the server again.`,
  };
}

/**
 * `misao stop` through the daemon's own pipe: what the misao installer does before it switches a release, and the one stop AZITO asks of a
 * misao daemon (its panes close). Only the `misao.exe` the recognised task runs is started, with the pipe of the task; it is given 30 s. A
 * daemon that is not there (the task's end took it down) makes it fail, which is fine: {@link leftoverProcessesScript} is what decides.
 */
export function misaoStopScript(exe: string, pipe: string): string {
  const q = powershellDialect.quote;
  return [
    `$exe = ${q(exe)}`,
    'if (Test-Path -LiteralPath $exe -PathType Leaf) {',
    `  $env:MISAO_SOCKET = ${q(pipe)}`,
    '  try {',
    '    $stop = Start-Process -FilePath $exe -ArgumentList \'stop\' -WindowStyle Hidden -PassThru',
    '    if (-not $stop.WaitForExit(30000)) { Stop-Process -Id $stop.Id -Force -ErrorAction SilentlyContinue }',
    '  } catch { }',
    '}',
    'Write-Output \'DONE\'',
  ].join('\n');
}
