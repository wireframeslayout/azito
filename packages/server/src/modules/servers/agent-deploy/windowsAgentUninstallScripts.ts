import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';
import { ROOT_TOKEN, type ProcessShape } from './windowsAgentTask';

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

/** `ENDED <n>` from {@link buildEndProcessesScript}: none found = there was nothing to end. */
export function parseProcessesOutput(output: string): ScriptOutcome {
  const count = /^ENDED (\d+)$/m.exec(output.replace(/\r/g, ''))?.[1];
  if (count === undefined) throw unreadable(output);
  return Number(count) === 0 ? { outcome: 'absent' } : { outcome: 'done', detail: `${count} process(es) ended` };
}

/**
 * Ends the processes that are the install's and no others, on the host. A process counts only when ALL of this holds: its image name is
 * `image`; its command line, with the quotes taken out, starts with its own `ExecutablePath` (so the first word is the program itself,
 * not an argument that looks like it); `ExecutablePath` as a whole matches `shape.exe`; and what follows matches `shape.tail` as a
 * whole. Whole-line matches: an extra argument, or the install's file inside another argument, does not count. The owner of each
 * candidate is read: another user's process is left, and one whose owner cannot be read STOPS the step (an error), since a process that is
 * not ended while the folder under it is deleted is the failure to avoid. With `endParentConhost`, the `conhost.exe` that started such a
 * process is ended with it when its own command line ends with ` --headless <the process's line>`, it is no younger than the process
 * and it is the same user's. Prints `ENDED <n>`: how many such processes there were (0: nothing to end). Throws when one is still there
 * after 10 s.
 */
export function exactProcessesScript(input: { image: string; shape: ProcessShape; label: string; endParentConhost: boolean }): string {
  const q = powershellDialect.quote;
  const unreadable = (what: string): string => `throw ("The owner of the process " + $p.ProcessId + " could not be read, so it is not known whether it ${what} the ${input.label} of this install")`;
  return [
    // The pieces of the shape that name the install's folder get it once, escaped, here.
    `$root = ${q(input.shape.root)}; $r = [regex]::Escape($root)`,
    `$exePattern = (${q(input.shape.exe)}).Replace(${q(ROOT_TOKEN)}, $r)`,
    `$tailPattern = '^(?:' + (${q(input.shape.tail)}).Replace(${q(ROOT_TOKEN)}, $r) + ')$'`,
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    // 'mine', 'other', or 'unknown' (the query failed): never folded into one of the others.
    'function Owner($p) {',
    '  try { $r = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop } catch { return \'unknown\' }',
    '  if ($r.ReturnValue -ne 0 -or -not $r.Sid) { return \'unknown\' }',
    '  if ($r.Sid -eq $me) { \'mine\' } else { \'other\' }',
    '}',
    // Quotes out, and the blanks at the ends (cmd.exe leaves one where it cut the redirects off) trimmed.
    'function Line($p) { if ($p.CommandLine) { $p.CommandLine.Replace(\'"\', \'\').Trim() } else { \'\' } }',
    'function Shaped($p) {',
    '  $e = $p.ExecutablePath; $l = Line $p',
    '  [bool]($e -and $e -match $exePattern -and $l.StartsWith($e + \' \', [System.StringComparison]::OrdinalIgnoreCase) -and $l.Substring($e.Length + 1) -match $tailPattern)',
    '}',
    'function Same($t) { $c = Get-CimInstance Win32_Process -Filter "ProcessId = $($t.Id)"; if ($c -and $c.CreationDate -eq $t.Created) { $c } }',
    '$found = @(); $targets = @()',
    `foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = ${q(input.image)}" | Where-Object { Shaped $_ })) {`,
    '  $o = Owner $p',
    `  if ($o -eq 'unknown') { ${unreadable('is')} }`,
    '  if ($o -ne \'mine\') { continue }',
    '  $found += $p; $targets += [pscustomobject]@{ Id = $p.ProcessId; Created = $p.CreationDate }',
    ...(input.endParentConhost ? [
      '  $c = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"',
      '  if ($c -and $c.Name -eq \'conhost.exe\' -and $c.CreationDate -le $p.CreationDate -and (Line $c).EndsWith(\' --headless \' + (Line $p), [System.StringComparison]::OrdinalIgnoreCase)) {',
      '    $o = Owner $c',
      `    if ($o -eq 'unknown') { $p = $c; ${unreadable('started')} }`,
      '    if ($o -eq \'mine\') { $targets += [pscustomobject]@{ Id = $c.ProcessId; Created = $c.CreationDate } }',
      '  }',
    ] : []),
    '}',
    'foreach ($t in $targets) { if (Same $t) { Stop-Process -Id $t.Id -Force -ErrorAction SilentlyContinue } }',
    'function Alive { @($targets | Where-Object { Same $_ }) }',
    'for ($i = 0; $i -lt 20 -and (Alive).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }',
    `if ((Alive).Count -gt 0) { throw "A ${input.label} process did not end: $((Alive | ForEach-Object { $_.Id }) -join ', ')" }`,
    '"ENDED $($found.Count)"',
  ].join('\n');
}
