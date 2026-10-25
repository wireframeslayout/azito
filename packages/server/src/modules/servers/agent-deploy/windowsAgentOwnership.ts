import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';
import { RESOLVE_LONG, USES_FOLDER, lines, tailBelow, unreadable, type ScriptOutcome } from './windowsAgentUninstallScripts';

// ─── The firewall rule ───

/**
 * Looks for the rule the install adds (`New-NetFirewallRule -DisplayName "AZITO Agent (TCP <port>)" -Direction Inbound ...`, see
 * `firewallRuleCommand`; it has no name of its own, so Windows gives it a GUID) and REPORTS it. Nothing is removed: a display name built
 * from the port says what the install called the rule, not that this rule is the install's, and there are more conditions on a rule than
 * a person or a script can be sure to have compared. Each rule found is printed as `RULE|name|action|profile|program|protocol|port|local|remote`
 * and the person is told how to remove the one that is the install's. A list that cannot be read is an error, never "no rule".
 */
export function firewallInspectScript(displayName: string): string {
  const q = powershellDialect.quote;
  return [
    `$name = ${q(displayName)}`,
    'function Join-All($values) { (@($values) | ForEach-Object { "$_" }) -join \',\' }',
    'function Clean($text) { ("$text" -replace \'[\\r\\n|]+\', \' \') }',
    '$rules = @(Get-NetFirewallRule -Direction Inbound -ErrorAction Stop | Where-Object { $_.DisplayName -eq $name })',
    'if ($rules.Count -eq 0) { Write-Output \'ABSENT\'; exit 0 }',
    'foreach ($rule in $rules) {',
    '  $app = $rule | Get-NetFirewallApplicationFilter; $ports = $rule | Get-NetFirewallPortFilter; $address = $rule | Get-NetFirewallAddressFilter',
    '  Write-Output (\'RULE|\' + (Clean $rule.Name) + \'|\' + (Clean $rule.Action) + \'|\' + (Clean $rule.Profile) + \'|\' + (Clean $app.Program) + \'|\' + (Clean $ports.Protocol) + \'|\' + (Clean (Join-All $ports.LocalPort)) + \'|\' + (Clean (Join-All $address.LocalAddress)) + \'|\' + (Clean (Join-All $address.RemoteAddress)))',
    '}',
  ].join('\n');
}

export function parseFirewallOutput(output: string, displayName: string): ScriptOutcome {
  const all = lines(output);
  if (all.length === 0) throw unreadable(output);
  if (all.length === 1 && all[0] === 'ABSENT') return { outcome: 'absent' };
  const rules = all.filter((l) => l.startsWith('RULE|')).map((l) => {
    const [, name = '', action = '', profile = '', program = '', protocol = '', port = '', local = '', remote = ''] = l.split('|').map((v) => redactSecretText(v).slice(0, 200));
    return { name, action, profile, program, protocol, port, local, remote };
  });
  if (rules.length === 0) throw unreadable(output);
  const listed = rules.map((r) => `- Name ${r.name}: ${r.action} ${r.protocol} port ${r.port}, program ${r.program || '(any)'}, local address ${r.local || '(any)'}, remote ${r.remote || '(any)'}, profile ${r.profile}`).join('\n');
  const commands = rules.map((r) => `Remove-NetFirewallRule -Name '${r.name.replace(/'/g, "''")}'`).join('\n');
  return {
    outcome: 'skipped',
    detail: `AZITO does not remove firewall rules by itself. ${rules.length} inbound rule(s) named "${displayName}" (the name the install gives its rule) ${rules.length === 1 ? 'was' : 'were'} found and left in place:\n${listed}\nLeaving ${rules.length === 1 ? 'this rule' : 'these rules'} does no harm: the agent is removed, so nothing listens on that port and ${rules.length === 1 ? 'the rule opens' : 'the rules open'} nothing new. Only if you want ${rules.length === 1 ? 'it' : 'them'} gone, check that ${rules.length === 1 ? 'it is' : 'each is'} the rule the install added (an Allow for TCP on the agent's port, for this agent's node.exe, from the Tailscale range 100.64.0.0/10), then remove ${rules.length === 1 ? 'it' : 'them'} in an Administrator PowerShell:\n${commands}`,
  };
}

/**
 * Whether two paths on the host are the same file, each put in its long form (see {@link RESOLVE_LONG}): `SAME`, `DIFFERENT`, or `UNKNOWN`
 * when either cannot be resolved (it does not exist, cannot be read, or a junction or symbolic link is on the way to it).
 */
export function sameFileScript(a: string, b: string): string {
  const q = powershellDialect.quote;
  return [
    ...RESOLVE_LONG,
    `$a = Resolve-Long ${q(a)}; $b = Resolve-Long ${q(b)}`,
    'if ($null -eq $a -or $null -eq $b) { Write-Output \'UNKNOWN\' } elseif ($a -ieq $b) { Write-Output \'SAME\' } else { Write-Output \'DIFFERENT\' }',
  ].join('\n');
}

export function parseSameFileOutput(output: string): 'same' | 'different' | 'unknown' {
  const last = lines(output).pop() ?? '';
  if (last === 'SAME') return 'same';
  if (last === 'DIFFERENT') return 'different';
  if (last === 'UNKNOWN') return 'unknown';
  throw unreadable(output);
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

export interface MisaoHubInput {
  /** The misao folder to remove. */
  root: string;
  /** The folder of the misao the hub registered as `AzitoHub` keeps, when there is such a task; compared with `root` on the host. */
  hubRoot: string | undefined;
  /** No `AzitoHub` task: look for a hub process instead. */
  looksForHub: boolean;
}

/**
 * Before the misao of `root` is touched, on the host: whether the hub's folder is this folder (`SAMEHUB`; `MAYBEHUB` when the hub's folder
 * cannot be resolved, so the two may be the same), and whether a hub runs without the `AzitoHub` task (`HUB <pid>`). A process whose owner
 * cannot be read is `UNKNOWN <pid>`: not mine and not someone else's, so it is never taken as "not mine". Otherwise `CLEAR`. The misao
 * daemons themselves are looked at by {@link misaoDaemonScript}.
 */
export function misaoHubScript(input: MisaoHubInput): string {
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
      // A folder that is there but cannot be resolved (a link on the way, unreadable) may be the hub's; one that is not there has nothing to remove.
      'if ($null -eq $hub -or ($null -eq $here -and (Test-Path -LiteralPath $root))) { Write-Output \'MAYBEHUB\'; exit 0 }',
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
    'Write-Output \'CLEAR\'',
  ].join('\n');
}

/**
 * The misao daemons of the folder, looked for with the same "uses the folder" test as the leftover look (see `USES_FOLDER`): a `misao.exe`
 * that uses `root` and is the user's own must have been started by a task (one of its parents, up to four levels, is a `conhost.exe
 * --headless`, which is what every task of AZITO runs under), else `FOREIGN <pid>`; its owner not readable is `UNKNOWN <pid>`, and so is
 * a process of the user's own that can hold the folders of the install (see `USES_FOLDER`) and whose path or command line the host did not
 * give (it might be one). Otherwise `CLEAR`.
 */
export function misaoDaemonScript(root: string, home: string): string {
  const q = powershellDialect.quote;
  return [
    `$root = ${q(root)}; $tail = ${q(tailBelow(home, root))}`,
    ...USES_FOLDER,
    'function All { @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID }) }',
    'foreach ($d in @(All | Where-Object { $_.Name -eq \'misao.exe\' -and (Uses $_) })) {',
    '  $o = Owner $d',
    '  if ($o -eq \'unknown\') { Write-Output ("UNKNOWN " + $d.ProcessId); exit 0 }',
    '  if ($o -ne \'mine\') { continue }',
    '  $id = $d.ParentProcessId; $byTask = $false',
    '  for ($i = 0; $i -lt 4 -and $id; $i++) {',
    '    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $id"',
    '    if (-not $parent) { break }',
    '    if ($parent.Name -eq \'conhost.exe\' -and $parent.CommandLine -match \'--headless\') { $byTask = $true; break }',
    '    $id = $parent.ParentProcessId',
    '  }',
    '  if (-not $byTask) { Write-Output ("FOREIGN " + $d.ProcessId); exit 0 }',
    '}',
    'foreach ($b in @(All | Where-Object { (Blind $_) -and (Matters $_) -and (Owner $_) -eq \'mine\' })) { Write-Output ("UNKNOWN " + $b.ProcessId); exit 0 }',
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
