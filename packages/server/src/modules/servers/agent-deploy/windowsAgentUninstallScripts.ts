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

const lines = (output: string): string[] => output.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l !== '');

function unreadable(output: string): Error {
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

// ─── The firewall rule ───

const TAILNET_REMOTE = '^100\\.64\\.0\\.0/(10|255\\.192\\.0\\.0)$';

/**
 * The rule the install adds (`New-NetFirewallRule -DisplayName "AZITO Agent (TCP <port>)" -Direction Inbound -Action Allow -Protocol TCP
 * -LocalPort <port> -Program <node.exe> -RemoteAddress 100.64.0.0/10`, see `firewallRuleCommand`; it has no name of its own, so Windows
 * gives it a GUID). The display name is not enough to know a rule is ours, since it is built from the port only: a rule is removed only
 * when it is also an inbound TCP Allow for exactly this port, for one of `programs` (the node.exe the agent's task runs, and the one
 * found on the host now), from the tailnet range. Any other rule of that name is left, and reported with its program.
 */
export function firewallScript(displayName: string, port: number, programs: readonly string[]): string {
  const q = powershellDialect.quote;
  return [
    `$name = ${q(displayName)}`,
    `$port = ${q(String(port))}`,
    `$programs = @(${programs.map(q).join(', ')})`,
    '$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    '$rules = @(Get-NetFirewallRule -Direction Inbound -ErrorAction Stop | Where-Object { $_.DisplayName -eq $name })',
    'if ($rules.Count -eq 0) { Write-Output \'ABSENT\'; exit 0 }',
    'foreach ($rule in $rules) {',
    '  $program = "$(($rule | Get-NetFirewallApplicationFilter).Program)"',
    '  $filter = $rule | Get-NetFirewallPortFilter',
    '  $remote = (@(($rule | Get-NetFirewallAddressFilter).RemoteAddress) | ForEach-Object { "$_" }) -join \',\'',
    '  $isOurs = ("$($rule.Action)" -eq \'Allow\') -and ("$($filter.Protocol)" -match \'^(TCP|6)$\') -and ("$($filter.LocalPort)" -eq $port) -and (@($programs | Where-Object { $_ -ieq $program }).Count -gt 0) -and ($remote -match \'' + TAILNET_REMOTE + '\')',
    '  if (-not $isOurs) { Write-Output (\'KEPT \' + $program); continue }',
    '  try { $rule | Remove-NetFirewallRule -ErrorAction Stop; Write-Output \'REMOVED\' }',
    '  catch { $reason = ($_.Exception.Message -replace \'[\\r\\n]+\', \' \'); if ($elevated) { Write-Output (\'FAILED \' + $reason) } else { Write-Output (\'FAILED NOTELEVATED \' + $reason) } }',
    '}',
  ].join('\n');
}

export function parseFirewallOutput(output: string, displayName: string): ScriptOutcome {
  const all = lines(output);
  if (all.length === 0) throw unreadable(output);
  if (all.length === 1 && all[0] === 'ABSENT') return { outcome: 'absent' };
  const failure = all.find((l) => l.startsWith('FAILED '));
  if (failure !== undefined) {
    const notElevated = failure.startsWith('FAILED NOTELEVATED ');
    const reason = redactSecretText(failure.replace(/^FAILED (NOTELEVATED )?/, '')).slice(0, 300);
    const how = notElevated
      ? 'This SSH session is not elevated (the user is not an administrator, or the session has a filtered token), so AZITO cannot remove it.'
      : 'The host refused.';
    return { outcome: 'failed', detail: `The Windows Firewall rule "${displayName}" was not removed (${reason}). ${how} Run this once in an Administrator PowerShell on the host: Remove-NetFirewallRule -DisplayName "${displayName}"` };
  }
  const removed = all.filter((l) => l === 'REMOVED').length;
  const kept = all.filter((l) => l.startsWith('KEPT ')).map((l) => redactSecretText(l.slice(5)).slice(0, 200));
  if (kept.length === 0) {
    if (removed === 0) throw unreadable(output);
    return { outcome: 'done' };
  }
  const left = `${kept.length} other rule(s) named "${displayName}" were left in place because they are not known to be this install's (not an inbound TCP Allow for this port, from the tailnet, for this agent's node.exe; their program: ${kept.map((k) => k || '(none)').join(', ')}). If one is yours to remove, delete it by hand.`;
  return removed > 0 ? { outcome: 'done', detail: left } : { outcome: 'skipped', detail: left };
}

// ─── Who runs the misao ───

/**
 * Looks, before the misao of `root` is touched, for what would make it someone else's: a hub that runs without the `AzitoHub` task
 * (started from a source checkout or by hand: it is found by its command line, and only asked for when `looksForHub`), and a
 * `misao.exe` of this folder that was not started by a task (none of its parents, up to four levels, is a `conhost.exe --headless`, which
 * is what every task of AZITO runs under). `HUB <pid>`, `FOREIGN <pid>` or `CLEAR`.
 */
export function misaoGuardScript(root: string, looksForHub: boolean): string {
  const q = powershellDialect.quote;
  return [
    `$root = ${q(root)}`,
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    'function Test-Mine($process) { try { (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $me } catch { $false } }',
    ...(looksForHub ? [
      '$hub = @(Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object { $_.CommandLine -match \'azito-hub\\.cjs|packages[\\\\/]server[\\\\/](src[\\\\/]main\\.ts|dist[\\\\/]main\\.js)\' -and (Test-Mine $_) })',
      'if ($hub.Count -gt 0) { Write-Output ("HUB " + $hub[0].ProcessId); exit 0 }',
    ] : []),
    '$pattern = \'(^|[\\s"])\' + [regex]::Escape($root) + \'([\\s"]|$)\'',
    'foreach ($daemon in @(Get-CimInstance Win32_Process -Filter "Name = \'misao.exe\'" | Where-Object { $_.CommandLine -and ($_.CommandLine -match $pattern) -and (Test-Mine $_) })) {',
    '  $id = $daemon.ParentProcessId; $byTask = $false',
    '  for ($i = 0; $i -lt 4 -and $id; $i++) {',
    '    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $id"',
    '    if (-not $parent) { break }',
    '    if ($parent.Name -eq \'conhost.exe\' -and $parent.CommandLine -match \'--headless\') { $byTask = $true; break }',
    '    $id = $parent.ParentProcessId',
    '  }',
    '  if (-not $byTask) { Write-Output ("FOREIGN " + $daemon.ProcessId); exit 0 }',
    '}',
    'Write-Output \'CLEAR\'',
  ].join('\n');
}

export type MisaoGuardAnswer = { kind: 'clear' } | { kind: 'hub'; pid: string } | { kind: 'foreign'; pid: string };

export function parseMisaoGuardOutput(output: string): MisaoGuardAnswer {
  const last = lines(output).pop() ?? '';
  if (last === 'CLEAR') return { kind: 'clear' };
  const hub = /^HUB (\d+)$/.exec(last)?.[1];
  if (hub !== undefined) return { kind: 'hub', pid: hub };
  const foreign = /^FOREIGN (\d+)$/.exec(last)?.[1];
  if (foreign !== undefined) return { kind: 'foreign', pid: foreign };
  throw unreadable(output);
}
