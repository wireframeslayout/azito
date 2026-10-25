import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';
import { lines, unreadable, type ScriptOutcome } from './windowsAgentUninstallScripts';

/**
 * Looks at what is on the HOST to decide whether something is this install's, so that it is never decided by how a path happens to be
 * spelled (`C:\Users\RUNNER~1\...` and `C:\Users\runneradmin\...` are one folder). A path is put in its long form, with the case it has
 * on disk, component by component; one that cannot be resolved (it does not exist, or cannot be read) is `$null`, and every caller treats
 * "cannot resolve" as "may be the same", never as "different".
 */
const RESOLVE_LONG = [
  'function Resolve-Long([string]$p) {',
  '  try {',
  '    $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($p))',
  '    $cur = [System.IO.Path]::GetPathRoot($full)',
  '    foreach ($part in $full.Substring($cur.Length).Split([char]92)) {',
  '      if ($part -eq \'\') { continue }',
  '      $hit = @([System.IO.Directory]::GetFileSystemEntries($cur, $part))',
  '      if ($hit.Count -ne 1) { return $null }',
  '      $cur = $hit[0]',
  '    }',
  '    return $cur',
  '  } catch { return $null }',
  '}',
];

// ─── The firewall rule ───

const TAILNET_REMOTE = '^100\\.64\\.0\\.0/(10|255\\.192\\.0\\.0)$';

/**
 * The rule the install adds (`New-NetFirewallRule -DisplayName "AZITO Agent (TCP <port>)" -Direction Inbound -Action Allow -Protocol TCP
 * -LocalPort <port> -Program <node.exe> -RemoteAddress 100.64.0.0/10`, see `firewallRuleCommand`; it has no name of its own, so Windows
 * gives it a GUID). The display name is not enough to know a rule is ours, since it is built from the port only: a rule is removed only
 * when it is also an inbound TCP Allow for exactly this port, from the tailnet, and its program is the same FILE as one of `programs`
 * (the node.exe the agent's task runs, and the one found on the host now; both sides are resolved on the host, see {@link RESOLVE_LONG}).
 * Any other rule of that name is left, and reported with its program.
 */
export function firewallScript(displayName: string, port: number, programs: readonly string[]): string {
  const q = powershellDialect.quote;
  return [
    `$name = ${q(displayName)}`,
    `$port = ${q(String(port))}`,
    `$programs = @(${programs.map(q).join(', ')})`,
    ...RESOLVE_LONG,
    '$candidates = @($programs | ForEach-Object { Resolve-Long $_ } | Where-Object { $_ })',
    '$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    '$rules = @(Get-NetFirewallRule -Direction Inbound -ErrorAction Stop | Where-Object { $_.DisplayName -eq $name })',
    'if ($rules.Count -eq 0) { Write-Output \'ABSENT\'; exit 0 }',
    'foreach ($rule in $rules) {',
    '  $program = "$(($rule | Get-NetFirewallApplicationFilter).Program)"',
    '  $filter = $rule | Get-NetFirewallPortFilter',
    '  $remote = (@(($rule | Get-NetFirewallAddressFilter).RemoteAddress) | ForEach-Object { "$_" }) -join \',\'',
    '  $resolved = Resolve-Long $program',
    '  $isOurs = ("$($rule.Action)" -eq \'Allow\') -and ("$($filter.Protocol)" -match \'^(TCP|6)$\') -and ("$($filter.LocalPort)" -eq $port) -and ($null -ne $resolved) -and (@($candidates | Where-Object { $_ -ieq $resolved }).Count -gt 0) -and ($remote -match \'' + TAILNET_REMOTE + '\')',
    '  if (-not $isOurs) { Write-Output (\'KEPT \' + $program); continue }',
    '  try { $rule | Remove-NetFirewallRule -ErrorAction Stop; Write-Output \'REMOVED\' }',
    '  catch { Write-Output (\'FAILED|\' + $rule.Name + \'|\' + [int]$elevated + \'|\' + ($_.Exception.Message -replace \'[\\r\\n|]+\', \' \')) }',
    '}',
  ].join('\n');
}

export function parseFirewallOutput(output: string, displayName: string): ScriptOutcome {
  const all = lines(output);
  if (all.length === 0) throw unreadable(output);
  if (all.length === 1 && all[0] === 'ABSENT') return { outcome: 'absent' };
  const failures = all.filter((l) => l.startsWith('FAILED|')).map((l) => {
    const [, name = '', elevated = '1', ...reason] = l.split('|');
    return { name: name.replace(/'/g, "''"), elevated: elevated === '1', reason: redactSecretText(reason.join('|')).slice(0, 300) };
  });
  if (failures.length > 0) {
    const notElevated = failures.some((f) => !f.elevated);
    const how = notElevated
      ? 'This SSH session is not elevated (the user is not an administrator, or the session has a filtered token), so AZITO cannot remove it.'
      : 'The host refused.';
    // By the rule's own Name, so that the command cannot reach another rule of the same display name that was left on purpose.
    const commands = failures.map((f) => `Remove-NetFirewallRule -Name '${f.name}'`).join('; ');
    return { outcome: 'failed', detail: `The Windows Firewall rule "${displayName}" was not removed (${failures[0]!.reason}). ${how} Run this once in an Administrator PowerShell on the host: ${commands}` };
  }
  const removed = all.filter((l) => l === 'REMOVED').length;
  const kept = all.filter((l) => l.startsWith('KEPT ')).map((l) => redactSecretText(l.slice(5)).slice(0, 200));
  if (kept.length === 0) {
    if (removed === 0) throw unreadable(output);
    return { outcome: 'done' };
  }
  const left = `${kept.length} other rule(s) named "${displayName}" were left in place because they are not known to be this install's (not an inbound TCP Allow for this port, from the tailnet, for the same node.exe file; their program: ${kept.map((k) => k || '(none)').join(', ')}). If one is yours to remove, delete it by hand (by its Name, not by the display name: Get-NetFirewallRule -DisplayName "${displayName}" lists them).`;
  return removed > 0 ? { outcome: 'done', detail: left } : { outcome: 'skipped', detail: left };
}

// ─── Who runs the misao ───

/**
 * The command line of a process that is (or may be) an AZITO hub: the release bundle (`azito-hub.cjs`) or the hub's entry, `main.ts` /
 * `main.js` as a path's last part and not the agent's (`agent/main.ts`): `tsx watch ... src/main.ts` run from `packages/server` as
 * `npm run dev` does, `node packages/server/dist/main.js`, `node dist/main.js`. Whatever else has such an entry (an editor's extension) is
 * taken for a hub too: it is the side that keeps the misao, since a hub started this way has no task to ask. Written as a .NET regex, which
 * is also a JavaScript one, so a test runs it.
 */
export const HUB_COMMAND_LINE_PATTERN = 'azito-hub\\.cjs|(?<=[\\s"\'\\\\/])(?<!agent[\\\\/])main\\.(ts|js)(?=[\\s"\']|$)';

export interface MisaoGuardInput {
  /** The misao folder to remove. */
  root: string;
  /** The folder of the misao the hub registered as `AzitoHub` keeps, when there is such a task; compared with `root` on the host. */
  hubRoot: string | undefined;
  /** No `AzitoHub` task: look for a hub process instead. */
  looksForHub: boolean;
}

/**
 * Before the misao of `root` is touched, on the host: whether the hub's folder is this folder (`SAMEHUB`; `MAYBEHUB` when the hub's folder
 * cannot be resolved, so the two may be the same), whether a hub runs without the `AzitoHub` task (`HUB <pid>`), and whether a `misao.exe`
 * of this folder was started by something other than a task (`FOREIGN <pid>`: none of its parents, up to four levels, is a
 * `conhost.exe --headless`, which is what every task of AZITO runs under). A process whose owner cannot be read is `UNKNOWN <pid>`:
 * not mine and not someone else's, so it is never taken as "not mine". Otherwise `CLEAR`.
 */
export function misaoGuardScript(input: MisaoGuardInput): string {
  const q = powershellDialect.quote;
  return [
    `$root = ${q(input.root)}`,
    ...(input.hubRoot !== undefined ? [`$hubRoot = ${q(input.hubRoot)}`] : []),
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ...RESOLVE_LONG,
    'function Get-Owner($process) {',
    '  try {',
    '    $r = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop',
    '    if ($r.ReturnValue -ne 0 -or -not $r.Sid) { return \'unknown\' }',
    '    if ($r.Sid -eq $me) { return \'mine\' } else { return \'other\' }',
    '  } catch { return \'unknown\' }',
    '}',
    ...(input.hubRoot !== undefined ? [
      '$here = Resolve-Long $root; $hub = Resolve-Long $hubRoot',
      'if ($null -eq $hub) { Write-Output \'MAYBEHUB\'; exit 0 }',
      'if ($null -ne $here -and $here -ieq $hub) { Write-Output \'SAMEHUB\'; exit 0 }',
    ] : []),
    ...(input.looksForHub ? [
      `$hubPattern = ${q(HUB_COMMAND_LINE_PATTERN)}`,
      'foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object { $_.CommandLine -and ($_.CommandLine -match $hubPattern) })) {',
      '  $owner = Get-Owner $candidate',
      '  if ($owner -eq \'unknown\') { Write-Output ("UNKNOWN " + $candidate.ProcessId); exit 0 }',
      '  if ($owner -eq \'mine\') { Write-Output ("HUB " + $candidate.ProcessId); exit 0 }',
      '}',
    ] : []),
    '$pattern = \'(^|[\\s"])\' + [regex]::Escape($root) + \'([\\s"]|$)\'',
    'foreach ($daemon in @(Get-CimInstance Win32_Process -Filter "Name = \'misao.exe\'" | Where-Object { $_.CommandLine -and ($_.CommandLine -match $pattern) })) {',
    '  $owner = Get-Owner $daemon',
    '  if ($owner -eq \'unknown\') { Write-Output ("UNKNOWN " + $daemon.ProcessId); exit 0 }',
    '  if ($owner -ne \'mine\') { continue }',
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

export type MisaoGuardAnswer =
  | { kind: 'clear' }
  | { kind: 'sameHub' }
  | { kind: 'maybeHub' }
  | { kind: 'hub' | 'foreign' | 'unknown'; pid: string };

export function parseMisaoGuardOutput(output: string): MisaoGuardAnswer {
  const last = lines(output).pop() ?? '';
  if (last === 'CLEAR') return { kind: 'clear' };
  if (last === 'SAMEHUB') return { kind: 'sameHub' };
  if (last === 'MAYBEHUB') return { kind: 'maybeHub' };
  const process = /^(HUB|FOREIGN|UNKNOWN) (\d+)$/.exec(last);
  if (process) return { kind: process[1]!.toLowerCase() as 'hub' | 'foreign' | 'unknown', pid: process[2]! };
  throw unreadable(output);
}
