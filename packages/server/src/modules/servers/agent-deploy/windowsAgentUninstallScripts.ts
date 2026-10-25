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

// ─── Looking at the host ───

/**
 * Looks at what is on the HOST to decide whether something is this install's, so that it is never decided by how a path happens to be
 * spelled (`C:\Users\RUNNER~1\...` and `C:\Users\runneradmin\...` are one folder). A path is put in its long form, with the case it has
 * on disk, component by component. A path with a junction or symbolic link anywhere on the way is NOT resolved either (where it leads is
 * not what its name says, and following it here would be a guess): it is `$null` like one that does not exist or cannot be read, and every
 * caller treats "cannot resolve" as "may be the same", never as "different".
 */
export const RESOLVE_LONG = [
  'function Resolve-Long([string]$p) {',
  '  try {',
  '    $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($p))',
  '    $cur = [System.IO.Path]::GetPathRoot($full)',
  '    foreach ($part in $full.Substring($cur.Length).Split([char]92)) {',
  '      if ($part -eq \'\') { continue }',
  '      $hit = @([System.IO.Directory]::GetFileSystemEntries($cur, $part))',
  '      if ($hit.Count -ne 1) { return $null }',
  '      $cur = $hit[0]',
  '      if ([bool]([System.IO.File]::GetAttributes($cur) -band [System.IO.FileAttributes]::ReparsePoint)) { return $null }',
  '    }',
  '    return $cur',
  '  } catch { return $null }',
  '}',
];

/**
 * Whether a process USES a folder, and the owner of a process, on the host (for scripts that set `$root` to the folder and `$tail` to the
 * part of it below the user's home, e.g. `\.azito\agent`). It errs on the side of finding too many: a false find only keeps a folder.
 * - A process uses the folder when its `ExecutablePath` or its `CommandLine` contains the folder as a path: with `/` read as `\`, in any
 *   case, in the folder's own spelling, in its long form and in its 8.3 form (both as the host resolves them), or just its part below the
 *   home (so that a home spelled another way still counts). A name mixing long and short parts of the folder itself is not found.
 * - `Owner` is `mine`, `other` or `unknown` (the query failed or said nothing); a process of someone else is mostly `unknown` to a user
 *   who is not an administrator, so those are out of reach and are left out: the limit of what a user's session can see.
 * - `Blind` is a process whose `ExecutablePath` or `CommandLine` the host did not give. One that is `mine` is a process that might use the
 *   folder and cannot be told.
 */
export const USES_FOLDER = [
  ...RESOLVE_LONG,
  '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  'function Norm($t) { if ($t) { ($t -replace \'/\', \'\\\').ToLowerInvariant() } else { \'\' } }',
  '$needles = New-Object System.Collections.ArrayList',
  'function Add-Needle($path) { if ($path) { $n = (Norm $path).TrimEnd([char]92) + [char]92; if (-not $needles.Contains($n)) { [void]$needles.Add($n) } } }',
  'Add-Needle $root; Add-Needle (Resolve-Long $root); Add-Needle $tail',
  'Add-Needle $(try { (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath } catch { $null })',
  'function Uses($p) { $text = (Norm $p.ExecutablePath) + "`n" + (Norm $p.CommandLine); foreach ($n in $needles) { if ($text.Contains($n)) { return $true } }; return $false }',
  'function Blind($p) { (-not $p.ExecutablePath) -or (-not $p.CommandLine) }',
  'function Owner($p) {',
  '  try { $r = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop } catch { return \'unknown\' }',
  '  if ($r.ReturnValue -ne 0 -or -not $r.Sid) { return \'unknown\' }',
  '  if ($r.Sid -eq $me) { \'mine\' } else { \'other\' }',
  '}',
];

/** The part of `root` below the user's home, with a leading `\` (`\.azito\agent`); the root itself when it is not below `home`. */
export function tailBelow(home: string, root: string): string {
  const prefix = home.replace(/[\\/]+$/, '');
  return root.toLowerCase().startsWith(`${prefix.toLowerCase()}\\`) ? root.slice(prefix.length) : root;
}

// ─── The processes ───

/**
 * AZITO ends no process itself. The task is ended (`/End`: the Task Scheduler ends what it started), and this only LOOKS, afterwards, for
 * what would be in the way of deleting the folder (see {@link USES_FOLDER} for what "uses the folder" means, and for its limits): it waits up
 * to 10 s for them to go (the agent leaves with its parent), then prints `LEFT|pid|name|path` for each process that uses the folder and
 * `BLIND|pid|name` for each process of the user's own whose path or command line the host did not give (it cannot be told whether it uses
 * the folder); nothing is touched. Nothing at all is `CLEAR`. A process list that cannot be read is an error, never `CLEAR`.
 */
export function leftoverProcessesScript(root: string, home: string): string {
  const q = powershellDialect.quote;
  return [
    `$root = ${q(root)}; $tail = ${q(tailBelow(home, root))}`,
    ...USES_FOLDER,
    'function All { @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID }) }',
    'function Find-Left { @(All | Where-Object { Uses $_ }) }',
    '$left = Find-Left',
    'for ($i = 0; $i -lt 20 -and $left.Count -gt 0; $i++) { Start-Sleep -Milliseconds 500; $left = Find-Left }',
    '$blind = @(All | Where-Object { (Blind $_) -and -not (Uses $_) -and (Owner $_) -eq \'mine\' })',
    'function Clean($t) { "$t" -replace \'[\\r\\n|]+\', \' \' }',
    'foreach ($p in $left) { Write-Output (\'LEFT|\' + $p.ProcessId + \'|\' + (Clean $p.Name) + \'|\' + (Clean $p.ExecutablePath)) }',
    'foreach ($p in $blind) { Write-Output (\'BLIND|\' + $p.ProcessId + \'|\' + (Clean $p.Name)) }',
    'if ($left.Count -eq 0 -and $blind.Count -eq 0) { Write-Output \'CLEAR\' }',
  ].join('\n');
}

export function parseLeftoverOutput(output: string, root: string): ScriptOutcome {
  const all = lines(output);
  if (all.length === 1 && all[0] === 'CLEAR') return { outcome: 'absent' };
  const left = all.filter((l) => l.startsWith('LEFT|')).map((l) => {
    const [, pid = '', name = '', exe = ''] = l.split('|');
    return { pid, name: redactSecretText(name).slice(0, 100), exe: redactSecretText(exe).slice(0, 300) };
  });
  const blind = all.filter((l) => l.startsWith('BLIND|')).map((l) => {
    const [, pid = '', name = ''] = l.split('|');
    return { pid, name: redactSecretText(name).slice(0, 100) };
  });
  if (left.length === 0 && blind.length === 0) throw unreadable(output);
  const parts: string[] = [];
  if (left.length > 0) {
    const listed = left.map((p) => `${p.name} (process ${p.pid}${p.exe ? `, ${p.exe}` : ''})`).join('; ');
    parts.push(`The task was ended, but ${left.length === 1 ? 'a process is' : `${left.length} processes are`} still running from ${root}: ${listed}. AZITO does not stop ${left.length === 1 ? 'it' : 'them'}: check what ${left.length === 1 ? 'it is' : 'they are'} and stop ${left.length === 1 ? 'it' : 'them'} yourself (Stop-Process -Id <pid>).`);
  }
  if (blind.length > 0) {
    const listed = blind.map((p) => `${p.name} (process ${p.pid})`).join('; ');
    parts.push(`The host did not give the program or the command line of ${blind.length === 1 ? 'a process of yours' : `${blind.length} processes of yours`}, so it cannot be told whether ${blind.length === 1 ? 'it uses' : 'they use'} ${root}: ${listed}. Check ${blind.length === 1 ? 'it' : 'them'}.`);
  }
  return { outcome: 'failed', detail: `${parts.join(' ')} The folder was left; delete it, or remove the server again, once that is settled. (Processes of other users cannot be seen from this session.)` };
}
