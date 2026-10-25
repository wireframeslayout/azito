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
 * Deletes the folder tree below `root` without following a link: the folder and every folder up to the home must be real folders, and
 * a link inside is removed as a link (its target is not entered). A file that cannot be deleted (in use) is reported; the rest goes.
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
    '$walk = $root',
    'while ($walk.TrimEnd([char]92) -ne $homeDir.TrimEnd([char]92)) {',
    '  if (Test-Link $walk) { throw ("Refusing to remove anything: " + $walk + " is a link (junction or symbolic link), and removing below it could delete files outside the home folder") }',
    '  $parent = [System.IO.Path]::GetDirectoryName($walk)',
    '  if ($null -eq $parent -or $parent -eq $walk) { throw ("The folder " + $root + " is not below the home folder " + $homeDir) }',
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

